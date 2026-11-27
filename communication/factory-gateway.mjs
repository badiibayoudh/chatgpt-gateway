import { randomUUID } from "node:crypto";
import { toolCallKeys } from "../chat-history.mjs";
import { clientContext, estimateTokens } from "../context.mjs";
import { safeModel, safeName } from "../monitoring/events.mjs";
import { workerFor } from "./factory-config.mjs";
import { checkResultHistory, FactoryError, prepareFactoryPayload, readFactoryBody, validateOutput } from "./factory-protocol.mjs";
import { mockTransport, openAiTransport } from "./factory-transport.mjs";

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const error = (status, code, message) => new FactoryError(status, code, message);
const offline = () => error(503, "upstream_uncertain", "Factory dispatch is paused because upstream completion could not be confirmed. Reconcile before restarting.");

function reject(res, failure) {
  if (res.destroyed || res.writableEnded) return;
  const detail = { error: { code: failure.code, type: failure.code, message: failure.message } };
  if (res.headersSent) res.end(frame(detail));
  else {
    if (failure.retryAfter) res.setHeader("Retry-After", failure.retryAfter);
    json(res, failure.status, detail);
  }
}

function output(res, payload, requestId) {
  const base = { id: `chatcmpl-${requestId}`, model: payload.model, created: Math.floor(Date.now() / 1000) };
  const chunk = (choices, usage = null) => ({ ...base, object: "chat.completion.chunk", choices,
    ...(payload.stream_options?.include_usage && { usage }) });
  let progressed = false;
  const start = () => {
    if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
  };
  return {
    progress(text) {
      if (!payload.stream || !text || res.destroyed || res.writableEnded) return;
      start();
      res.write(frame(chunk([{ index: 0, delta: { ...(!progressed && { role: "assistant" }), content: text }, finish_reason: null }])));
      progressed = true;
    },
    finish(message, reason, usage) {
      if (!payload.stream) {
        json(res, 200, { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: reason }], usage });
        return;
      }
      start();
      const delta = progressed ? { ...(message.refusal && { refusal: message.refusal }) } : { ...message };
      if (message.tool_calls) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }));
      if (Object.keys(delta).length) res.write(frame(chunk([{ index: 0, delta, finish_reason: null }])));
      res.write(frame(chunk([{ index: 0, delta: {}, finish_reason: reason }])));
      if (payload.stream_options?.include_usage) res.write(frame(chunk([], usage)));
      res.end("data: [DONE]\n\n");
    },
  };
}

