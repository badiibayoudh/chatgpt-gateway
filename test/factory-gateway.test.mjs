import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayConfig } from "../communication/config.mjs";
import { createWorkerRegistry } from "../communication/sessions.mjs";
import { openAiTransport } from "../communication/programmatic-transports.mjs";

const adminKey = "factory-admin-fixture-00000000";
const profiles = ["one", "two", "three"].map((key) => ({ token: `factory-worker-fixture-${key}-0000`,
  clientId: `fixture-${key}`, sessionId: "shared-session-name", factoryRunId: "fixture-private-run-name", role: "developer" }));
const fixtureEnv = { CHATGPT_GATEWAY_FACTORY_TRANSPORT: "mock", CHATGPT_GATEWAY_API_KEY: adminKey,
  CHATGPT_GATEWAY_FACTORY_CLIENTS: JSON.stringify(profiles) };
const user = (content = "identical fixture prompt") => ({ role: "user", content });
const tools = [{ type: "function", function: { name: "read_fixture", parameters: { type: "object", additionalProperties: false } } }];

async function start(t, env = {}) {
  const child = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, ...fixtureEnv, PORT: "0",
    CHATGPT_GATEWAY_MAX_CONTEXT_TOKENS: "0", CHATGPT_GATEWAY_MONITOR_ENABLED: "true", CHATGPT_GATEWAY_MONITOR_PERSIST: "false", ...env } });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };
  t.after(stop);
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Factory test gateway exited with ${code}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/HTTP API:\s+http:\/\/localhost:(\d+)/);
      if (match) resolve(match[1]);
    });
  });
  const call = (path, token, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: {
    ...(token && { Authorization: `Bearer ${token}` }), ...options.headers } });
  const complete = (index, messages, rest = {}, options = {}) => call("/v1/chat/completions", profiles[index]?.token, {
    ...options, method: "POST", headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify({ model: "factory-mock", messages, ...rest }),
  });
  const read = async (path) => (await call(path, adminKey)).json();
  return { complete, call, read, stop };
}

async function waitFor(fn) {
  for (let i = 0; i < 50; i++) {
    const result = await fn();
    if (result) return result;
    await delay(10);
  }
  assert.fail("Factory fixture condition did not occur");
}

test("scoped workers with identical prompts and tools receive distinct calls and isolated results", { timeout: 10000 }, async (t) => {
  const gateway = await start(t);
  const responses = await Promise.all([0, 1].map((index) => gateway.complete(index, [user()], { tools })));
  const ids = responses.map((response) => response.headers.get("x-request-id"));
  const choices = await Promise.all(responses.map(async (response) => {
    assert.equal(response.status, 200);
    return (await response.json()).choices[0];
  }));
  const results = choices.map(({ message }, index) => [user(), message,
    { role: "tool", tool_call_id: message.tool_calls[0].id, content: `fixture private result ${index}` }]);
  assert.notEqual(results[0][2].tool_call_id, results[1][2].tool_call_id);
  assert.equal((await gateway.complete(1, results[0], { tools })).status, 409);
  assert.equal((await gateway.complete(0, [...results[0], ...results[0].slice(1)], { tools })).status, 409);
  const own = await Promise.all([0, 1].map((index) => gateway.complete(index, results[index], { tools })));
  for (const reply of own) {
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).choices[0].message.content, `Mock reply ${reply.headers.get("x-request-id")}`);
  }
  const changed = [user(), results[0][1], { ...results[0][2], content: "changed result" }];
  assert.equal((await gateway.complete(0, changed, { tools })).status, 409);
  assert.equal((await gateway.complete(0, results[0], { tools })).status, 200);
  const { calls } = await gateway.read("/monitor/tools");
  assert.deepEqual(calls.map((row) => row.originRequestId).sort(), ids.sort());
  assert.ok(calls.every(({ resultRequestId }) => resultRequestId));
  const stats = await gateway.read("/metrics");
  assert.equal(stats.maxObservedActive, 1);
  assert.equal(stats.activeSlots, 0);
  const requests = await gateway.read("/monitor/requests");
  assert.equal(new Set(requests.items.map(({ conversationId }) => conversationId)).size, 2);
  assert.equal(new Set(requests.items.map(({ runTag }) => runTag)).size, 1);
  const json = JSON.stringify(await gateway.read("/monitor/export"));
  assert.doesNotMatch(json, /fixture private result|fixture-private-run-name|identical fixture prompt|factory-worker-fixture/);
});

