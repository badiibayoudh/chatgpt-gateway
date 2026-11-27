import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { get as httpGet } from "node:http";
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

async function startGateway(t, apiKey = "", settings = {}) {
  const server = fileURLToPath(new URL("../server.mjs", import.meta.url));
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env, PORT: "0", CHATGPT_GATEWAY_API_KEY: apiKey,
      CHATGPT_GATEWAY_MAX_PROMPT_BYTES: "0", CHATGPT_GATEWAY_MAX_CONTEXT_TOKENS: "0",
      CHATGPT_GATEWAY_TEXT_ATTACHMENT_FALLBACK: "true", CHATGPT_GATEWAY_INCLUDE_HISTORICAL_IMAGES: "true",
      CHATGPT_GATEWAY_MONITOR_ENABLED: "true", CHATGPT_GATEWAY_MONITOR_PERSIST: "false",
      ...settings,
    },
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
  const sent = [];
  async function connectBrowser() {
    const connection = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    connection.on("message", (message) => sent.push(JSON.parse(message)));
    await once(connection, "open");
    return connection;
  }
  let browser = await connectBrowser();
  t.after(() => browser.terminate());
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
    async stop() {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
    async reconnectBrowser(capabilities) {
      const closed = once(browser, "close");
      browser.terminate();
      await closed;
      browser = await connectBrowser();
      send({ type: "hello", capabilities });
      await waitFor(async () => (await (await request("/health")).json()).conversationReuse);
    },
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

test("reports ChatGPT’s input-size rejection to the client", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const request = gateway.chat("Oversized message");
  await waitFor(() => gateway.sent.length === 1);
  gateway.reply(0, "", {
    ok: false, errorCode: "chatgpt_input_too_long", error: "ChatGPT rejected the submission as too long",
  });
  const response = await request;
  assert.equal(response.status, 413);
  const { error } = await response.json();
  assert.equal(error.code, "context_length_exceeded");
  assert.match(error.message, /ChatGPT rejected/);
});

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
  assert.equal(gateway.sent[1].newConversation, true); // A legacy full-history fallback must start a fresh browser chat.
  gateway.reply(1, "Second reply", browser);
  await assertReply(second, "Second reply");

  const fresh = gateway.complete({ messages: [{ role: "user", content: "Unrelated task" }] });
  await waitFor(() => gateway.sent.length === 3);
  assert.equal(gateway.sent[2].continuation, undefined);
  assert.equal(gateway.sent[2].newConversation, true);
  gateway.reply(2, "Fresh reply");
  await assertReply(fresh, "Fresh reply");
});

