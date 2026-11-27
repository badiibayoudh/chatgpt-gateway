import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { monitorConfig } from "./config.mjs";
import { components, errors, eventData, eventLevel, outcomes, safeName, uuid } from "./events.mjs";
import { createLogStore } from "./log-store.mjs";

const MAX_ACTIVE = 2048;
const MAX_CALLS = 1000;
const MAX_TOOL_NAMES = 256;
const MAX_EVENT_BYTES = 4096;
const MAX_EXTENSION_EVENTS = 200;
const MAX_TOOL_AGE_MS = 60 * 60 * 1000;
const skip = () => {};

function boundedSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

export function createMonitor({ config, now = () => Date.now(), clock = () => performance.now(), logStore } = {}) {
  try {
    return config?.enabled === false ? disabled() : createEnabled(config ?? monitorConfig(), now, clock, logStore);
  } catch {
    // Invalid monitor configuration must not prevent chat traffic.
    return disabled();
  }
}

function disabled() {
  return { enabled: false, emit: skip, extension: skip, callsForwarded: skip, resultsObserved: skip, close: async () => {} };
}

function createEnabled(config, now, clock, logStore) {
  if (!config.enabled) return disabled();
  const log = logStore ?? createLogStore(config);
  const sessionId = randomUUID();
  const secret = randomBytes(32);
  const startedAt = now();
  const totals = { received: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0 };
  const health = { dropped: 0, evictedEvents: 0, evictedRequests: 0, rejectedExtensionEvents: 0 };
  const active = new Map();
  const completed = new Map();
  const events = new Map();
  const toolStats = new Map();
  const calls = new Map();
  const unmatched = new Map();
  let unmatchedCount = 0;
  let sequence = 0;
  let eventBytes = 0;
  let browser = null;
  let extensionRate = { at: clock(), count: 0 };
  let cpu = { at: clock(), usage: process.cpuUsage(), percent: null };

  const opaque = (value) => createHmac("sha256", secret).update(value).digest("hex").slice(0, 16);
  const guarded = (fn) => (...args) => {
    try { return fn(...args); } catch { health.dropped++; }
  };
  const toolName = (name) => safeName(name) ?? "redacted";
  const group = (name) => name.includes("__") ? { group: name.split("__")[0], inferred: true } : { group: "Unclassified", inferred: false };

  function emit(event, requestId = null, data = {}, component = "gateway", scope) {
    const clean = eventData(event, data);
    if (!clean || !components.includes(component) || (requestId !== null && !uuid.test(requestId))) {
      health.dropped++;
      return;
    }
    const timestamp = new Date(now()).toISOString();
    const tick = clock();
    if (event === "request.received") {
      if (active.has(requestId) || completed.has(requestId)) return;
      totals.received++;
      if (active.size >= MAX_ACTIVE) { health.dropped++; return; }
      active.set(requestId, { requestId, receivedAt: timestamp, state: "received", _received: tick, _extension: 0 });
    }
    const request = active.get(requestId) ?? completed.get(requestId);
    const postTerminal = event === "response.client_finished" || event === "response.client_disconnected";
    if (requestId !== null && (!request || (completed.has(requestId) && !postTerminal))) return;
    if (request && postTerminal && request.clientDelivery) return;
    if (scope && request) request.conversationId = opaque(scope);

    const entry = { schemaVersion: 1, eventId: `${sessionId}:${++sequence}`, sequence, timestamp,
      level: eventLevel(event), component, event, requestId, conversationId: request?.conversationId ?? null, data: clean };
    const line = `${JSON.stringify(entry)}\n`;
    const size = Buffer.byteLength(line);
    if (size > MAX_EVENT_BYTES) { health.dropped++; return; }
    if (request) updateRequest(request, entry, tick);
    if (event === "gateway.extension_disconnected" || event === "gateway.extension_connected") browser = null;
    if (["browser.tab_located", "browser.prompt_submitted", "browser.tab_unavailable"].includes(event)) {
      browser = { status: event === "browser.tab_unavailable" ? "unavailable" : event === "browser.tab_located" ? "tab located" : "ready", observedAt: timestamp, _at: tick };
    }
    if (event.startsWith("tool.") && clean.name) {
      const name = !toolStats.has(clean.name) && toolStats.size >= MAX_TOOL_NAMES - 1 ? "other" : clean.name;
      const stats = toolStats.get(name) ?? { name, ...group(name), exposed: 0, requested: 0, validated: 0,
        validation_failed: 0, forwarded: 0, result_received: 0 };
      stats[event.slice(5)]++;
      toolStats.set(name, stats);
    }
    events.set(sequence, { entry, size });
    eventBytes += size;
    while (events.size > config.events || eventBytes > config.eventBytes) {
      const oldest = events.keys().next().value;
      eventBytes -= events.get(oldest).size;
      events.delete(oldest);
      health.evictedEvents++;
    }
    log.offer(line);
  }

  function updateRequest(request, { event, data, timestamp, sequence }, tick) {
    request.firstSequence ??= sequence;
    request.lastSequence = sequence;
    switch (event) {
      case "request.received": Object.assign(request, data); break;
      case "request.input": Object.assign(request, data); break;
      case "request.queued": request.state = "queued"; request._queued = tick; break;
      case "request.dispatched":
        request.state = "dispatched"; request.dispatchedAt = timestamp; request._dispatch = tick;
        if (request._queued !== undefined) request.queueMs = tick - request._queued;
        break;
      case "browser.tab_located": case "browser.prompt_submitted":
        request.state = "processing";
        if (event === "browser.prompt_submitted") request._submitted = tick;
        break;
      case "browser.generation_detected": if (request._submitted !== undefined) request.generationStartMs = tick - request._submitted; break;
      case "browser.reply_relayed": if (request._dispatch !== undefined) request.browserMs = tick - request._dispatch; break;
      case "transport.started": request.state = "processing"; request._transportAt = tick; break;
      case "transport.finished": if (request._transportAt !== undefined) request.serviceMs = tick - request._transportAt; break;
      case "transport.usage": request.providerUsage = data; break;
      case "transport.transmitted": Object.assign(request, data); break;
      case "context.prepared": Object.assign(request, data); break;
      case "context.matched": case "context.reuse_missed": request.reuseReason = data.reason; break;
      case "context.reused": request.sameChatObserved = true; break;
      case "context.transmitted":
        request.forwardedTextBytes = (request.forwardedTextBytes ?? 0) + (data.forwardedTextBytes ?? 0);
        request.forwardedCharacters = (request.forwardedCharacters ?? 0) + (data.forwardedCharacters ?? 0);
        request.textAttachmentBytes = (request.textAttachmentBytes ?? 0) + (data.textAttachmentBytes ?? 0);
        break;
      case "attachment.prepared": request.images = data.images; request.imageBytes = data.bytes; break;
      case "attachment.attempted": case "attachment.accepted": case "attachment.failed": case "attachment.fallback": {
        const stage = event.slice(11);
        const key = stage === "fallback" ? "fallbacks" : `${data.kind} ${stage}`;
        request.attachments ??= {};
        request.attachments[key] = (request.attachments[key] ?? 0) + 1;
        break;
      }
      case "response.decoded": request._decoded = tick; break;
      case "response.client_finished": case "response.client_disconnected":
        request.clientDelivery = event.endsWith("finished") ? "finished" : "disconnected";
        if (request._decoded !== undefined) request.deliveryMs = tick - request._decoded;
        break;
    }
    const state = event.startsWith("request.") ? event.slice(8) : null;
    if (outcomes.includes(state)) {
      request.state = state;
      request.errorCode = data.code ?? null;
      if (data.estimatedOutputTokens !== undefined) request.estimatedOutputTokens = data.estimatedOutputTokens;
      request.finishedAt = timestamp;
      request.durationMs = tick - request._received;
      totals[state]++;
      active.delete(request.requestId);
      if (completed.size >= config.requests) health.evictedRequests++;
      boundedSet(completed, request.requestId, request, config.requests);
    }
  }

  const summary = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_"))
    .map(([key, value]) => [key, typeof value === "number" && key.endsWith("Ms") ? Math.round(value) : value]));
  const requestRows = () => [...completed.values(), ...active.values()].map(summary);
  const eventRows = () => [...events.values()].map(({ entry }) => entry);
  const retention = () => ({ historyComplete: health.evictedEvents === 0 && health.evictedRequests === 0 && health.dropped === 0,
    events: events.size, eventBytes, oldestSequence: events.keys().next().value ?? null, latestSequence: sequence, ...health, storage: log.snapshot() });

  return {
    enabled: true, config, sessionId, startedAt: new Date(startedAt).toISOString(),
    emit: guarded(emit),
    extension: guarded((requestId, batch) => {
      const row = active.get(requestId);
      if (!row || !Array.isArray(batch) || batch.length > 50) { health.rejectedExtensionEvents++; return; }
      const tick = clock();
      if (tick - extensionRate.at >= 1000) extensionRate = { at: tick, count: 0 };
      for (const item of batch) {
        const { event, component, data } = item ?? {};
        const clean = item?.requestId === requestId && Object.keys(item).every((key) => ["requestId", "event", "component", "data"].includes(key)) &&
          eventData(event, data, { strict: true, component });
        if (!clean || row._extension >= MAX_EXTENSION_EVENTS || extensionRate.count >= 120) { health.rejectedExtensionEvents++; continue; }
        row._extension++;
        extensionRate.count++;
        emit(event, requestId, clean, component);
      }
    }),
    callsForwarded: guarded((requestId, scope, entries) => {
      for (const { id, name } of entries.slice(0, 100)) {
        if (!/^call_[a-f0-9]{32}_\d{1,5}$/.test(id)) continue;
        const callId = opaque(id);
        const call = { callId, name: toolName(name), originRequestId: requestId, _scope: scope && opaque(scope), _at: clock() };
        boundedSet(calls, callId, call, MAX_CALLS);
        emit("tool.forwarded", requestId, { name: call.name, callId });
      }
    }),
    resultsObserved: guarded((requestId, scope, ids) => {
      let count = 0;
      for (const id of ids.slice(0, 200)) {
        if (typeof id !== "string" || id.length > 128) continue;
        const callId = opaque(id);
        const call = calls.get(callId);
        const now = clock();
        if (scope && call?._scope === opaque(scope) && now - call._at <= MAX_TOOL_AGE_MS) {
          if (call.resultRequestId) continue;
          call.resultRequestId = requestId;
          call.elapsedMs = Math.round(now - call._at);
          emit("tool.result_received", requestId, { name: call.name, callId, originRequestId: call.originRequestId, elapsedMs: call.elapsedMs });
        } else if (!unmatched.has(callId)) {
          boundedSet(unmatched, callId, true, MAX_CALLS);
          count++;
        }
      }
      if (count) { unmatchedCount += count; emit("tool.result_unmatched", requestId, { count }); }
    }),
    requestRows, eventRows, retention,
    tools: () => ({ items: [...toolStats.values()].map((row) => ({ ...row })),
      calls: [...calls.values()].slice(-200).reverse().map(summary), unmatchedResults: unmatchedCount }),
    status(core) {
      const now = clock();
      const usage = process.cpuUsage();
      const interval = now - cpu.at;
      if (interval >= 100) cpu = { at: now, usage, percent: Math.round(((usage.user + usage.system) - (cpu.usage.user + cpu.usage.system)) / interval / 10) / 10 };
      const latest = [...completed.values()].filter(({ state }) => state === "completed").slice(-100);
      const latencies = latest.map(({ durationMs }) => durationMs).sort((a, b) => a - b);
      const terminal = outcomes.reduce((sum, state) => sum + totals[state], 0);
      const memory = process.memoryUsage();
      return { ...core, uptimeSeconds: process.uptime(), browser: browser && now - browser._at <= 60000 ? summary(browser) : { status: "unknown" },
        totals: { ...totals }, terminal, successRate: terminal ? Math.round(10000 * totals.completed / terminal) / 100 : null,
        latency: { sample: latencies.length, window: 100, meanMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
          p95Ms: latencies.length ? Math.round(latencies[Math.ceil(latencies.length * .95) - 1]) : null },
        resources: { rssBytes: memory.rss, heapBytes: memory.heapUsed, cpuOneCorePercent: cpu.percent },
        recentFailures: [...completed.values()].filter(({ state }) => state === "failed" || state === "timed_out").slice(-5).reverse().map((row) =>
          ({ requestId: row.requestId, timestamp: row.finishedAt, code: row.errorCode, message: errors[row.errorCode] })), retention: retention() };
    },
    close: () => log.close(),
  };
}