export function createFactoryGateway(config, settings, monitor, transport = config.mode === "mock" ? mockTransport() : openAiTransport(config)) {
  const waiting = new Map();
  const retained = new Map();
  const sessions = new Map();
  const busy = new Set();
  let retainedBytes = 0;
  let active;
  let paused = transport.ready?.() === false;
  const totals = { accepted: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0, overloaded: 0, maxObservedActive: 0 };

  function release(entry) {
    clearTimeout(entry.timer);
    waiting.delete(entry.id);
    if (!retained.delete(entry.id)) return;
    retainedBytes -= entry.bytes;
    busy.delete(entry.worker.scope);
  }

  function terminal(entry, state, failure) {
    if (entry.terminal) return false;
    entry.terminal = true;
    totals[state === "timed_out" ? "timedOut" : state]++;
    monitor.emit(`request.${state}`, entry.id, failure ? { code: failure.code } : {});
    if (failure) reject(entry.res, failure);
    if (active !== entry && !entry.reading) release(entry);
    return true;
  }

  async function run(entry) {
    const { res, id, worker, prepared, context } = entry;
    const { payload, selection } = prepared;
    const scope = worker.scope;
    let session = sessions.get(scope);
    if (!session || session.expires <= Date.now()) {
      session = { calls: new Map() };
      sessions.set(scope, session);
    }
    session.expires = Date.now() + config.sessionMs;
    const observe = (event, name) => monitor.emit(event, id, { name: safeName(name) ?? "redacted" });
    try {
      const checked = checkResultHistory(payload.messages, session);
      for (const [call, result] of checked) session.calls.get(call).result = result;
      monitor.resultsObserved(id, scope, checked.map(([call]) => call));
      for (const definition of selection.functions) observe("tool.exposed", definition.name);
      monitor.emit("context.prepared", id, { mode: "full", forwardedMessages: payload.messages.length, exposedTools: selection.functions.length, toolsReused: false });
      monitor.emit("transport.started", id);
      const client = output(res, payload, id);
      const result = await transport.complete(payload, { requestId: id,
        transmitted: (wireBytes, wireCharacters) => monitor.emit("transport.transmitted", id, { wireBytes, wireCharacters }),
        progress: (content) => { if (!entry.terminal && !selection.functions.length) client.progress(content); } });
      monitor.emit("transport.finished", id);
      if (entry.terminal) return;
      const message = validateOutput(result, prepared, id, observe);
      const reason = result.reason;
      if (!["stop", "tool_calls", "length", "content_filter"].includes(reason) || (reason === "tool_calls") !== !!message.tool_calls) {
        throw error(502, "invalid_response", "The provider did not report a supported completion outcome.");
      }
      const realUsage = result.usage;
      const authoritative = ["prompt_tokens", "completion_tokens", "total_tokens"].every((key) => Number.isSafeInteger(realUsage?.[key]) && realUsage[key] >= 0);
      const input = authoritative ? realUsage.prompt_tokens : context.tokens;
      const tokens = authoritative ? realUsage.completion_tokens : estimateTokens(JSON.stringify(message));
      const usage = { prompt_tokens: input, completion_tokens: tokens, total_tokens: authoritative ? realUsage.total_tokens : input + tokens };
      const calls = message.tool_calls ?? [];
      for (const [call, signature] of toolCallKeys(calls)) session.calls.set(call, { signature });
      while (session.calls.size > 256) session.calls.delete(session.calls.keys().next().value);
      monitor.emit("response.decoded", id);
      monitor.emit("transport.usage", id, { authoritative, input, output: tokens });
      entry.onDelivery = () => {
        if (entry.terminal) return;
        monitor.callsForwarded(id, scope, calls.map(({ id, function: { name } }) => ({ id, name })));
        terminal(entry, "completed");
      };
      clearTimeout(entry.timer);
      client.finish(message, reason, usage);
    } catch (cause) {
      const failure = cause instanceof FactoryError ? cause : error(502, "invalid_response", "The completion could not be processed.");
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
    monitor.emit("request.dispatched", entry.id);
    entry.timer = setTimeout(() => terminal(entry, "timed_out", error(504, "processing_timeout", "The provider exceeded the processing deadline. The slot stays occupied until upstream completion is confirmed.")), config.processMs);
    void run(entry).finally(() => {
      active = undefined;
      release(entry);
      dispatch();
    });
  }

  async function complete(req, res, worker) {
    if (paused) { req.resume(); reject(res, offline()); return; }
    // The reservation includes admission, queueing and active draining, with a process byte ceiling.
    const declared = Number(req.headers["content-length"]);
    const bytes = Number.isSafeInteger(declared) && declared >= 0 ? Math.min(config.maxBody, declared) : config.maxBody;
    const forClient = [...retained.values()].filter((job) => job.worker.clientId === worker.clientId).length;
    if (retained.size >= config.maxQueued + 1 || forClient >= config.maxPerClient || retainedBytes + bytes > 32 * 1024 * 1024) {
      totals.overloaded++;
      req.resume();
      reject(res, new FactoryError(429, "queue_overloaded", "The factory queue is full. Wait before submitting another request.", { retryAfter: "2" }));
      return;
    }
    if (busy.has(worker.scope)) {
      req.resume();
      reject(res, error(409, "session_busy", "Wait for the previous request in this worker session to finish."));
      return;
    }
    const id = randomUUID();
    const entry = { id, worker, res, bytes, reading: true, terminal: false };
    busy.add(worker.scope);
    retained.set(id, entry);
    retainedBytes += bytes;
    res.setHeader("X-Request-Id", id);
    res.setHeader("X-Gateway-Run-Tag", worker.runTag);
    monitor.emit("request.received", id, { role: worker.role, transport: config.mode, runTag: worker.runTag }, "gateway", worker.scope);
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
      const input = await readFactoryBody(req, config.maxBody);
      if (entry.terminal) return;
      if (paused) throw offline();
      const prepared = prepareFactoryPayload(input.body, config.models);
      const context = clientContext(prepared.payload);
      monitor.emit("request.input", id, { incomingBytes: input.bytes, incomingCharacters: input.characters,
        logicalBytes: context.logicalBytes, incomingMessages: prepared.payload.messages.length,
        estimatedInputTokens: context.tokens, model: safeModel(prepared.payload.model) });
      if (settings.maxContextTokens && context.tokens > settings.maxContextTokens) throw error(413, "context_length", "The estimated context exceeds the configured budget. Reduce the task input.");
      entry.prepared = prepared;
      entry.context = context;
      entry.reading = false;
      entry.timer = setTimeout(() => terminal(entry, "timed_out", error(504, "queue_timeout", "The request expired while waiting for the factory model slot.")), config.queueMs);
      waiting.set(id, entry);
      monitor.emit("request.queued", id);
      dispatch();
    } catch (cause) {
      terminal(entry, "failed", cause instanceof FactoryError ? cause : error(400, "invalid_request", "The factory request could not be read."));
    } finally {
      if (entry.reading) { entry.reading = false; release(entry); }
    }
  }

  return {
    snapshot: () => ({ transport: config.mode, ready: !paused, capabilities: transport.capabilities, activeSlots: Number(!!active), queued: waiting.size, pending: retained.size,
      maxQueued: config.maxQueued, maxPerClient: config.maxPerClient, retainedBytes, ...totals }),
    activeId: () => active?.id ?? null,
    async route(req, res, path) {
      const post = req.method === "POST" && path === "/v1/chat/completions";
      const cancel = req.method === "DELETE" && path.startsWith("/v1/requests/");
      const models = req.method === "GET" && path === "/v1/models";
      if (!post && !cancel && !models) return false;
      const worker = workerFor(config, req.headers.authorization);
      if (!worker) {
        req.resume();
        reject(res, error(401, "unauthorized", "Use an authorized, scoped factory worker bearer key."));
        return true;
      }
      if (Object.keys(req.headers).some((name) => /^x-(?:gateway|factory)-(?:client|session|principal|run|issue|role)/i.test(name))) {
        req.resume();
        reject(res, error(403, "identity_mismatch", "Client and session identity come from the scoped worker key."));
        return true;
      }
      if (post) await complete(req, res, worker);
      else if (models) json(res, 200, { object: "list", data: config.models.map((id) => ({ id, object: "model", owned_by: "gateway" })) });
      else {
        const entry = retained.get(path.slice("/v1/requests/".length));
        const owned = entry?.worker.scope === worker.scope;
        const cancelled = owned && terminal(entry, "cancelled", error(409, "client_cancelled", "The owning client cancelled the request."));
        json(res, 200, { cancelled });
      }
      return true;
    },
  };
}
