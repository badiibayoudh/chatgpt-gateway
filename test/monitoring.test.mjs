import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { monitorConfig } from "../monitoring/config.mjs";
import { createMonitor } from "../monitoring/index.mjs";
import { createLogStore } from "../monitoring/log-store.mjs";

const defaults = monitorConfig({});

test("monitor aggregates once, evicts bounded history, and never evicts an active request", () => {
  let tick = 0;
  const m = createMonitor({ config: { ...defaults, requests: 1, events: 5, eventBytes: 4096 }, now: () => tick, clock: () => tick });
  const queued = randomUUID();
  m.emit("request.received", queued);
  m.emit("request.queued", queued);
  for (const elapsed of [14, 35]) {
    const request = randomUUID();
    m.emit("request.received", request);
    m.emit("request.queued", request);
    tick += 7;
    m.emit("request.dispatched", request);
    tick += elapsed - 7;
    m.emit("request.completed", request);
    m.emit("request.failed", request, { code: "browser_error" });
    m.emit("response.client_finished", request);
    m.emit("response.client_finished", request);
  }
  const state = m.status({});
  assert.deepEqual(state.totals, { received: 3, completed: 2, failed: 0, cancelled: 0, timed_out: 0 });
  assert.deepEqual(state.latency, { sample: 1, window: 100, meanMs: 35, p95Ms: 35 });
  assert.equal(state.successRate, 100);
  assert.equal(m.requestRows().find((row) => row.requestId === queued).state, "queued");
  assert.equal(m.requestRows().find((row) => row.state === "completed").queueMs, 7);
  assert.equal(m.retention().historyComplete, false);
  assert.ok(m.retention().evictedEvents > 0);
  assert.equal(m.eventRows().length, 5);
});

test("allowlists extension fields, enforces rates, drops late events and marks browser observation stale", () => {
  let tick = 0;
  const m = createMonitor({ config: defaults, now: () => tick, clock: () => tick });
  const requestId = randomUUID();
  const envelope = { requestId, component: "content-script", event: "browser.prompt_submitted", data: {} };
  m.emit("request.received", requestId);
  m.emit("request.input", requestId, { model: "auto", prompt: "PRIVATE_PROMPT", incomingBytes: 42 });
  m.extension(requestId, [{ ...envelope, data: { prompt: "PRIVATE_BROWSER" } }, { ...envelope, url: "PRIVATE_URL" }, { ...envelope, requestId: randomUUID() }]);
  m.extension(requestId, Array(51).fill(envelope));
  m.extension(requestId, [envelope]);
  for (let i = 0; i < 3; i++) m.extension(requestId, Array(50).fill(envelope));
  assert.equal(m.eventRows().filter(({ event }) => event === "browser.prompt_submitted").length, 120);
  assert.equal(m.status({}).browser.status, "ready");
  tick += 60_001;
  assert.equal(m.status({}).browser.status, "unknown");
  m.emit("request.cancelled", requestId, { code: "client_disconnected" });
  m.extension(requestId, [envelope]);
  assert.equal(m.requestRows()[0].state, "cancelled");
  assert.ok(m.retention().rejectedExtensionEvents >= 36);
  assert.doesNotMatch(JSON.stringify(m.eventRows()), /PRIVATE/);
});

test("tool results require a scoped issued call and replay does not inflate counts", () => {
  const m = createMonitor({ config: defaults });
  const origin = randomUUID();
  const unrelated = randomUUID();
  const actual = randomUUID();
  const id = `call_${origin.replaceAll("-", "")}_0`;
  for (const request of [origin, unrelated, actual]) m.emit("request.received", request);
  m.callsForwarded(origin, "/c/private-browser-identifier", [{ id, name: "godot__get_godot_version" }]);
  m.resultsObserved(unrelated, "/c/different", [id, id]);
  m.resultsObserved(actual, "/c/private-browser-identifier", [id, id]);
  assert.equal(m.tools().calls[0].resultRequestId, actual);
  assert.equal(m.tools().items[0].result_received, 1);
  assert.equal(m.tools().unmatchedResults, 1);
  assert.doesNotMatch(JSON.stringify(m.tools()), /private-browser-identifier|call_/);
});

test("rotates sanitized JSONL under the byte cap and handles a storage permission error", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-monitor-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { ...defaults, persist: true, logDir: dir, logBytes: 4096, logFiles: 2 };
  const m = createMonitor({ config });
  for (let i = 0; i < 45; i++) {
    const id = randomUUID();
    m.emit("request.received", id);
    m.emit("request.failed", id, { code: "browser_error", prompt: "SECRET_PAYLOAD" });
  }
  await m.close();
  const files = await readdir(dir);
  assert.equal(files.length, 2);
  for (const file of files) {
    const path = join(dir, file);
    assert.ok((await stat(path)).size <= config.logBytes);
    const text = await readFile(path, "utf8");
    assert.doesNotMatch(text, /SECRET_PAYLOAD/);
    text.trim().split("\n").forEach((line) => assert.equal(JSON.parse(line).schemaVersion, 1));
  }
  const deny = createLogStore(config, { async mkdir() { throw Object.assign(new Error("PRIVATE_PATH"), { code: "EACCES" }); } });
  const faulty = createMonitor({ config, logStore: deny });
  assert.doesNotThrow(() => faulty.emit("gateway.started"));
  await faulty.close();
  assert.equal(faulty.retention().storage.errors, 1);
  assert.equal(faulty.retention().storage.dropped, 1);
  assert.doesNotMatch(JSON.stringify(faulty.retention()), /PRIVATE_PATH/);
});

test("disk write queue and shutdown are bounded", async () => {
  let release;
  const sink = createLogStore({ ...defaults, persist: true, writeQueue: 1 }, {
    mkdir: () => new Promise((resolve) => { release = resolve; }),
    lstat: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); },
    appendFile: async () => {},
  });
  sink.offer("{}\n");
  sink.offer("{}\n");
  await sink.close(5);
  assert.equal(sink.snapshot().incomplete, true);
  assert.equal(sink.snapshot().dropped, 1);
  release();
});
