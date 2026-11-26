// ChatGPT Gateway Server
// HTTP API + WebSocket relay to Chrome extension
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { chatMessages, prepareChat } from "./chat-tools.mjs";
import { conversationKey, describeHistory, messageKey, newMessages, toolCallKeys } from "./chat-history.mjs";
import { clientContext, contextSettings, estimateTokens } from "./context.mjs";
import { createMonitor } from "./monitoring/index.mjs";
import { isMonitorPath, monitorRoutes } from "./monitoring/routes.mjs";
import { browserError, monitorCapabilities, safeModel, safeName } from "./monitoring/events.mjs";

const PORT = parseInt(process.env.PORT || "18790", 10);
const MAX_BROWSER_WAIT = 240_000;
// Allow a full browser turn plus time waiting for the shared tab.
const DEFAULT_REQUEST_TIMEOUT = 300_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TRACKED_CHATS = 100;
const API_KEY = process.env.CHATGPT_GATEWAY_API_KEY;
const EXTENSION_ORIGIN = process.env.CHATGPT_GATEWAY_EXTENSION_ORIGIN;
const settings = contextSettings();
const monitor = createMonitor();
monitor.emit("gateway.started");
const extensionCapabilities = new WeakMap();
const conversations = new Map();
const metrics = {
  accepted: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0, browserReplies: 0,
  lastQueueWaitMs: null, lastBrowserReplyMs: null,
  incomingRequestCharacters: 0, incomingRequestBytes: 0,
  outgoingPromptCharacters: 0, outgoingPromptBytes: 0,
  estimatedInputTokens: 0, estimatedOutputTokens: 0,
  fullHistoryRequests: 0, continuationRequests: 0, conversationReuseSuccesses: 0,
  toolDefinitionRequests: 0, toolDefinitionReuses: 0,
  imageAttachmentCount: 0, textAttachmentFallbackCount: 0, textAttachmentBytes: 0,
  oversizedRequestCount: 0, uploadAllowanceErrors: 0, fullContextBaselineBytes: 0,
  historyMatches: {
    explicit_new: 0, no_tracked_chat: 0, model_mismatch: 0, no_reliable_match: 0,
    ambiguous: 0, exact_history: 0, verified_tool_anchor: 0,
  },
};

// Pending HTTP requests waiting for extension response
const pending = new Map();

let extensionWs = null;
let activeRequest = null;

// ── WebSocket server (extension connects here) ────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

wss.on("connection", (ws) => {
  console.log("[gateway] Extension connected");
  monitor.emit("gateway.extension_connected");
  extensionWs = ws;
  ws.on("error", (err) => console.warn("[gateway] Extension socket error:", err.code ?? err.name));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg?.type === "hello" && Array.isArray(msg.capabilities)) {
      extensionCapabilities.set(ws, new Set(msg.capabilities));
      if (ws === extensionWs) monitor.emit("gateway.extension_capabilities", null,
        { capabilities: monitorCapabilities(extensionCapabilities.get(ws)) });
    } else if (msg?.type === "telemetry" && monitor.enabled) {
      const valid = msg.version === 1 && raw.length <= 64 * 1024 && activeRequest?.socket === ws &&
        activeRequest.requestId === msg.requestId && extensionCapabilities.get(ws)?.has("telemetryV1");
      monitor.extension(valid ? msg.requestId : null, valid ? msg.events : null);
    } else if (msg?.type === "response") {
      finishBrowserRequest(ws, msg.requestId, msg);
    } else if (msg?.type === "chat-transmission" && activeRequest?.socket === ws && activeRequest.requestId === msg.requestId) {
      recordTransmission(msg);
    } else if (msg?.type === "progress" && activeRequest?.streamText && activeRequest.socket === ws &&
      activeRequest.requestId === msg.requestId && typeof msg.content === "string") {
      pending.get(msg.requestId)?.onProgress(msg.content);
    }
  });

  ws.on("close", () => {
    console.log("[gateway] Extension disconnected");
    if (extensionWs === ws) { extensionWs = null; monitor.emit("gateway.extension_disconnected"); }
    if (activeRequest?.socket === ws) releaseBrowser();
    for (const [requestId, entry] of pending) {
      if (entry.socket === ws) {
        monitor.emit("request.failed", requestId, { code: "extension_unavailable" });
        resolveRequest(requestId, {
          ok: false,
          error: "Browser extension disconnected while waiting for ChatGPT",
        });
      }
    }
    dispatchNextRequest();
  });
});

