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

async function startGateway(t) {
  const server = fileURLToPath(new URL("../server.mjs", import.meta.url));
  const child = spawn(process.execPath, [server], { env: { ...process.env, PORT: "0" } });
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

  return {
    sent,
    chat(text, { signal, timeout = 5000 } = {}) {
      return fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: text }], timeout }),
        signal,
      });
    },
    async waitForPending(count) {
      await waitFor(async () => {
        const health = await (await fetch(base + "/health")).json();
        return health.pendingRequests === count;
      });
    },
    reply(index, content) {
      const { requestId } = sent[index];
      browser.send(JSON.stringify({ type: "response", requestId, ok: true, content }));
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
