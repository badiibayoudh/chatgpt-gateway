// ChatGPT Gateway Server
// HTTP API + WebSocket relay to Chrome extension
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { chatMessages, prepareChat } from "./chat-tools.mjs";
import { conversationKey, describeHistory, messageKey, newMessages } from "./chat-history.mjs";

const PORT = parseInt(process.env.PORT || "18790", 10);
const MAX_BROWSER_WAIT = 240_000;
// Allow a full browser turn plus time waiting for the shared tab.
const DEFAULT_REQUEST_TIMEOUT = 300_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TRACKED_CHATS = 100;
const API_KEY = process.env.CHATGPT_GATEWAY_API_KEY;
const EXTENSION_ORIGIN = process.env.CHATGPT_GATEWAY_EXTENSION_ORIGIN;
const extensionCapabilities = new WeakMap();
const conversations = new Map();
const metrics = {
  accepted: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0, browserReplies: 0,
  lastQueueWaitMs: null, lastBrowserReplyMs: null,
};

// Pending HTTP requests waiting for extension response
const pending = new Map();

let extensionWs = null;
let activeRequest = null;

// ── WebSocket server (extension connects here) ────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

wss.on("connection", (ws) => {
  console.log("[gateway] Extension connected");
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
    } else if (msg?.type === "response") {
      finishBrowserRequest(ws, msg.requestId, msg);
    } else if (msg?.type === "progress" && activeRequest?.streamText && activeRequest.socket === ws &&
      activeRequest.requestId === msg.requestId && typeof msg.content === "string") {
      pending.get(msg.requestId)?.onProgress(msg.content);
    }
  });

  ws.on("close", () => {
    console.log("[gateway] Extension disconnected");
    if (extensionWs === ws) extensionWs = null;
    if (activeRequest?.socket === ws) releaseBrowser();
    for (const [requestId, entry] of pending) {
      if (entry.socket === ws) {
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
  const [requestId, { socket, message, payload, queuedAt }] = pending.entries().next().value;
  if (socket.readyState !== WebSocket.OPEN) return; // The close handler releases its requests.

  let prepared;
  try {
    prepared = prepareBrowserChat(payload, message, extensionCapabilities.get(socket));
  } catch (err) {
    resolveRequest(requestId, { ok: false, status: 400, error: err.message, errorCode: "invalid_request_error" });
    queueMicrotask(dispatchNextRequest);
    return;
  }
  if (prepared.attachmentsNeedSupport) {
    resolveRequest(requestId, { ok: false, status: 503, error: "Reload the updated browser extension and refresh ChatGPT to enable image attachments" });
    queueMicrotask(dispatchNextRequest);
    return;
  }

  const timer = setTimeout(() => {
    console.warn(`[gateway] Resetting stalled browser connection for ${requestId}`);
    socket.terminate();
  }, MAX_BROWSER_WAIT);
  const { chat, outgoing } = prepared;
  activeRequest = {
    socket, requestId, timer, chat, startedAt: Date.now(), streamText: outgoing.streamText,
    continuedChat: conversationKey(outgoing.continuation?.url),
  };
  metrics.accepted++;
  metrics.lastQueueWaitMs = activeRequest.startedAt - queuedAt;
  console.log(`[gateway] Sent request ${requestId} to the browser extension`);
  socket.send(JSON.stringify(outgoing), (err) => {
    if (err) {
      finishBrowserRequest(socket, requestId, {
        ok: false,
        error: "Could not send request to the browser extension",
      });
    }
  });
}

function matchContinuation(payload, message) {
  if (!conversations.size || payload.new_conversation === true) return;
  const history = describeHistory(payload.messages);
  const matches = [];
  for (const previous of conversations.values()) {
    if (previous.model !== message.model) continue;
    const messages = newMessages(history, previous);
    if (messages) matches.push({ previous, messages });
  }
  matches.sort((left, right) => right.previous.keys.length - left.previous.keys.length);
  const [match, alternative] = matches;
  if (!match || match.previous.keys.length === alternative?.previous.keys.length) return;
  return { ...match, clearInstructions: history.instructions.length === 0 && history.instructionsKey !== match.previous.instructionsKey };
}

function prepareBrowserChat(payload, message, capabilities) {
  const match = matchContinuation(payload, message);
  let continuation;
  let chat;
  if (match) {
    const { tabId, url, toolsKey } = match.previous;
    chat = prepareChat({ ...payload, messages: match.messages }, message.requestId, {
      toolsKey, clearInstructions: match.clearInstructions,
    });
    continuation = { tabId, url, messages: chat.messages, attachments: chat.attachments };
  }

  // Older extensions still expect the fallback payload alongside a continuation.
  const full = !continuation || !capabilities?.has("continuationOnly") ? prepareChat(payload, message.requestId) : null;
  chat ??= full;
  const outgoing = { ...message, continuation, streamText: payload.stream === true && chat.streamText };
  if (full) {
    outgoing.messages = full.messages;
    outgoing.attachments = full.attachments;
  }
  return {
    chat, outgoing,
    attachmentsNeedSupport: (chat.attachments.length || full?.attachments.length) && !capabilities?.has("imageAttachments"),
  };
}

function rememberConversation(payload, model, result, { content, toolCalls }, toolsKey) {
  const key = conversationKey(result.url);
  if (!Number.isInteger(result.tabId) || !key) return;
  const assistant = { role: "assistant", content, tool_calls: toolCalls };
  const { keys, instructionsKey } = describeHistory(payload.messages);
  conversations.delete(key);
  conversations.set(key, {
    tabId: result.tabId, url: result.url, model, instructionsKey, toolsKey,
    keys: [...keys, messageKey(assistant)],
    callIds: toolCalls?.map(({ id }) => id) ?? [],
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
  const chat = activeRequest.chat;
  metrics.browserReplies++;
  metrics.lastBrowserReplyMs = elapsedMs;
  console.log(`[gateway] Received browser reply for ${requestId} after ${elapsedMs} ms (ok=${result.ok})`);
  releaseBrowser();
  resolveRequest(requestId, { ...result, chat });
  queueMicrotask(dispatchNextRequest);
}

function resolveRequest(requestId, result) {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(result);
}

function cleanupRequest(requestId) {
  const entry = pending.get(requestId);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(requestId);
    metrics.cancelled++;
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
  const error = type ? { message, type } : message;
  if (res.headersSent) {
    res.end(streamFrame({ error: { message, type: type ?? "gateway_error" } }));
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function sendCompletion(res, payload, completion, { content, toolCalls }, streamed) {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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

async function handleHttp(req, res) {
  const origin = req.headers.origin;
  if (!loopbackHost(req.headers.host) || (origin && !localOrigin(origin))) {
    errorResponse(res, 403, "The gateway accepts only local requests");
    return;
  }
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
    res.end(
      JSON.stringify({
        status: "ok",
        extensionConnected: !!extensionWs,
        imageAttachments: extensionCapabilities.get(extensionWs)?.has("imageAttachments") ?? false,
        conversationReuse: extensionCapabilities.get(extensionWs)?.has("conversationReuse") ?? false,
        longMessageFallback: extensionCapabilities.get(extensionWs)?.has("longMessageFallback") ?? false,
        pendingRequests: pending.size,
      })
    );
    return;
  }

  if (!hasApiKey(req.headers.authorization)) {
    errorResponse(res, 401, "Use the configured gateway API key as a Bearer token");
    return;
  }
  if (req.method === "GET" && req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...metrics, pendingRequests: pending.size, browserBusy: !!activeRequest }));
    return;
  }

  // Cancel a pending request
  if (req.method === "DELETE" && req.url?.startsWith("/v1/requests/")) {
    const requestId = req.url.split("/").pop();
    const had = pending.has(requestId);
    cleanupRequest(requestId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled: had }));
    return;
  }

  // OpenAI-compatible chat completions
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      req.resume();
      errorResponse(res, 413, "Request body exceeds 32 MiB");
      return;
    }
    let payload;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          req.resume();
          errorResponse(res, 413, "Request body exceeds 32 MiB");
          return;
        }
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Expected request object");
      }
    } catch {
      if (res.destroyed) return;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const requestId = randomUUID();
    try {
      chatMessages(payload);
    } catch (err) {
      errorResponse(res, 400, err.message, "invalid_request_error");
      return;
    }

    const socket = extensionWs;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
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
      newConversation: payload.new_conversation !== false,
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
        console.warn(`[gateway] Timed out waiting for ${location} for ${requestId}`);
        reject(new Error(`Timeout waiting for ${location}`));
      }, timeoutMs);
      pending.set(requestId, { socket, message, payload, resolve, reject, timer, onProgress, queuedAt: Date.now() });
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
        errorResponse(res, result.errorCode === "chatgpt_input_too_long" ? 413 : 500, result.error);
        return;
      }

      const { chat } = result;
      let decoded;
      try {
        decoded = chat.decode(result.content);
        if (streamed && !decoded.content?.startsWith(streamed)) {
          throw new Error("ChatGPT revised the streamed text. Retry for the complete reply.");
        }
      } catch (err) {
        metrics.failed++;
        console.warn(`[gateway] Rejected browser reply for ${requestId}: ${err.message}`);
        errorResponse(res, 502, err.message, streamed ? "revised_response" : "invalid_tool_call");
        return;
      }
      rememberConversation(payload, message.model, result, decoded, chat.toolsKey);
      sendCompletion(res, payload, completion, decoded, streamed);
      metrics.completed++;
    } catch (err) {
      if (res.destroyed) return;
      metrics.failed++;
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