// ── Helpers ────────────────────────────────────────────────

function dispatchNextRequest() {
  if (activeRequest || !pending.size) return;
  const [requestId, { socket, message, payload, context, queuedAt }] = pending.entries().next().value;
  if (socket.readyState !== WebSocket.OPEN) return; // The close handler releases its requests.

  let prepared;
  const capabilities = extensionCapabilities.get(socket);
  try {
    prepared = prepareBrowserChat(payload, message, capabilities);
  } catch (err) {
    if (err.code === "image_budget_exceeded") metrics.oversizedRequestCount++;
    rejectQueued(requestId, 400, err.message, "invalid_request_error", err.code === "image_budget_exceeded" ? "image_budget" : "invalid_request");
    return;
  }
  if (prepared.attachmentsNeedSupport) {
    rejectQueued(requestId, 503, "Reload the updated browser extension and refresh ChatGPT to enable image attachments");
    return;
  }
  const { chat, outgoing, history } = prepared;
  const prompt = chat.messages[0]?.content;
  const promptStats = { promptCharacters: typeof prompt === "string" ? prompt.length : 0,
    promptBytes: typeof prompt === "string" ? Buffer.byteLength(prompt) : 0, images: chat.attachments.length, textBytes: 0 };
  if (settings.maxPromptBytes && promptStats.promptBytes > settings.maxPromptBytes) {
    metrics.oversizedRequestCount++;
    rejectQueued(requestId, 413, `Browser prompt exceeds ${settings.maxPromptBytes} bytes. Send a smaller file selection, tool result, or task.`, "context_length_exceeded", "context_length");
    return;
  }
  if ((!settings.textAttachmentFallback || settings.maxPromptBytes) && !capabilities?.has("attachmentPolicy")) {
    rejectQueued(requestId, 503, "Reload the updated extension to enforce the configured browser prompt and attachment policy");
    return;
  }

  const timer = setTimeout(() => {
    console.warn(`[gateway] Resetting stalled browser connection for ${requestId}`);
    socket.terminate();
  }, MAX_BROWSER_WAIT);
  activeRequest = {
    socket, requestId, timer, chat, history, startedAt: Date.now(), streamText: outgoing.streamText,
    continuedChat: conversationKey(outgoing.continuation?.url), baselineBytes: context.baselineBytes,
  };
  metrics.accepted++;
  observePrepared(requestId, payload, prepared, context);
  monitor.emit("request.dispatched", requestId);
  metrics[outgoing.continuation ? "continuationRequests" : "fullHistoryRequests"]++;
  if (chat.hasTools) metrics.toolDefinitionRequests++;
  if (chat.toolsReused) metrics.toolDefinitionReuses++;
  if (!capabilities?.has("contextMetrics")) recordTransmission(promptStats);
  metrics.lastQueueWaitMs = activeRequest.startedAt - queuedAt;
  console.log(`[gateway] Sent request ${requestId} to the browser extension`);
  socket.send(JSON.stringify(outgoing), (err) => {
    if (err) {
      finishBrowserRequest(socket, requestId, {
        ok: false,
        error: "Could not send request to the browser extension",
        monitorCode: "extension_send",
      });
    }
  });
}

function rejectQueued(requestId, status, error, errorCode, code = "extension_upgrade") {
  monitor.emit("request.failed", requestId, { code });
  resolveRequest(requestId, { ok: false, status, error, errorCode });
  queueMicrotask(dispatchNextRequest);
}

