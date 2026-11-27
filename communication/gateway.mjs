import { randomUUID } from "node:crypto";
import { chatMessages } from "../chat-tools.mjs";
import { toolCallKeys } from "../chat-history.mjs";
import { clientContext, estimateTokens } from "../context.mjs";
import { errors, safeModel, safeName, uuid } from "../monitoring/events.mjs";
import { apiKeyMatches } from "./config.mjs";
import { checkResultHistory, GatewayError, readBody, validateOutput } from "./protocol.mjs";
import { createWorkerRegistry } from "./sessions.mjs";

const reserveLimit = 32 * 1024 * 1024;
const error = (status, code, message, opts) => new GatewayError(status, code, message, opts);
const offline = () => error(503, "upstream_uncertain", "Gateway dispatch is paused because upstream completion could not be confirmed. Reconcile before restarting.");
const unauthorized = () => error(401, "unauthorized", "Use an authorized Gateway bearer key.");
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const paths = ["/v1/sessions", "/v1/factory/sessions"];
const monitorCode = (code) => ({
  context_length_exceeded: "context_length", upload_allowance_exceeded: "upload_allowance",
})[code] ?? (Object.hasOwn(errors, code) ? code : "invalid_response");

export function writeJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

export function reject(res, failure, legacy = false) {
  if (res.destroyed || res.writableEnded) return;
  const { status, code, message, legacyType, retryAfter } = failure;
  const typed = { code, type: code, message };
  const detail = { error: legacy ? legacyType ? { message, type: legacyType,
    ...(["context_length_exceeded", "upload_allowance_exceeded"].includes(legacyType) && { code: legacyType }) } : message : typed };
  if (res.headersSent) res.end(frame({ error: typeof detail.error === "string" ? { ...typed, type: "gateway_error" } : detail.error }));
  else {
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
    writeJson(res, status, detail);
  }
}

function output(res, payload, requestId, defaultModel) {
  const base = { id: `chatcmpl-${requestId}`, model: payload.model || defaultModel, created: Math.floor(Date.now() / 1000) };
  const chunk = (choices, usage = null) => ({ ...base, object: "chat.completion.chunk", choices,
    ...(payload.stream_options?.include_usage === true && { usage }) });
  let streamed = "";
  const start = () => {
    if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
  };
  const deltaFrame = (delta) => frame(chunk([{ index: 0, delta, finish_reason: null }]));
  return {
    progress(text) {
      if (payload.stream !== true || !text || res.destroyed || res.writableEnded) return;
      start();
      res.write(deltaFrame({ ...(!streamed && { role: "assistant" }), content: text }));
      streamed += text;
    },
    finish(message, reason, usage) {
      if (payload.stream !== true) {
        writeJson(res, 200, { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: reason }], usage });
        return;
      }
      start();
      const tail = streamed && message.content?.startsWith(streamed) ? message.content.slice(streamed.length) : "";
      const delta = streamed ? { ...(tail && { content: tail }), ...(message.refusal && { refusal: message.refusal }) } : { ...message };
      if (message.tool_calls) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }));
      if (Object.keys(delta).length) res.write(deltaFrame(delta));
      res.write(frame(chunk([{ index: 0, delta: {}, finish_reason: reason }])));
      if (payload.stream_options?.include_usage === true) res.write(frame(chunk([], usage)));
      res.end("data: [DONE]\n\n");
    },
  };
}

