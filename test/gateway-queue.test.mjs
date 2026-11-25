import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("Timed out waiting for the gateway state");
}

async function startGateway(t, apiKey = "") {
  const server = fileURLToPath(new URL("../server.mjs", import.meta.url));
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: "0", CHATGPT_GATEWAY_API_KEY: apiKey },
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Test gateway exited with code ${code}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/HTTP API:\s+http:\/\/localhost:(\d+)/);
      if (match) resolve(match[1]);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const browser = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => browser.terminate());
  await once(browser, "open");
  const sent = [];
  browser.on("message", (message) => sent.push(JSON.parse(message)));
  const send = (data) => browser.send(JSON.stringify(data));
  function request(path, options) { return fetch(base + path, options); }
  function complete(payload, options) {
    return request("/v1/chat/completions", {
      method: "POST",
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
      body: JSON.stringify(payload),
    });
  }

  return {
    base, sent, send, request, complete,
    chat(text, { signal, timeout = 5000 } = {}) {
      return complete({ messages: [{ role: "user", content: text }], timeout }, { signal });
    },
    async waitForPending(count) {
      await waitFor(async () => {
        const health = await (await fetch(base + "/health")).json();
        return health.pendingRequests === count;
      });
    },
    reply(index, content, conversation = {}) {
      const { requestId } = sent[index];
      send({ type: "response", requestId, ok: true, content, ...conversation });
    },
  };
}

async function assertReply(request, content) {
  const response = await request;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, content);
}

test("gives overlapping IDE requests separate browser turns", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const first = gateway.chat("First");
  await waitFor(() => gateway.sent.length === 1);
  const second = gateway.chat("Second");
  await gateway.waitForPending(2);
  assert.equal(gateway.sent.length, 1);
  gateway.reply(0, "First reply");
  await assertReply(first, "First reply");
  await waitFor(() => gateway.sent.length === 2);
  gateway.reply(1, "Second reply");
  await assertReply(second, "Second reply");
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

test("reuses the browser conversation for matching history and starts fresh for a new task", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const user = { role: "user", content: "Start the task\n" + "a".repeat(250_000) };
  const browser = { tabId: 7, url: "https://chatgpt.com/c/test-chat" };
  const first = gateway.complete({ messages: [user] });
  await waitFor(() => gateway.sent.length === 1);
  assert.equal(gateway.sent[0].continuation, undefined);
  assert.equal(gateway.sent[0].messages[0].content, user.content);
  gateway.reply(0, "First reply", browser);
  await assertReply(first, "First reply");

  const messages = [
    { ...user, content: [{ type: "text", text: user.content }] },
    { role: "assistant", content: "First reply" },
    { role: "user", content: "Continue the task" },
  ];
  const second = gateway.complete({ messages });
  await waitFor(() => gateway.sent.length === 2);
  assert.deepEqual(gateway.sent[1].continuation, {
    ...browser, messages: [messages.at(-1)], attachments: [],
  });
  assert.match(gateway.sent[1].messages[0].content, /Start the task/);
  gateway.reply(1, "Second reply", browser);
  await assertReply(second, "Second reply");

  const fresh = gateway.complete({ messages: [{ role: "user", content: "Unrelated task" }] });
  await waitFor(() => gateway.sent.length === 3);
  assert.equal(gateway.sent[2].continuation, undefined);
  assert.equal(gateway.sent[2].newConversation, true);
  gateway.reply(2, "Fresh reply");
  await assertReply(fresh, "Fresh reply");
});