function matchContinuation(payload, message, history) {
  if (payload.new_conversation === true) return { reason: "explicit_new" };
  if (!conversations.size) return { reason: "no_tracked_chat" };
  const matches = [];
  let hasModel = false;
  for (const previous of conversations.values()) {
    if (previous.model !== message.model) continue;
    hasModel = true;
    const match = newMessages(history, previous);
    if (match) matches.push({ previous, ...match });
  }
  if (!matches.length) return { reason: hasModel ? "no_reliable_match" : "model_mismatch" };
  const verified = matches.filter(({ strong }) => strong);
  const candidates = verified.length ? verified : matches;
  if (candidates.length !== 1) return { reason: "ambiguous" };
  const [match] = candidates;
  return { ...match, clearInstructions: history.instructions.length === 0 && history.instructionsKey !== match.previous.instructionsKey };
}

function prepareBrowserChat(payload, message, capabilities) {
  const history = describeHistory(payload.messages);
  const match = matchContinuation(payload, message, history);
  metrics.historyMatches[match.reason]++;
  monitor.emit(match.previous ? "context.matched" : "context.reuse_missed", message.requestId, { reason: match.reason }, "gateway", conversationKey(match.previous?.url));
  let continuation;
  let chat;
  if (match.previous) {
    const { tabId, url, toolsKey } = match.previous;
    chat = prepareChat({ ...payload, messages: match.messages }, message.requestId, {
      toolsKey, clearInstructions: match.clearInstructions,
    }, { includeHistoricalImages: settings.includeHistoricalImages, monitor: monitor.enabled });
    continuation = { tabId, url, messages: chat.messages, attachments: chat.attachments };
  }

  // Older extensions still expect the fallback payload alongside a continuation.
  const full = !continuation || !capabilities?.has("continuationOnly")
    ? prepareChat(payload, message.requestId, undefined, { includeHistoricalImages: settings.includeHistoricalImages, monitor: monitor.enabled }) : null;
  chat ??= full;
  const outgoing = {
    ...message, continuation, newConversation: !!full,
    streamText: payload.stream === true && chat.streamText, textAttachmentFallback: settings.textAttachmentFallback,
    maxPromptBytes: settings.maxPromptBytes,
    ...(monitor.enabled && capabilities?.has("telemetryV1") ? { telemetry: 1 } : {}),
  };
  if (full) {
    outgoing.messages = full.messages;
    outgoing.attachments = full.attachments;
  }
  return {
    chat, outgoing, full, newMessages: match.messages, history: { keys: history.keys, instructionsKey: history.instructionsKey },
    attachmentsNeedSupport: (chat.attachments.length || full?.attachments.length) && !capabilities?.has("imageAttachments"),
  };
}

function observePrepared(requestId, payload, prepared, context) {
  if (!monitor.enabled) return;
  try {
    const { chat, outgoing, full, newMessages } = prepared;
    let reference = full;
    if (!reference && context.incomingBytes <= 256 * 1024) {
      try {
        reference = prepareChat(payload, requestId, undefined, { includeHistoricalImages: settings.includeHistoricalImages, referenceOnly: true });
      } catch { /* Historical images or message types can make a comparable full prompt unavailable. */ }
    }
    const bytes = (turn) => typeof turn?.messages[0]?.content === "string" ? Buffer.byteLength(turn.messages[0].content) : undefined;
    const { attachmentStats, names, ...stats } = chat.observation;
    monitor.emit("context.prepared", requestId, { ...stats, toolsReused: chat.toolsReused,
      mode: outgoing.continuation ? "continuation" : "full", preparedTextBytes: bytes(chat), fullTextBytes: bytes(reference) });
    monitor.emit("attachment.prepared", requestId, attachmentStats);
    if (attachmentStats.skipped) monitor.emit("attachment.skipped", requestId, { kind: "image", count: attachmentStats.skipped });
    for (const name of names) monitor.emit("tool.exposed", requestId, { name: safeName(name) ?? "redacted" });
    const messages = newMessages ?? (payload.messages ?? []).slice((payload.messages ?? []).findLastIndex(({ role }) => role === "assistant") + 1);
    const results = messages.filter(({ role }) => role === "tool").map(({ tool_call_id }) => tool_call_id);
    monitor.resultsObserved(requestId, conversationKey(outgoing.continuation?.url), results);
  } catch { /* Monitoring must not change request dispatch. */ }
}