test("one execution slot, scoped cancellation, admission and drain after active cancellation", { timeout: 10000 }, async (t) => {
  const gateway = await start(t, { CHATGPT_GATEWAY_FACTORY_MAX_QUEUED: "1" });
  const slow = gateway.complete(0, [user("fixture:slow")]);
  const active = await waitFor(async () => (await gateway.read("/monitor/status")).activeRequestId);
  assert.equal((await gateway.complete(0, [user()])).status, 409);
  const queued = gateway.complete(1, [user()]);
  const request = await waitFor(async () => (await gateway.read("/monitor/requests?state=queued")).items[0]);
  const overflow = await gateway.complete(2, [user()]);
  assert.equal(overflow.status, 429);
  assert.equal(overflow.headers.get("retry-after"), "2");
  async function cancel(id, index) {
    return (await (await gateway.call(`/v1/requests/${id}`, profiles[index].token, { method: "DELETE" })).json()).cancelled;
  }
  assert.equal(await cancel(request.requestId, 0), false);
  assert.equal(await cancel(request.requestId, 1), true);
  assert.equal((await queued).status, 409);
  assert.equal(await cancel(active, 0), true);
  assert.equal(await cancel(active, 0), false);
  assert.equal((await slow).status, 409);
  assert.equal((await gateway.read("/metrics")).activeSlots, 1);
  const next = await gateway.complete(2, [user()]);
  assert.equal(next.status, 200);
  assert.equal((await next.json()).choices[0].message.content, `Mock reply ${next.headers.get("x-request-id")}`);
  const factory = await gateway.read("/metrics");
  assert.equal(factory.cancelled, 2);
  assert.equal(factory.maxObservedActive, 1);
  assert.equal(factory.retainedBytes, 0);
});

test("queue and processing deadlines release only settled jobs and bridge client disconnect", { timeout: 10000 }, async (t) => {
  const gateway = await start(t, { CHATGPT_GATEWAY_FACTORY_QUEUE_MS: "90", CHATGPT_GATEWAY_FACTORY_PROCESS_MS: "180" });
  const slow = gateway.complete(0, [user("fixture:slow")]);
  await waitFor(async () => (await gateway.read("/metrics")).activeSlots);
  const response = await gateway.complete(1, [user()]);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "queue_timeout");
  const processed = await slow;
  assert.equal((await processed.json()).error.code, "processing_timeout");
  assert.equal((await gateway.read("/metrics")).activeSlots, 1);
  await waitFor(async () => !(await gateway.read("/metrics")).activeSlots);
  const controller = new AbortController();
  const aborted = assert.rejects(gateway.complete(0, [user("fixture:slow")], {}, { signal: controller.signal }), /abort/i);
  await waitFor(async () => (await gateway.read("/metrics")).activeSlots);
  controller.abort();
  await aborted;
  await waitFor(async () => (await gateway.read("/metrics")).cancelled === 1);
  assert.equal((await gateway.read("/metrics")).activeSlots, 1);
  await waitFor(async () => !(await gateway.read("/metrics")).activeSlots);
  assert.equal((await gateway.complete(1, [user()])).status, 200);
});

test("factory streaming, restart reset, authorization, and provider errors", { timeout: 10000 }, async (t) => {
  const first = await start(t);
  assert.equal((await first.complete(-1, [user()])).status, 401);
  assert.equal((await first.call("/monitor/status", profiles[0].token)).status, 401);
  assert.equal((await first.complete(0, [user()], {}, { headers: { "X-Gateway-Session-Id": "foreign" } })).status, 403);
  const sse = await first.complete(0, [user()], { stream: true, stream_options: { include_usage: true } });
  const stream = await sse.text();
  assert.match(stream, /Mock reply /);
  assert.match(stream, /"total_tokens":15/);
  assert.match(stream, /data: \[DONE\]\n\n$/);
  const rate = await first.complete(0, [user("fixture:rate-limit")]);
  assert.equal(rate.status, 429);
  assert.equal(rate.headers.get("retry-after"), "3");
  assert.equal((await first.complete(0, [user("fixture:fail")])).status, 502);
  const asst = (await (await first.complete(0, [user()], { tools })).json()).choices[0].message;
  await first.stop();
  const restarted = await start(t);
  const stale = await restarted.complete(0, [user(), asst, { role: "tool", content: "{}", tool_call_id: asst.tool_calls[0].id }], { tools });
  assert.equal((await stale.json()).error.code, "session_reset");
  assert.equal((await restarted.complete(0, [user()])).status, 200);
  const uncertain = await restarted.complete(0, [user("fixture:uncertain")]);
  assert.equal((await uncertain.json()).error.code, "upstream_uncertain");
  assert.equal((await restarted.complete(1, [user()])).status, 503);
  assert.equal((await (await restarted.call("/health")).json()).gateway.availability, "blocked");
});

test("programmatic adapter retains native schemas, usage and SSE without contacting a provider", async () => {
  assert.throws(() => gatewayConfig({ ...fixtureEnv, CHATGPT_GATEWAY_FACTORY_CLIENTS: JSON.stringify([profiles[0], profiles[0]]) }), /Duplicate/);
  const progress = [];
  const transmitted = [];
  const mockedFetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.deepEqual(JSON.parse(options.body), { model: "fixture-model", stream: true, tools, store: false });
    return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n');
  };
  const adapter = openAiTransport({ upstreamKey: "fixture", drainMs: 100 }, mockedFetch);
  assert.equal(adapter.availability().state, "unverified");
  const result = await adapter.complete({ model: "fixture-model", stream: true, tools }, {
    progress: (text) => progress.push(text), transmitted: (...bytes) => transmitted.push(bytes),
  });
  assert.deepEqual(progress, ["hello"]);
  assert.equal(result.usage.total_tokens, 3);
  assert.equal(adapter.availability().state, "verified");
  assert.ok(transmitted[0][0] > 0);
  const interrupted = openAiTransport({ upstreamKey: "fixture", drainMs: 100 }, async () => new Response('data: {"choices":[]}\n\n'));
  await assert.rejects(interrupted.complete({ stream: true }, { progress() {}, transmitted() {} }), { code: "upstream_uncertain" });
});