test("resumes a compacted Cline task and prepares only the new screenshot and tool result", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const capabilities = ["conversationReuse", "continuationOnly", "imageAttachments"];
  gateway.send({ type: "hello", capabilities });
  await waitFor(async () => (await (await gateway.request("/health")).json()).conversationReuse);
  const firstChat = { tabId: 7, url: "https://chatgpt.com/c/first" };
  const secondChat = { tabId: 7, url: "https://chatgpt.com/c/second" };
  const system = { role: "system", content: "System instructions supplied once" };
  const user = { role: "user", content: "Original task" };
  const tools = [{
    type: "function",
    function: { name: "read_file", description: "Original tool catalog", parameters: { type: "object" } },
  }];
  const first = gateway.complete({ messages: [system, user], tools });
  await waitFor(() => gateway.sent.length === 1);
  const { requestId } = gateway.sent[0];
  gateway.reply(0, JSON.stringify({
    gateway_request_id: requestId, tool_calls: [
      { name: "read_file", arguments: { path: "fixture.txt" } },
      { name: "read_file", arguments: { path: "second.txt" } },
    ],
  }), firstChat);
  const response = await first;
  assert.equal(response.status, 200);
  const assistant = (await response.json()).choices[0].message;

  const second = gateway.chat("Unrelated Cline task");
  await waitFor(() => gateway.sent.length === 2);
  assert.equal(gateway.sent[1].continuation, undefined);
  assert.equal(gateway.sent[1].newConversation, true);
  gateway.reply(1, "Second task reply", secondChat);
  await assertReply(second, "Second task reply");
  await gateway.reconnectBrowser(capabilities);

  const result = { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "Latest file contents" };
  const screenshot = { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] };
  const history = { role: "user", content: [
    { type: "text", text: "Older compacted history " + "z".repeat(250_000) },
    { type: "image_url", image_url: { url: "https://example.invalid/historical-image.png" } },
  ] };
  const splitCalls = assistant.tool_calls.map((call) => ({ ...assistant, tool_calls: [call] }));
  const messages = [system, history, ...splitCalls, result, screenshot];
  const resumed = gateway.complete({ messages, tools });
  await waitFor(() => gateway.sent.length === 3);
  const { continuation } = gateway.sent[2];
  assert.equal(continuation.url, firstChat.url);
  assert.equal(gateway.sent[2].messages, undefined);
  const prompt = continuation.messages[0].content;
  assert.match(prompt, /same client function definitions/);
  assert.doesNotMatch(prompt, /System instructions supplied once|Original tool catalog|Older compacted history/);
  const transcript = JSON.parse(prompt.split("Conversation (JSON):\n\n")[1]);
  const name = `image-${gateway.sent[2].requestId.slice(0, 8)}-1.png`;
  assert.deepEqual(transcript, [...splitCalls, result, { role: "user", content: `[Attached image: ${name}]` }]);
  assert.deepEqual(continuation.attachments, [{ name, mimeType: "image/png", data: png }]);
  gateway.reply(2, "First task resumed", firstChat);
  await assertReply(resumed, "First task resumed");

  const updatedSystem = { role: "system", content: "Updated system instructions" };
  const updatedTools = [{ ...tools[0], function: { ...tools[0].function, description: "Updated tool catalog" } }];
  const next = gateway.complete({ tools: updatedTools, messages: [
    updatedSystem, ...messages.slice(1), { role: "assistant", content: "First task resumed" },
    { role: "user", content: "New question for the first task" },
  ] });
  await waitFor(() => gateway.sent.length === 4);
  const updated = gateway.sent[3].continuation;
  assert.equal(updated.url, firstChat.url);
  assert.match(updated.messages[0].content, /Updated system instructions/);
  assert.match(updated.messages[0].content, /Updated tool catalog/);
  assert.deepEqual(updated.attachments, []);
  gateway.reply(3, "Follow-up reply", firstChat);
  await assertReply(next, "Follow-up reply");
  const stats = await (await gateway.request("/metrics")).json();
  assert.equal(stats.historyMatches.verified_tool_anchor, 1);
  assert.equal(stats.historyMatches.exact_history, 1);
  assert.equal(stats.continuationRequests, 2);
  assert.equal(stats.conversationReuseSuccessRate, 100);
  assert.equal(stats.toolDefinitionReuses, 1);
  assert.ok(stats.redundantDataAvoidedPercent > 0);
});

test("refuses to reuse either browser chat when two task histories match equally", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const user = { role: "user", content: "Repeated initial message" };
  for (const [index, url] of ["https://chatgpt.com/c/first", "https://chatgpt.com/c/second"].entries()) {
    const started = gateway.complete({ messages: [user], new_conversation: true });
    await waitFor(() => gateway.sent.length === index + 1);
    gateway.reply(index, "Repeated reply", { tabId: 7, url });
    await assertReply(started, "Repeated reply");
  }
  const next = gateway.complete({ new_conversation: false, messages: [
    user, { role: "assistant", content: "Repeated reply" }, { role: "user", content: "Which task?" },
  ] });
  await waitFor(() => gateway.sent.length === 3);
  assert.equal(gateway.sent[2].continuation, undefined);
  assert.equal(gateway.sent[2].newConversation, true);
  gateway.reply(2, "Fresh browser context");
  await assertReply(next, "Fresh browser context");
  assert.equal((await (await gateway.request("/metrics")).json()).historyMatches.ambiguous, 1);
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
  const pending = gateway.complete({ messages: [{ role: "user", content: "Stream a reply" }], stream: true,
    stream_options: { include_usage: true } });
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
  const usage = rest.split("\n\n").slice(0, 3).map((frame) => JSON.parse(frame.slice(6)))[2];
  assert.deepEqual(usage.choices, []);
  assert.ok(usage.usage.prompt_tokens > 0 && usage.usage.completion_tokens > 0);
  assert.equal(usage.usage.total_tokens, usage.usage.prompt_tokens + usage.usage.completion_tokens);
  assert.match(rest, /data: \[DONE\]/);
});