test("round-trips a screenshot tool call, its MCP image result, and the final reply", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const messages = [{ role: "user", content: "Inspect the game screenshot" }];
  const tools = [{
    type: "function",
    function: { name: "mobile_screenshot", parameters: { type: "object", additionalProperties: false } },
  }];
  const first = gateway.complete({ messages, tools, stream: true });
  await waitFor(() => gateway.sent.length === 1);
  const { requestId } = gateway.sent[0];
  assert.equal(gateway.sent[0].streamText, false);
  const browser = { tabId: 7, url: "https://chatgpt.com/c/test-screenshot" };
  gateway.reply(0, JSON.stringify({
    gateway_request_id: requestId,
    tool_calls: [{ name: "mobile_screenshot", arguments: {} }],
  }), browser);
  const response = await first;
  assert.equal(response.status, 200);
  const [delta, finish] = (await response.text()).split("\n\n").map((frame) => frame.slice(6));
  const { index, ...call } = JSON.parse(delta).choices[0].delta.tool_calls[0];
  assert.equal(index, 0);
  assert.equal(call.function.name, "mobile_screenshot");
  assert.equal(JSON.parse(finish).choices[0].finish_reason, "tool_calls");
  const result = {
    role: "tool", tool_call_id: call.id,
    content: JSON.stringify({ content: [
      { type: "text", text: "Battlefield captured" },
      { type: "image", mimeType: "image/png", data: png },
    ] }),
  };
  const followUp = { messages: [...messages, { role: "assistant", tool_calls: [call] }, result], tools };
  const unsupported = await gateway.complete(followUp);
  assert.equal(unsupported.status, 503);
  assert.equal(gateway.sent.length, 1);
  gateway.send({ type: "hello", capabilities: ["imageAttachments"] });
  await waitFor(async () => (await (await gateway.request("/health")).json()).imageAttachments);
  const next = gateway.complete(followUp);
  await waitFor(() => gateway.sent.length === 2);
  const message = gateway.sent[1];
  assert.deepEqual(message.attachments, [{ name: "image-1.png", mimeType: "image/png", data: png }]);
  assert.ok(message.messages[0].content.includes(call.id));
  const transcript = JSON.parse(message.messages[0].content.split("Conversation (JSON):\n\n")[1]);
  assert.equal(transcript.at(-1).content, "Battlefield captured\n[Attached image: image-1.png]");
  assert.ok(!message.messages[0].content.includes(png));
  assert.equal(message.continuation.tabId, browser.tabId);
  const deltaTranscript = JSON.parse(message.continuation.messages[0].content.split("Conversation (JSON):\n\n")[1]);
  assert.deepEqual(deltaTranscript.map(({ role }) => role), ["assistant", "tool"]);
  assert.equal(deltaTranscript[0].tool_calls[0].id, call.id);
  assert.equal(message.continuation.attachments[0].data, png);
  gateway.reply(1, "Screenshot inspected");
  await assertReply(next, "Screenshot inspected");
});

test("streams plain text before completion without duplicating the result", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const pending = gateway.complete({ messages: [{ role: "user", content: "Stream a reply" }], stream: true });
  await waitFor(() => gateway.sent.length === 1);
  assert.equal(gateway.sent[0].streamText, true);
  gateway.send({ type: "progress", requestId: gateway.sent[0].requestId, content: "Starting" });
  const response = await pending;
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(JSON.parse(first.trim().slice(6)).choices[0].delta.content, "Starting");
  gateway.reply(0, "Starting now");
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  assert.equal(JSON.parse(rest.split("\n\n")[0].slice(6)).choices[0].delta.content, " now");
  assert.match(rest, /data: \[DONE\]/);
});

test("rejects untrusted origins and protects chat and metrics with the configured key", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t, "fixture-token");
  assert.equal((await gateway.request("/health")).status, 200);
  const foreign = await gateway.request("/health", { headers: { Origin: "https://example.org" } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("Access-Control-Allow-Origin"), null);
  const hostile = new WebSocket(gateway.base.replace("http:", "ws:") + "/ws", { origin: "https://example.org" });
  const [upgradeError] = await once(hostile, "error");
  assert.match(upgradeError.message, /403/);
  assert.equal((await gateway.complete({})).status, 401);
  assert.equal((await gateway.request("/metrics")).status, 401);
  const authorized = { headers: { Authorization: "Bearer fixture-token" } };
  const chat = gateway.complete({ messages: [{ role: "user", content: "Hello" }] }, authorized);
  await waitFor(() => gateway.sent.length === 1);
  gateway.reply(0, "Hi");
  await assertReply(chat, "Hi");
  const stats = await (await gateway.request("/metrics", authorized)).json();
  assert.equal(stats.accepted, 1);
  assert.equal(stats.completed, 1);
  assert.ok(stats.lastQueueWaitMs >= 0);
  assert.ok(stats.lastBrowserReplyMs >= 0);
});

test("holds the browser slot through client cancellation and skips expired queued requests", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const controller = new AbortController();
  const cancelled = assert.rejects(gateway.chat("Cancelled", { signal: controller.signal }), { name: "AbortError" });
  await waitFor(() => gateway.sent.length === 1);
  controller.abort();
  await cancelled;
  await gateway.waitForPending(0);

  const expired = await gateway.chat("Expired", { timeout: 100 });
  assert.equal(expired.status, 504);
  assert.match((await expired.json()).error, /available browser tab/);

  const next = gateway.chat("Still pending");
  await gateway.waitForPending(1);
  assert.equal(gateway.sent.length, 1);
  gateway.reply(0, "Late reply");
  await waitFor(() => gateway.sent.length === 2);
  assert.equal(gateway.sent[1].messages[0].content, "Still pending");
  gateway.reply(1, "Correct reply");
  await assertReply(next, "Correct reply");
});