test("programmatic slot checkpoint survives an uncertain outcome and prevents reuse after restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "gateway-provider-checkpoint-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const config = { stateDir, upstreamKey: "fixture", drainMs: 100 };
  const options = { requestId: "fixture-request-id", transmitted() {}, progress() {} };
  const confirmed = openAiTransport(config, async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })));
  assert.equal((await confirmed.complete({}, options)).message.content, "ok");
  assert.equal(confirmed.ready(), true);
  const interrupted = openAiTransport(config, async () => { throw new Error("fixture network interruption"); });
  await assert.rejects(interrupted.complete({}, options), { code: "upstream_uncertain" });
  const saved = JSON.parse(await readFile(join(stateDir, "upstream-in-flight.json"), "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["requestId", "startedAt"]);
  assert.equal(openAiTransport(config).ready(), false);
  await assert.rejects(confirmed.complete({}, options), { code: "upstream_uncertain" });
});

test("administrator provisions, lists and revokes bounded worker sessions without restarting", { timeout: 10000 }, async (t) => {
  const gateway = await start(t, { CHATGPT_GATEWAY_FACTORY_CLIENTS: "[]", CHATGPT_GATEWAY_FACTORY_MAX_SESSIONS: "2" });
  const sessions = "/v1/factory/sessions";
  const request = { clientId: "dedicated-worker", factoryRunId: "issue-pilot", role: "developer" };
  const issue = (key = adminKey, body = request, headers = {}) => gateway.call(sessions, key, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const chat = (token, content = "fixture:hello") => gateway.call("/v1/chat/completions", token, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "factory-mock", messages: [user(content)] }),
  });
  assert.equal((await issue(profiles[0].token)).status, 401);
  assert.equal((await issue(adminKey, { ...request, sessionId: "claimed-by-client" })).status, 400);
  assert.equal((await issue(adminKey, request, { Origin: "http://localhost:1" })).status, 403);
  const issued1 = await issue();
  const issued2 = await issue(adminKey, { ...request, role: "reviewer" });
  assert.equal(issued1.status, 201);
  assert.equal(issued2.status, 201);
  assert.equal(issued1.headers.get("cache-control"), "no-store");
  const first = await issued1.json();
  const second = await issued2.json();
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(first.runTag, second.runTag);
  assert.equal((await issue()).status, 429);
  assert.equal((await issue(first.token)).status, 401);
  const listing = await gateway.read(sessions);
  assert.deepEqual(listing.items.map(({ sessionId }) => sessionId), [first.sessionId, second.sessionId]);
  assert.ok(listing.items.every((item) => !Object.hasOwn(item, "token")));
  assert.equal((await chat(adminKey)).status, 401);
  const slow = chat(first.token, "fixture:slow");
  await waitFor(async () => (await gateway.read("/metrics")).activeSlots);
  const revoke = (id, token) => gateway.call(`${sessions}/${id}`, token, { method: "DELETE" });
  assert.equal((await revoke(first.sessionId, second.token)).status, 401);
  assert.equal((await (await revoke(first.sessionId, adminKey)).json()).revoked, true);
  assert.equal((await (await revoke(first.sessionId, adminKey)).json()).revoked, false);
  assert.equal((await (await slow).json()).error.code, "session_revoked");
  assert.equal((await chat(first.token)).status, 401);
  assert.equal((await gateway.read("/metrics")).activeSlots, 1);
  assert.equal((await issue()).status, 429);
  const other = await chat(second.token);
  assert.equal(other.status, 200);
  assert.equal((await issue()).status, 201);
  const exported = JSON.stringify(await gateway.read("/monitor/export"));
  assert.ok(!exported.includes(first.token) && !exported.includes(second.token) && !exported.includes(request.factoryRunId));
});

test("an expired session rejects credentials while its in-flight slot keeps the lease", () => {
  const config = gatewayConfig({ ...fixtureEnv, CHATGPT_GATEWAY_FACTORY_CLIENTS: "[]", CHATGPT_GATEWAY_FACTORY_MAX_SESSIONS: "1" });
  const busy = new Set();
  let clock = 0;
  const registry = createWorkerRegistry(config, busy, () => clock);
  const request = { clientId: "worker", factoryRunId: "run", role: "developer" };
  const lease = registry.register(request);
  const auth = `Bearer ${lease.token}`;
  const { scope } = registry.lookup(auth);
  busy.add(scope);
  clock = config.sessionMs;
  assert.equal(registry.lookup(auth), undefined);
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.register(request), { code: "session_capacity" });
  busy.delete(scope);
  assert.notEqual(registry.register(request).sessionId, lease.sessionId);
});