test("reports logical usage and actual UTF-8 browser transmission without exposing text", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  gateway.send({ type: "hello", capabilities: ["imageAttachments", "contextMetrics"] });
  await waitFor(async () => (await (await gateway.request("/health")).json()).imageAttachments);
  const text = "Résumé 🖼 fixture private marker <|endoftext|>";
  const payload = { messages: [{ role: "user", content: text }] };
  const body = JSON.stringify(payload);
  const pending = gateway.complete(payload);
  await waitFor(() => gateway.sent.length === 1);
  const { requestId } = gateway.sent[0];
  gateway.send({ type: "chat-transmission", requestId, promptCharacters: text.length,
    promptBytes: Buffer.byteLength(text), images: 1, textBytes: 0 });
  gateway.send({ type: "chat-transmission", requestId, promptCharacters: 9, promptBytes: 9,
    images: 0, textBytes: Buffer.byteLength(text), fallback: true });
  gateway.reply(0, "Resolved.");
  const { usage } = await (await pending).json();
  assert.ok(usage.prompt_tokens > 0 && usage.completion_tokens > 0);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
  const stats = await (await gateway.request("/metrics")).json();
  assert.equal(stats.incomingRequestCharacters, body.length);
  assert.equal(stats.incomingRequestBytes, Buffer.byteLength(body));
  assert.equal(stats.outgoingPromptBytes, Buffer.byteLength(text) + 9);
  assert.equal(stats.estimatedInputTokens, usage.prompt_tokens);
  assert.equal(stats.estimatedOutputTokens, usage.completion_tokens);
  assert.equal(stats.imageAttachmentCount, 1);
  assert.equal(stats.textAttachmentFallbackCount, 1);
  assert.equal(stats.oversizedRequestCount, 1);
  assert.equal(stats.fullHistoryRequests, 1);
  assert.ok(!JSON.stringify(stats).includes("fixture private marker"));
});

test("enforces browser byte and client token budgets before dispatch", { timeout: 10000 }, async (t) => {
  for (const [setting, reason] of [
    ["CHATGPT_GATEWAY_MAX_PROMPT_BYTES", /Browser prompt exceeds/],
    ["CHATGPT_GATEWAY_MAX_CONTEXT_TOKENS", /token budget/],
  ]) {
    const gateway = await startGateway(t, "", { [setting]: "10" });
    const response = await gateway.complete({ messages: [
      { role: "system", content: "This system instruction and the tool data must remain intact." },
      { role: "user", content: "Inspect an entire file." },
      { role: "tool", tool_call_id: "read", content: "A large current tool result.\n".repeat(200) },
    ] });
    assert.equal(response.status, 413);
    const { error } = await response.json();
    assert.equal(error.code, "context_length_exceeded");
    assert.match(error.message, reason);
    assert.equal(gateway.sent.length, 0);
    assert.equal((await (await gateway.request("/metrics")).json()).oversizedRequestCount, 1);
  }
  const gateway = await startGateway(t, "", { CHATGPT_GATEWAY_MAX_PROMPT_BYTES: "4" });
  const response = await gateway.complete({ messages: [{ role: "user", content: [
    { type: "text", text: "ééé" },
  ] }] });
  assert.equal(response.status, 413);
  assert.equal(gateway.sent.length, 0);
});