function rememberConversation(model, result, { content, toolCalls }, toolsKey) {
  const key = conversationKey(result.url);
  if (!Number.isInteger(result.tabId) || !key) return;
  const assistant = { role: "assistant", content, tool_calls: toolCalls };
  const { keys, instructionsKey } = result.history;
  conversations.delete(key);
  conversations.set(key, {
    tabId: result.tabId, url: result.url, model, instructionsKey, toolsKey,
    keys: [...keys, messageKey(assistant)],
    calls: toolCallKeys(toolCalls),
  });
  if (conversations.size > MAX_TRACKED_CHATS) conversations.delete(conversations.keys().next().value);
}

function releaseBrowser() {
  clearTimeout(activeRequest.timer);
  activeRequest = null;
}

function finishBrowserRequest(socket, requestId, result) {
  if (activeRequest?.socket !== socket || activeRequest.requestId !== requestId) return;
  // A cancelled turn may have changed the browser history without reaching the IDE.
  if (!pending.has(requestId)) conversations.delete(activeRequest.continuedChat);
  const elapsedMs = Date.now() - activeRequest.startedAt;
  const { chat, history } = activeRequest;
  monitor.emit("browser.reply_relayed", requestId, { ok: result.ok === true });
  const continuedChat = activeRequest.continuedChat;
  if (result.oversized === true || isOversizedError(result.errorCode)) recordOversized();
  if (result.errorCode === "chatgpt_upload_allowance") metrics.uploadAllowanceErrors++;
  metrics.browserReplies++;
  metrics.lastBrowserReplyMs = elapsedMs;
  console.log(`[gateway] Received browser reply for ${requestId} after ${elapsedMs} ms (ok=${result.ok === true})`);
  releaseBrowser();
  resolveRequest(requestId, { ...result, chat, history, continuedChat });
  queueMicrotask(dispatchNextRequest);
}

function isOversizedError(code) {
  return code === "chatgpt_input_too_long" || code === "chatgpt_draft_blocked";
}

function recordOversized() {
  if (!activeRequest.oversized) metrics.oversizedRequestCount++;
  activeRequest.oversized = true;
}

function recordTransmission({ promptCharacters, promptBytes, images, textBytes, fallback }) {
  if (![promptCharacters, promptBytes, images, textBytes].every((value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= MAX_BODY_BYTES)) return;
  if (extensionCapabilities.get(activeRequest.socket)?.has("contextMetrics")) {
    monitor.emit("context.transmitted", activeRequest.requestId, { forwardedTextBytes: promptBytes,
      forwardedCharacters: promptCharacters, textAttachmentBytes: textBytes, fallback: fallback === true });
  }
  metrics.fullContextBaselineBytes += activeRequest.baselineBytes;
  activeRequest.baselineBytes = 0;
  metrics.outgoingPromptCharacters += promptCharacters;
  metrics.outgoingPromptBytes += promptBytes;
  metrics.imageAttachmentCount += images;
  metrics.textAttachmentBytes += textBytes;
  if (fallback === true) {
    metrics.textAttachmentFallbackCount++;
    recordOversized();
  }
}

function resolveRequest(requestId, result) {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(result);
}

function cleanupRequest(requestId, code = "client_disconnected") {
  const entry = pending.get(requestId);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(requestId);
    metrics.cancelled++;
    monitor.emit("request.cancelled", requestId, { code });
    entry.reject(new Error("Client disconnected"));
  }
}

function streamFrame(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function startEventStream(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
  });
}