export function createGateway(config, settings, monitor, transport) {
  if (transport.capabilities.concurrency !== 1) throw new Error("Gateway adapters currently use one execution slot");
  const waiting = new Map();
  const retained = new Map();
  const busy = new Set();
  const workers = createWorkerRegistry(config, busy);
  const legacy = { clientId: "legacy", scope: `legacy/${config.epoch}`, legacy: true };
  let retainedBytes = 0;
  let active;
  let paused = transport.blocked === true;
  const totals = { accepted: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0, overloaded: 0, maxObservedActive: 0,
    incomingRequestBytes: 0, incomingRequestCharacters: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0,
    oversizedRequestCount: 0, lastQueueWaitMs: null };
  const admin = (req) => apiKeyMatches(config.admin, req.headers.authorization);
  const monitorAllowed = (header) => !config.admin || apiKeyMatches(config.admin, header);

  function release(entry) {
    clearTimeout(entry.timer);
    waiting.delete(entry.id);
    if (!retained.delete(entry.id)) return;
    retainedBytes -= entry.bytes;
    if (!entry.worker.legacy) busy.delete(entry.worker.scope);
  }

  function terminal(entry, state, failure, data = {}) {
    if (entry.terminal) return;
    entry.terminal = true;
    totals[state === "timed_out" ? "timedOut" : state]++;
    const code = failure && monitorCode(failure.code);
    if (code === "context_length" && !failure.recorded) totals.oversizedRequestCount++;
    monitor.emit(`request.${state}`, entry.id, failure ? { code } : data, "gateway", entry.monitorScope);
    if (failure) reject(entry.res, failure, entry.worker.legacy);
    if (active !== entry && !entry.reading) release(entry);
  }

  async function run(entry) {
    const { res, id, worker, prepared, context } = entry;
    const { payload, selection } = prepared;
    const observe = (event, name) => monitor.emit(event, id, { name: safeName(name) ?? "redacted" });
    try {
      let history = worker.history;
      if (!worker.legacy) {
        if (!history || history.expires <= Date.now()) history = worker.history = { calls: new Map() };
        history.expires = Date.now() + config.sessionMs;
        const checked = checkResultHistory(payload.messages ?? [], history, { allowPending: transport.legacyInteractive });
        for (const [call, result] of checked) history.calls.get(call).result = result;
        monitor.resultsObserved(id, worker.scope, checked.map(([call]) => call));
      }
      if (selection) {
        for (const definition of selection.functions) observe("tool.exposed", definition.name);
        monitor.emit("context.prepared", id, { mode: "full", forwardedMessages: payload.messages.length, exposedTools: selection.functions.length, toolsReused: false });
      }
      if (!transport.legacyInteractive) monitor.emit("transport.started", id);
      const client = output(res, payload, id, transport.legacyInteractive ? "chatgpt-web" : transport.models[0]);
      const result = await transport.complete(payload, { requestId: id, worker, context, connection: entry.connection,
        transmitted: (wireBytes, wireCharacters) => monitor.emit("transport.transmitted", id, { wireBytes, wireCharacters }),
        cancelled: () => entry.terminal,
        progress: (content) => { if (!entry.terminal && !selection?.functions.length) client.progress(content); } });
      if (!transport.legacyInteractive) monitor.emit("transport.finished", id);
      if (entry.terminal) return;
      // The browser adapter decodes the DOM envelope with the shared tool-schema validators.
      const message = selection ? validateOutput(result, prepared, id, observe) : result?.message;
      const reason = result?.reason;
      if (!message || !["stop", "tool_calls", "length", "content_filter"].includes(reason) || (reason === "tool_calls") !== !!message.tool_calls) {
        throw error(502, "invalid_response", "The backend did not report a supported completion outcome.");
      }
      const realUsage = result.usage;
      const authoritative = ["prompt_tokens", "completion_tokens", "total_tokens"].every((key) => Number.isSafeInteger(realUsage?.[key]) && realUsage[key] >= 0);
      const input = authoritative ? realUsage.prompt_tokens : context.tokens;
      const tokens = authoritative ? realUsage.completion_tokens : estimateTokens(message.tool_calls ? JSON.stringify(message.tool_calls) : message.content ?? "");
      const usage = { prompt_tokens: input, completion_tokens: tokens, total_tokens: authoritative ? realUsage.total_tokens : input + tokens };
      const calls = message.tool_calls ?? [];
      if (history) {
        for (const [call, signature] of toolCallKeys(calls)) history.calls.set(call, { signature });
        while (history.calls.size > 256) history.calls.delete(history.calls.keys().next().value);
      }
      totals.estimatedOutputTokens += tokens;
      monitor.emit("response.decoded", id);
      if (!transport.legacyInteractive) monitor.emit("transport.usage", id, { authoritative, input, output: tokens });
      entry.monitorScope = result.scope ?? (worker.legacy ? undefined : worker.scope);
      entry.onDelivery = () => {
        if (entry.terminal) return;
        monitor.callsForwarded(id, entry.monitorScope, calls.map(({ id, function: { name } }) => ({ id, name })));
        terminal(entry, "completed", undefined, authoritative ? {} : { estimatedOutputTokens: tokens });
      };
      clearTimeout(entry.timer);
      client.finish(message, reason, usage);
    } catch (cause) {
      const failure = cause instanceof GatewayError ? cause : error(502, "invalid_response", "The completion could not be processed.");
      if (failure.uncertain) {
        paused = true;
        for (const job of waiting.values()) terminal(job, "failed", offline());
      }
      terminal(entry, "failed", failure);
    }
  }

  function dispatch() {
    if (active || paused || !waiting.size) return;
    const entry = waiting.values().next().value;
    waiting.delete(entry.id);
    clearTimeout(entry.timer);
    active = entry;
    totals.accepted++;
    totals.maxObservedActive = 1;
    totals.lastQueueWaitMs = Math.round(performance.now() - entry.queuedAt);
    monitor.emit("request.dispatched", entry.id);
    const remaining = entry.deadline === undefined ? config.processMs : Math.max(1, entry.deadline - performance.now());
    entry.timer = setTimeout(() => terminal(entry, "timed_out", transport.legacyInteractive ?
      error(504, "browser_timeout", "Timeout waiting for ChatGPT response") :
      error(504, "processing_timeout", "The provider exceeded the processing deadline. The slot stays occupied until upstream completion is confirmed.")),
    Math.min(config.processMs, remaining));
    void run(entry).finally(() => {
      active = undefined;
      release(entry);
      dispatch();
    });
  }

  async function complete(req, res, worker) {
    if (paused) { req.resume(); reject(res, offline(), worker.legacy); return; }
    const declared = Number(req.headers["content-length"]);
    const bytes = Number.isSafeInteger(declared) && declared >= 0 ? Math.min(config.maxBody, declared) : config.maxBody;
    const forClient = !worker.legacy ? [...retained.values()].filter((job) => job.worker.clientId === worker.clientId).length : 0;
    if (retained.size >= config.maxQueued + 1 || forClient >= config.maxPerClient || retainedBytes + bytes > reserveLimit) {
      totals.overloaded++;
      req.resume();
      reject(res, error(429, "queue_overloaded", "The Gateway queue is full. Wait before submitting another request.", { retryAfter: "2" }), worker.legacy);
      return;
    }
    if (busy.has(worker.scope)) {
      req.resume();
      reject(res, error(409, "session_busy", "Wait for the previous request in this worker session to finish."));
      return;
    }
    const id = randomUUID();
    const entry = { id, worker, res, bytes, reading: true, terminal: false, monitorScope: worker.legacy ? undefined : worker.scope };
    if (!worker.legacy) busy.add(worker.scope);
    retained.set(id, entry);
    retainedBytes += bytes;
    res.setHeader("X-Request-Id", id);
    if (worker.runTag) res.setHeader("X-Gateway-Run-Tag", worker.runTag);
    monitor.emit("request.received", id, { role: worker.role, transport: transport.id, runTag: worker.runTag }, "gateway", entry.monitorScope);
    res.once("finish", () => {
      entry.onDelivery?.();
      monitor.emit("response.client_finished", id);
    });
    res.once("close", () => {
      if (res.writableFinished) return;
      terminal(entry, "cancelled", error(499, "client_disconnected", "The response connection closed."));
      monitor.emit("response.client_disconnected", id);
    });
    try {
      const input = await readBody(req, config.maxBody);
      if (entry.terminal) return;
      if (paused) throw offline();
      const { body } = input;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw error(400, "invalid_json", "Invalid JSON");
      totals.incomingRequestBytes += input.bytes;
      totals.incomingRequestCharacters += input.characters;
      monitor.emit("request.input", id, { incomingBytes: input.bytes, incomingCharacters: input.characters });
      try { chatMessages(body); }
      catch { throw error(400, "invalid_request", "messages must be an array of message objects", { legacyType: "invalid_request_error" }); }
      entry.prepared = transport.prepare(body);
      const context = clientContext(entry.prepared.payload);
      context.incomingBytes = input.bytes;
      totals.estimatedInputTokens += context.tokens;
      monitor.emit("request.input", id, { logicalBytes: context.logicalBytes, incomingMessages: body.messages?.length ?? 0,
        estimatedInputTokens: context.tokens, model: safeModel(body.model ?? transport.models[0]) });
      if (settings.maxContextTokens && context.tokens > settings.maxContextTokens) {
        throw error(413, "context_length_exceeded", `Client context exceeds the configured ${settings.maxContextTokens}-token budget. Reduce the task context.`,
          { legacyType: "context_length_exceeded" });
      }
      entry.context = context;
      entry.connection = transport.capture?.(worker);
      const timeout = Number.parseInt(body.timeout, 10);
      const queueMs = transport.legacyInteractive && timeout > 0 ? Math.min(config.queueMs, timeout) : config.queueMs;
      entry.queuedAt = performance.now();
      if (transport.legacyInteractive && timeout > 0) entry.deadline = entry.queuedAt + timeout;
      entry.reading = false;
      entry.timer = setTimeout(() => terminal(entry, "timed_out", error(504, "queue_timeout", transport.legacyInteractive ?
        "Timeout waiting for an available browser tab" : "The request expired while waiting for the Gateway model slot.")), queueMs);
      waiting.set(id, entry);
      monitor.emit("request.queued", id);
      dispatch();
    } catch (cause) {
      terminal(entry, "failed", cause instanceof GatewayError ? cause : error(400, "invalid_request", "The request could not be read."));
    } finally {
      if (entry.reading) { entry.reading = false; release(entry); }
    }
  }

  async function manageSessions(req, res, path, collection) {
    try {
      if (req.headers.origin && req.headers.origin.toLowerCase() !== `http://${req.headers.host.toLowerCase()}`) {
        throw error(403, "local_origin_required", "Use the Gateway's own loopback origin for session management.");
      }
      if (!config.scopedManagement) throw error(503, "session_management_disabled", "Configure a strong Gateway admin key to manage scoped clients.");
      if (!admin(req)) throw unauthorized();
      if (path === collection && req.method === "POST") {
        const { body } = await readBody(req, 4096);
        if (!res.destroyed) writeJson(res, 201, workers.register(body));
      } else if (path === collection && req.method === "GET") {
        writeJson(res, 200, { items: workers.list() });
      } else if (path !== collection && req.method === "DELETE") {
        const id = path.slice(collection.length + 1);
        if (!uuid.test(id)) throw error(400, "invalid_session", "Use the issued Gateway session identifier.");
        const worker = workers.revoke(id);
        if (worker) for (const entry of retained.values()) {
          if (entry.worker === worker) terminal(entry, "cancelled", error(409, "session_revoked", "The Gateway admin revoked this worker session."));
        }
        writeJson(res, 200, { revoked: !!worker });
      } else {
        res.setHeader("Allow", path === collection ? "GET, POST" : "DELETE");
        throw error(405, "method_not_allowed", "Use an available method for worker session management.");
      }
    } catch (cause) {
      req.resume();
      reject(res, cause instanceof GatewayError ? cause : error(400, "invalid_session", "The worker session request could not be read."));
    }
  }

  function capabilities(req) {
    const credential = admin(req) ? "admin" : workers.lookup(req.headers.authorization) ? "worker" : "none";
    const availability = paused ? { state: "blocked" } : transport.availability();
    const scopedAvailable = config.scopedManagement && (transport.scopedReady?.() ?? true);
    const features = transport.capabilities;
    const canSubmit = (credential === "worker" && scopedAvailable) ||
      (!config.requireScoped && (!config.admin || credential === "admin"));
    const requestReady = features.programmatic && canSubmit && ["connected", "simulated", "verified"].includes(availability.state);
    const unattendedReady = requestReady && features.unattended === true && !features.simulated &&
      scopedAvailable && availability.state === "verified";
    return { schemaVersion: 1, connectivity: "connected", authentication: {
      configured: !!config.admin, credential, required: config.requireScoped || !!config.admin, sessionRegistration: config.scopedManagement,
    }, clients: { multiClient: config.maxSessions >= 2, maxSessions: config.maxSessions, sessionIsolation: "scoped",
      scopedAvailable, legacyAvailable: !config.requireScoped },
      transport: { id: transport.id, capabilities: features, availability, requestReady, unattendedReady,
        programmaticReady: unattendedReady } };
  }

  return {
    monitorAllowed,
    snapshot: () => {
      const browser = transport.metrics?.();
      return { ...browser, ...totals, oversizedRequestCount: totals.oversizedRequestCount + (browser?.oversizedRequestCount ?? 0),
        browserBusy: !!active && !!transport.legacyInteractive, activeSlots: Number(!!active), queued: waiting.size,
        pending: [...retained.values()].filter((entry) => !entry.terminal).length,
        maxQueued: config.maxQueued, maxPerClient: config.maxPerClient, retainedBytes, activeRequestId: active?.id ?? null, paused };
    },
    async route(req, res, path) {
      if (req.method === "GET" && path === "/v1/capabilities") { writeJson(res, 200, capabilities(req)); return true; }
      const collection = paths.find((prefix) => path === prefix || path.startsWith(prefix + "/"));
      if (collection) { await manageSessions(req, res, path, collection); return true; }
      const post = req.method === "POST" && path === "/v1/chat/completions";
      const cancel = req.method === "DELETE" && path.startsWith("/v1/requests/");
      const models = req.method === "GET" && path === "/v1/models";
      if (!post && !cancel && !models) return false;
      const worker = workers.lookup(req.headers.authorization) ??
        (!config.requireScoped && monitorAllowed(req.headers.authorization) ? legacy : undefined);
      if (!worker) {
        req.resume();
        reject(res, unauthorized());
        return true;
      }
      if (Object.keys(req.headers).some((name) => /^x-(?:gateway|factory)-(?:client|session|principal|run|issue|role)/i.test(name))) {
        req.resume();
        reject(res, error(403, "identity_mismatch", "Client and session identity come from the scoped worker key."));
        return true;
      }
      if (post) await complete(req, res, worker);
      else if (models) writeJson(res, 200, { object: "list", data: transport.models.map((id) => ({ id, object: "model", owned_by: "gateway" })) });
      else {
        const entry = retained.get(path.slice("/v1/requests/".length));
        const owned = entry?.worker === worker && !entry.terminal;
        if (owned) terminal(entry, "cancelled", error(worker.legacy ? 504 : 409, "client_cancelled", "The owning client cancelled the request."));
        writeJson(res, 200, { cancelled: owned });
      }
      return true;
    },
  };
}