test("enforces disabled text fallback and reports platform upload allowance as 429", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t, "", { CHATGPT_GATEWAY_TEXT_ATTACHMENT_FALLBACK: "false" });
  assert.equal((await gateway.chat("Older extension")).status, 503);
  gateway.send({ type: "hello", capabilities: ["attachmentPolicy", "conversationReuse"] });
  await waitFor(async () => (await (await gateway.request("/health")).json()).conversationReuse);
  const pending = gateway.chat("Upload allowance fixture");
  await waitFor(() => gateway.sent.length === 1);
  assert.equal(gateway.sent[0].textAttachmentFallback, false);
  gateway.reply(0, "", { ok: false, errorCode: "chatgpt_upload_allowance", error: "Upload allowance reached" });
  const response = await pending;
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "upload_allowance_exceeded");
});

test("a gateway restart starts fresh when the browser chat identity is no longer tracked", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  const initial = { role: "user", content: "Earlier task" };
  const first = gateway.complete({ messages: [initial] });
  await waitFor(() => gateway.sent.length === 1);
  gateway.reply(0, "Earlier reply", { tabId: 7, url: "https://chatgpt.com/c/fixture" });
  await assertReply(first, "Earlier reply");
  await gateway.stop();
  const restarted = await startGateway(t);
  const next = restarted.complete({ new_conversation: false, messages: [
    initial, { role: "assistant", content: "Earlier reply" }, { role: "user", content: "Resume this task" },
  ] });
  await waitFor(() => restarted.sent.length === 1);
  assert.equal(restarted.sent[0].continuation, undefined);
  assert.equal(restarted.sent[0].newConversation, true);
  assert.match(restarted.sent[0].messages[0].content, /Earlier reply/);
  restarted.reply(0, "Resumed with supplied context");
  await assertReply(next, "Resumed with supplied context");
  assert.equal((await (await restarted.request("/metrics")).json()).historyMatches.no_tracked_chat, 1);
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

test("serves only known static monitor files and protects data, filters and exports", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t, "monitor-secret", { CHATGPT_GATEWAY_MONITOR_EXPORT_BYTES: "8192" });
  const headers = { Authorization: "Bearer monitor-secret" };
  const dashboard = await gateway.request("/dashboard");
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(dashboard.headers.get("x-content-type-options"), "nosniff");
  assert.match(await dashboard.text(), /Gateway Monitor/);
  for (const file of ["app.js", "views.js", "api.js", "styles.css"]) {
    assert.equal((await gateway.request(`/dashboard/assets/${file}`)).status, 200);
  }
  assert.equal((await gateway.request("/dashboard/assets/..%2f..%2fserver.mjs")).status, 404);
  assert.equal((await gateway.request("/monitor/status")).status, 401);
  assert.equal((await gateway.request("/monitor/status", { headers: { ...headers, Origin: "http://localhost:14" } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    httpGet(gateway.base + "/monitor/status", { headers: { ...headers, Host: "example.invalid" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await gateway.request("/monitor/status", { method: "POST", headers })).status, 405);
  for (const bad of ["limit=201", "limit=1&limit=2", "cursor=-1", "component=unknown", "from=invalid"]) {
    assert.equal((await gateway.request(`/monitor/logs?${bad}`, { headers })).status, 400);
  }
  const first = await (await gateway.request("/monitor/logs?limit=1", { headers })).json();
  assert.ok(first.nextCursor);
  const second = await (await gateway.request(`/monitor/logs?limit=1&cursor=${first.nextCursor}`, { headers })).json();
  assert.ok(second.items[0].sequence < first.items[0].sequence);
  const wrong = await gateway.complete({ messages: false }, { headers });
  assert.equal(wrong.status, 400);
  const { items } = await (await gateway.request("/monitor/requests?state=failed", { headers })).json();
  assert.equal(items[0].errorCode, "invalid_request");
  const bundle = await gateway.request(`/monitor/export?requestId=${items[0].requestId}&format=jsonl`, { headers });
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-disposition"), /gateway-monitor\.jsonl/);
  assert.equal(bundle.headers.get("cache-control"), "no-store");
  const raw = await bundle.text();
  assert.ok(Buffer.byteLength(raw) <= 8192);
  assert.doesNotMatch(raw, /monitor-secret|Authorization/);
  const lines = raw.trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].requests[0].requestId, items[0].requestId);
  assert.ok(lines.length > 1);
  assert.ok(lines.slice(1).every(({ requestId }) => requestId === items[0].requestId));
  const filtered = await gateway.request("/monitor/export?event=request.failed&code=invalid_request", { headers });
  assert.equal(filtered.status, 200);
  assert.match(filtered.headers.get("content-disposition"), /gateway-monitor\.json"/);
  const diagnostic = await filtered.json();
  assert.equal(diagnostic.events.length, 1);
  assert.equal(diagnostic.events[0].event, "request.failed");
  assert.equal(diagnostic.requests[0].requestId, items[0].requestId);
});

test("links sanitized browser and tool events across a live HTTP and WebSocket fixture", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t);
  gateway.send({ type: "hello", capabilities: ["conversationReuse", "imageAttachments", "continuationOnly", "contextMetrics", "telemetryV1"] });
  await waitFor(async () => (await (await gateway.request("/monitor/status")).json()).capabilities.includes("telemetryV1"));
  const user = { role: "user", content: "PRIVATE_INPUT source code 🖼\n" + "Earlier fixture output.\n".repeat(50) };
  const tools = [{ type: "function", function: { name: "godot__get_godot_version", parameters: { type: "object" } } }];
  const pending = gateway.complete({ messages: [user], tools, model: "PRIVATE_MODEL" });
  await waitFor(() => gateway.sent.length === 1);
  const { requestId, telemetry } = gateway.sent[0];
  assert.equal(telemetry, 1);
  const event = (name, data = {}) => ({ requestId, event: name, component: "content-script", data });
  gateway.send({ type: "telemetry", version: 99, requestId, events: [event("browser.prompt_submitted")] });
  gateway.send({ type: "telemetry", version: 1, requestId, events: [event("browser.prompt_submitted", { prompt: "PRIVATE_BROWSER" }),
    event("attachment.attempted", { kind: "image", bytes: 10 }), event("attachment.accepted", { kind: "image", bytes: 10 }),
    event("browser.prompt_submitted"), event("browser.generation_detected"), event("browser.response_received", { characters: 24 })] });
  const prompt = gateway.sent[0].messages[0].content;
  gateway.send({ type: "chat-transmission", requestId, promptCharacters: prompt.length, promptBytes: Buffer.byteLength(prompt),
    images: 0, textBytes: 0, fallback: false });
  const scope = { tabId: 91, url: "https://chatgpt.com/c/PRIVATE_BROWSER_URL" };
  gateway.reply(0, JSON.stringify({ gateway_request_id: requestId,
    tool_calls: [{ name: tools[0].function.name, arguments: { path: "PRIVATE_ARGUMENT" } }] }), scope);
  const first = (await (await pending).json()).choices[0].message;
  const result = { role: "tool", tool_call_id: first.tool_calls[0].id, content: "PRIVATE_RESULT" };
  const continuation = gateway.complete({ model: "PRIVATE_MODEL", messages: [user, first, result], tools });
  await waitFor(() => gateway.sent.length === 2);
  const next = gateway.sent[1];
  assert.equal(next.continuation.url, scope.url);
  const delta = next.continuation.messages[0].content;
  gateway.send({ type: "chat-transmission", requestId: next.requestId, promptCharacters: delta.length,
    promptBytes: Buffer.byteLength(delta), images: 0, textBytes: 0, fallback: false });
  gateway.reply(1, "PRIVATE_ASSISTANT", scope);
  await assertReply(continuation, "PRIVATE_ASSISTANT");
  const detail = await (await gateway.request(`/monitor/requests/${requestId}`)).json();
  assert.equal(detail.request.state, "completed");
  assert.equal(detail.request.fullTextBytes, Buffer.byteLength(prompt));
  assert.equal(detail.request.forwardedTextBytes, Buffer.byteLength(prompt));
  assert.ok(detail.timeline.some(({ event }) => event === "browser.generation_detected"));
  assert.ok(detail.timeline.some(({ event }) => event === "response.client_finished"));
  const context = await (await gateway.request("/monitor/conversations")).json();
  assert.equal(context.items[0].sameChatObserved, true);
  assert.ok(context.items[0].fullTextBytes > context.items[0].forwardedTextBytes);
  const observed = await (await gateway.request("/monitor/tools")).json();
  assert.equal(observed.items[0].result_received, 1);
  assert.equal(observed.calls[0].resultRequestId, next.requestId);
  const status = await (await gateway.request("/monitor/status")).json();
  assert.equal(status.totals.completed, 2);
  assert.equal(status.retention.rejectedExtensionEvents, 2);
  for (const url of ["/monitor/logs", "/monitor/status", "/monitor/requests", "/monitor/tools", "/monitor/export"]) {
    assert.doesNotMatch(await (await gateway.request(url)).text(), /PRIVATE_|call_[a-z0-9]{20,}|https:\/\/chatgpt.com/);
  }
});

test("disabled monitor leaves the existing API operational", { timeout: 10000 }, async (t) => {
  const gateway = await startGateway(t, "", { CHATGPT_GATEWAY_MONITOR_ENABLED: "false" });
  assert.equal((await gateway.request("/dashboard")).status, 404);
  assert.equal((await gateway.request("/monitor/status")).status, 404);
  assert.equal((await gateway.request("/health")).status, 200);
  gateway.send({ type: "hello", capabilities: ["telemetryV1"] });
  const pending = gateway.chat("No monitor");
  await waitFor(() => gateway.sent.length === 1);
  assert.equal(gateway.sent[0].telemetry, undefined);
  gateway.reply(0, "Normal response");
  await assertReply(pending, "Normal response");
});

test("interactive browser clients share one queue and keep identical histories in separate chats", { timeout: 10000 }, async (t) => {
  const admin = "scoped-browser-admin-fixture-0000";
  const gateway = await startGateway(t, admin, { CHATGPT_GATEWAY_REQUIRE_SCOPED_CLIENTS: "true" });
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const capabilities = async (token) => (await gateway.request("/v1/capabilities", { headers: token && auth(token) })).json();
  const register = async (clientId) => {
    const response = await gateway.request("/v1/sessions", { method: "POST", headers: { ...auth(admin), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, factoryRunId: "browser-fixture", role: "developer" }) });
    assert.equal(response.status, 201);
    return (await response.json()).token;
  };
  const [alice, bob] = await Promise.all([register("alice"), register("bob")]);
  const before = await capabilities(alice);
  assert.equal(before.authentication.credential, "worker");
  assert.equal(before.transport.capabilities.programmatic, true);
  assert.equal(before.transport.capabilities.interactive, true);
  assert.equal(before.transport.capabilities.unattended, false);
  assert.equal(before.transport.requestReady, false);
  assert.equal(before.transport.programmaticReady, false);
  assert.equal(before.clients.scopedAvailable, false);
  gateway.send({ type: "hello", capabilities: ["scopedConversations", "conversationReuse", "continuationOnly"] });
  await waitFor(async () => (await capabilities()).clients.scopedAvailable);
  const after = await capabilities(alice);
  assert.equal(after.transport.requestReady, true);
  assert.equal(after.transport.unattendedReady, false);
  assert.equal((await capabilities()).transport.requestReady, false);
  const user = { role: "user", content: "Identical prompt" };
  const start = (token, messages = [user], extra = {}) => gateway.complete({ messages, ...extra }, { headers: auth(token) });
  assert.equal((await start(admin)).status, 401);
  const first = start(alice);
  await waitFor(() => gateway.sent.length === 1);
  const second = start(bob);
  await gateway.waitForPending(2);
  assert.equal(gateway.sent.length, 1);
  assert.equal(gateway.sent[0].scopedConversation, true);
  const foreignCancel = await gateway.request(`/v1/requests/${gateway.sent[0].requestId}`, { method: "DELETE", headers: auth(bob) });
  assert.deepEqual(await foreignCancel.json(), { cancelled: false });
  assert.equal((await start(alice)).status, 409);
  gateway.reply(0, "Identical reply", { tabId: 7, url: "https://chatgpt.com/c/fixture-alice" });
  await assertReply(first, "Identical reply");
  await waitFor(() => gateway.sent.length === 2);
  assert.equal(gateway.sent[1].newConversation, true);
  assert.equal(gateway.sent[1].continuation, undefined);
  gateway.reply(1, "Identical reply", { tabId: 7, url: "https://chatgpt.com/c/fixture-bob" });
  await assertReply(second, "Identical reply");

  const transcript = [user, { role: "assistant", content: "Identical reply" }, { role: "user", content: "Follow up" }];
  const aliceNext = start(alice, transcript, { stream: true });
  await waitFor(() => gateway.sent.length === 3);
  assert.equal(gateway.sent[2].continuation.url, "https://chatgpt.com/c/fixture-alice");
  assert.equal(gateway.sent[2].streamText, false);
  // Even an extension response reporting another client's URL is refused before content delivery.
  gateway.reply(2, "Text from the wrong chat", { tabId: 7, url: "https://chatgpt.com/c/fixture-bob" });
  const conflict = await aliceNext;
  assert.equal(conflict.status, 502);
  assert.equal((await conflict.json()).error.code, "conversation_conflict");
  const bobNext = start(bob, transcript);
  await waitFor(() => gateway.sent.length === 4);
  assert.equal(gateway.sent[3].continuation.url, "https://chatgpt.com/c/fixture-bob");
  gateway.reply(3, "Bob only", { tabId: 7, url: "https://chatgpt.com/c/fixture-bob" });
  await assertReply(bobNext, "Bob only");
  const status = await (await gateway.request("/monitor/status", { headers: auth(admin) })).json();
  assert.equal(status.health.gateway.programmatic, true);
  assert.equal(status.health.gateway.unattended, false);
  assert.equal(status.metrics.maxObservedActive, 1);
  const exported = await (await gateway.request("/monitor/export", { headers: auth(admin) })).text();
  assert.doesNotMatch(exported, /Identical prompt|Text from the wrong chat|fixture-alice|fixture-bob/);
});