function errorResponse(res, status, message, type) {
  const code = type === "context_length_exceeded" || type === "upload_allowance_exceeded" ? type : undefined;
  const error = type ? { message, type, code } : message;
  if (res.headersSent) {
    res.end(streamFrame({ error: { message, type: type ?? "gateway_error", code } }));
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function sendCompletion(res, payload, completion, { content, toolCalls }, streamed, usage) {
  const message = { role: "assistant", content };
  const finishReason = toolCalls ? "tool_calls" : "stop";
  if (toolCalls) message.tool_calls = toolCalls;

  if (payload.stream === true) {
    const chunk = { ...completion, object: "chat.completion.chunk" };
    const includeUsage = payload.stream_options?.include_usage === true;
    const delta = toolCalls
      ? { role: "assistant", tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }
      : streamed ? { content: content.slice(streamed.length) } : message;
    const events = [];
    if (!streamed || delta.content) {
      events.push({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] });
    }
    events.push({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
    if (includeUsage) {
      for (const event of events) event.usage = null;
      events.push({ ...chunk, choices: [], usage });
    }

    startEventStream(res);
    const frames = events.map(streamFrame);
    res.end(frames.join("") + "data: [DONE]\n\n");
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ...completion,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    })
  );
}

// ── HTTP server ────────────────────────────────────────────

function loopbackHost(host = "") {
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

function extensionOrigin(origin = "") {
  return /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

function localOrigin(origin) {
  return extensionOrigin(origin) ||
    /^https?:\/\//i.test(origin) && loopbackHost(origin.split("://")[1]);
}

function hasApiKey(header) {
  if (!API_KEY) return true;
  const expected = Buffer.from(`Bearer ${API_KEY}`);
  const received = Buffer.from(header ?? "");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function healthSnapshot() {
  const caps = extensionCapabilities.get(extensionWs);
  return { status: "ok", extensionConnected: !!extensionWs,
    imageAttachments: caps?.has("imageAttachments") ?? false, conversationReuse: caps?.has("conversationReuse") ?? false,
    longMessageFallback: settings.textAttachmentFallback && (caps?.has("longMessageFallback") ?? false), pendingRequests: pending.size };
}

function metricsSnapshot() {
  const percent = (part, total) => total ? Math.round(10_000 * part / total) / 100 : 0;
  const textBytesSent = metrics.outgoingPromptBytes + metrics.textAttachmentBytes;
  return {
    ...metrics, pendingRequests: pending.size, browserBusy: !!activeRequest,
    conversationReuseSuccessRate: percent(metrics.conversationReuseSuccesses, metrics.continuationRequests),
    toolDefinitionReuseRate: percent(metrics.toolDefinitionReuses, metrics.toolDefinitionRequests),
    redundantDataAvoidedPercent: percent(Math.max(0, metrics.fullContextBaselineBytes - textBytesSent), metrics.fullContextBaselineBytes),
  };
}

const serveMonitor = monitorRoutes(monitor, () => ({
  health: healthSnapshot(), metrics: metricsSnapshot(), activeRequestId: activeRequest?.requestId ?? null,
  queued: pending.size - Number(pending.has(activeRequest?.requestId)),
  capabilities: monitorCapabilities(extensionCapabilities.get(extensionWs)),
  configuration: { ...settings, apiKeyRequired: !!API_KEY, extensionOriginRestricted: !!EXTENSION_ORIGIN, connectionMode: "loopback", maxBodyBytes: MAX_BODY_BYTES,
    ...(monitor.config && { requestRetention: monitor.config.requests, eventRetention: monitor.config.events,
      eventBytes: monitor.config.eventBytes, persist: monitor.config.persist, logFiles: monitor.config.logFiles, logBytes: monitor.config.logBytes }) },
}), hasApiKey);

async function handleHttp(req, res) {
  const origin = req.headers.origin;
  if (!loopbackHost(req.headers.host) || (origin && !localOrigin(origin))) {
    errorResponse(res, 403, "The gateway accepts only local requests");
    return;
  }
  const path = req.url.split("?")[0];
  if (isMonitorPath(path) && await serveMonitor(req, res, path)) return;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(healthSnapshot()));
    return;
  }

  if (!hasApiKey(req.headers.authorization)) {
    errorResponse(res, 401, "Use the configured gateway API key as a Bearer token");
    return;
  }
  if (req.method === "GET" && req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(metricsSnapshot()));
    return;
  }

  // Cancel a pending request
  if (req.method === "DELETE" && req.url?.startsWith("/v1/requests/")) {
    const requestId = req.url.split("/").pop();
    const had = pending.has(requestId);
    cleanupRequest(requestId, "client_cancelled");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled: had }));
    return;
  }

  // OpenAI-compatible chat completions
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const requestId = randomUUID();
    monitor.emit("request.received", requestId);
    let observedCompletion;
    if (monitor.enabled) {
      res.once("finish", () => {
        if (observedCompletion) {
          const { scope, outputTokens, toolCalls } = observedCompletion;
          monitor.callsForwarded(requestId, scope, toolCalls);
          monitor.emit("request.completed", requestId, { estimatedOutputTokens: outputTokens }, "gateway", scope);
        }
        monitor.emit("response.client_finished", requestId);
      });
      res.once("close", () => {
        if (res.writableFinished) return;
        monitor.emit("request.cancelled", requestId, { code: "client_disconnected" });
        monitor.emit("response.client_disconnected", requestId);
      });
    }
    const failed = (code) => monitor.emit("request.failed", requestId, { code });
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      req.resume();
      metrics.oversizedRequestCount++;
      failed("context_length");
      errorResponse(res, 413, "Request body exceeds 32 MiB. Send fewer images or a smaller task context.", "context_length_exceeded");
      return;
    }
    let payload;
    let incomingBytes;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          req.resume();
          metrics.oversizedRequestCount++;
          failed("context_length");
          errorResponse(res, 413, "Request body exceeds 32 MiB. Send fewer images or a smaller task context.", "context_length_exceeded");
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, bytes).toString("utf8");
      incomingBytes = bytes;
      metrics.incomingRequestCharacters += body.length;
      metrics.incomingRequestBytes += bytes;
      monitor.emit("request.input", requestId, { incomingBytes: bytes, incomingCharacters: body.length });
      payload = JSON.parse(body);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Expected request object");
      }
    } catch {
      if (res.destroyed) return;
      failed("invalid_json");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    let context;
    try {
      chatMessages(payload);
      context = clientContext(payload);
      context.incomingBytes = incomingBytes;
    } catch (err) {
      failed("invalid_request");
      errorResponse(res, 400, err.message, "invalid_request_error");
      return;
    }
    metrics.estimatedInputTokens += context.tokens;
    if (monitor.enabled) monitor.emit("request.input", requestId, { logicalBytes: context.logicalBytes,
      incomingMessages: payload.messages?.length ?? 0, estimatedInputTokens: context.tokens, model: safeModel(payload.model ?? "auto") });
    if (settings.maxContextTokens && context.tokens > settings.maxContextTokens) {
      metrics.oversizedRequestCount++;
      failed("context_length");
      errorResponse(res, 413, `Client context is estimated at ${context.tokens} tokens and exceeds the configured ${settings.maxContextTokens}-token budget. Start a smaller task, compact the IDE history, or reduce the supplied files and tool output.`, "context_length_exceeded");
      return;
    }

    const socket = extensionWs;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      failed("extension_unavailable");
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "Extension not connected. Load the extension and open chatgpt.com",
        })
      );
      return;
    }
    const timeoutMs = parseInt(payload.timeout || DEFAULT_REQUEST_TIMEOUT, 10);
    const completion = {
      id: `chatcmpl-${requestId}`,
      created: Math.floor(Date.now() / 1000),
      model: payload.model || "chatgpt-web",
    };
    const message = {
      type: "chat",
      requestId,
      model: payload.model || "auto",
    };

    let streamed = "";
    const onProgress = (content) => {
      if (res.destroyed || content === streamed || !content.startsWith(streamed)) return;
      startEventStream(res);
      const delta = streamed ? {} : { role: "assistant" };
      delta.content = content.slice(streamed.length);
      streamed = content;
      res.write(streamFrame({
        ...completion, object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: null }],
        ...(payload.stream_options?.include_usage === true ? { usage: null } : {}),
      }));
    };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const location = activeRequest?.requestId === requestId ? "ChatGPT response" : "an available browser tab";
        pending.delete(requestId);
        metrics.timedOut++;
        monitor.emit("request.timed_out", requestId, { code: activeRequest?.requestId === requestId ? "browser_timeout" : "queue_timeout" });
        console.warn(`[gateway] Timed out waiting for ${location} for ${requestId}`);
        reject(new Error(`Timeout waiting for ${location}`));
      }, timeoutMs);
      pending.set(requestId, { socket, message, payload, context, resolve, reject, timer, onProgress, queuedAt: Date.now() });
      monitor.emit("request.queued", requestId);
    });

    // The request body can finish while the client is still waiting for our reply.
    res.once("close", () => cleanupRequest(requestId));

    // The browser can still be generating after an HTTP request is cancelled.
    dispatchNextRequest();

    try {
      const result = await promise;

      if (res.destroyed) return;

      if (result.status) {
        errorResponse(res, result.status, result.error, result.errorCode);
        return;
      }
      if (!result.ok) {
        metrics.failed++;
        failed(result.monitorCode === "extension_send" ? "extension_send" : browserError(result.errorCode, result.error));
        if (isOversizedError(result.errorCode)) {
          const message = typeof result.error === "string" ? result.error : "ChatGPT could not send the oversized draft";
          errorResponse(res, 413, `${message}. Send a smaller file selection, tool result, or task.`, "context_length_exceeded");
        } else if (result.errorCode === "chatgpt_upload_allowance") {
          errorResponse(res, 429, result.error, "upload_allowance_exceeded");
        } else {
          errorResponse(res, 500, result.error);
        }
        return;
      }

      const { chat } = result;
      let decoded;
      try {
        if (typeof result.content !== "string") throw new Error("ChatGPT did not return text content");
        decoded = chat.decode(result.content, monitor.enabled ? (event, name) =>
          monitor.emit(event, requestId, { name: safeName(name) ?? "redacted" }) : undefined);
        if (streamed && !decoded.content?.startsWith(streamed)) {
          throw new Error("ChatGPT revised the streamed text. Retry for the complete reply.");
        }
      } catch (err) {
        metrics.failed++;
        const code = streamed ? "revised_response" : chat.hasTools ? "invalid_tool_call" : "invalid_response";
        failed(code);
        console.warn(`[gateway] Rejected browser reply for ${requestId}: ${code}`);
        errorResponse(res, 502, err.message, streamed ? "revised_response" : "invalid_tool_call");
        return;
      }
      monitor.emit("response.decoded", requestId);
      rememberConversation(message.model, result, decoded, chat.toolsKey);
      const scope = conversationKey(result.url);
      if (result.continuedChat && result.continuedChat === scope) {
        metrics.conversationReuseSuccesses++;
        monitor.emit("context.reused", requestId);
      }
      const outputTokens = estimateTokens(decoded.toolCalls ? JSON.stringify(decoded.toolCalls) : decoded.content);
      metrics.estimatedOutputTokens += outputTokens;
      const usage = { prompt_tokens: context.tokens, completion_tokens: outputTokens, total_tokens: context.tokens + outputTokens };
      if (monitor.enabled) observedCompletion = { scope, outputTokens, toolCalls: (decoded.toolCalls ?? []).slice(0, 100)
        .map(({ id, function: { name } }) => ({ id, name })) };
      sendCompletion(res, payload, completion, decoded, streamed, usage);
      metrics.completed++;
    } catch (err) {
      if (res.destroyed) return;
      metrics.failed++;
      failed("browser_timeout");
      errorResponse(res, 504, err.message);
    }
    return;
  }

  // Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

function listener() {
  const server = createServer(handleHttp);
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    const allowed = EXTENSION_ORIGIN ? origin === EXTENSION_ORIGIN : !origin || extensionOrigin(origin);
    if (req.url !== "/ws" || !loopbackHost(req.headers.host) || !allowed) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  return server;
}

const server = listener();
if (monitor.enabled && monitor.config.persist) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => monitor.close().finally(() => process.exit(0)));
}
server.listen(PORT, "127.0.0.1", () => {
  const { port } = server.address();
  const ipv6 = listener();
  ipv6.on("error", (err) => {
    if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(err.code)) throw err;
  });
  ipv6.listen(port, "::1");
  console.log(`
  ChatGPT Gateway Server
  ──────────────────────
  HTTP API:    http://localhost:${port}/v1/chat/completions
  Health:      http://localhost:${port}/health
  WebSocket:   ws://localhost:${port}/ws

  Usage:
    curl -X POST http://localhost:${port}/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -d '{"model":"auto","messages":[{"role":"user","content":"Say hi"}]}'
  `);
});