test("interactive tool results require a call issued to the authenticated session", { timeout: 10000 }, async (t) => {
  const admin = "scoped-tool-admin-fixture-000000";
  const token = (name) => `scoped-tool-worker-${name}-000000`;
  const profiles = ["a", "b"].map((clientId) => ({ clientId, sessionId: "session", factoryRunId: "round-trip", role: "developer", token: token(clientId) }));
  const gateway = await startGateway(t, admin, { CHATGPT_GATEWAY_CLIENTS: JSON.stringify(profiles) });
  gateway.send({ type: "hello", capabilities: ["scopedConversations", "conversationReuse", "continuationOnly"] });
  await waitFor(async () => (await (await gateway.request("/v1/capabilities")).json()).clients.scopedAvailable);
  const call = (worker, messages) => gateway.complete({ messages, tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }] },
    { headers: { Authorization: `Bearer ${token(worker)}` } });
  const user = { role: "user", content: "Inspect fixture" };
  const first = call("a", [user]);
  await waitFor(() => gateway.sent.length === 1);
  gateway.reply(0, JSON.stringify({ gateway_request_id: gateway.sent[0].requestId, tool_calls: [{ name: "inspect", arguments: {} }] }),
    { tabId: 8, url: "https://chatgpt.com/c/fixture-tool-a" });
  const assistant = (await (await first).json()).choices[0].message;
  const result = { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "Tool fixture" };
  const foreign = await call("b", [user, assistant, result]);
  assert.equal(foreign.status, 409);
  assert.equal((await foreign.json()).error.code, "session_reset");
  assert.equal(gateway.sent.length, 1);
  const own = call("a", [user, assistant, result]);
  await waitFor(() => gateway.sent.length === 2);
  assert.equal(gateway.sent[1].continuation.url, "https://chatgpt.com/c/fixture-tool-a");
  gateway.reply(1, "Inspected", { tabId: 8, url: "https://chatgpt.com/c/fixture-tool-a" });
  await assertReply(own, "Inspected");
});
