// ChatGPT Gateway Server
// HTTP API + WebSocket relay to Chrome extension
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { prepareChat } from "./chat-tools.mjs";

const PORT = parseInt(process.env.PORT || "18790", 10);
const MAX_BROWSER_WAIT = 240_000;

// Pending HTTP requests waiting for extension response
const pending = new Map();

let extensionWs = null;
let activeRequest = null;

// ── WebSocket server (extension connects here) ────────────

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("[gateway] Extension connected");
  extensionWs = ws;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "response") finishBrowserRequest(ws, msg.requestId, msg);
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
  const [requestId, { socket, message }] = pending.entries().next().value;
  if (socket.readyState !== WebSocket.OPEN) return; // The close handler releases its requests.

  const timer = setTimeout(() => {
    console.warn(`[gateway] Resetting stalled browser connection for ${requestId}`);
    socket.terminate();
  }, MAX_BROWSER_WAIT);
  activeRequest = { socket, requestId, timer };
  console.log(`[gateway] Sent request ${requestId} to the browser extension`);
  socket.send(JSON.stringify(message), (err) => {
    if (err) {
      finishBrowserRequest(socket, requestId, {
        ok: false,
        error: "Could not send request to the browser extension",
      });
    }
  });
}

function releaseBrowser() {
  clearTimeout(activeRequest.timer);
  activeRequest = null;
}

function finishBrowserRequest(socket, requestId, result) {
  if (activeRequest?.socket !== socket || activeRequest.requestId !== requestId) return;
  console.log(`[gateway] Received browser reply for ${requestId} (ok=${result.ok})`);
  releaseBrowser();
  resolveRequest(requestId, result);
  dispatchNextRequest();
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
    entry.reject(new Error("Client disconnected"));
  }
}

function sendCompletion(res, payload, requestId, { content, toolCalls }) {
  const completion = {
    id: `chatcmpl-${requestId}`,
    created: Math.floor(Date.now() / 1000),
    model: payload.model || "chatgpt-web",
  };
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const message = { role: "assistant", content };
  const finishReason = toolCalls ? "tool_calls" : "stop";
  if (toolCalls) message.tool_calls = toolCalls;

  if (payload.stream === true) {
    const chunk = { ...completion, object: "chat.completion.chunk" };
    const includeUsage = payload.stream_options?.include_usage === true;
    const delta = toolCalls
      ? { role: "assistant", tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }
      : message;
    const events = [
      { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    ];
    if (includeUsage) {
      for (const event of events) event.usage = null;
      events.push({ ...chunk, choices: [], usage });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
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

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
        pendingRequests: pending.size,
      })
    );
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
    let payload;
    try {
      req.setEncoding("utf8");
      let body = "";
      for await (const chunk of req) body += chunk;
      payload = JSON.parse(body);
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
    let chat;
    try {
      chat = prepareChat(payload, requestId);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }));
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

    const timeoutMs = parseInt(payload.timeout || "90000", 10);
    const message = {
      type: "chat",
      requestId,
      model: payload.model || "auto",
      messages: chat.messages,
      newConversation: payload.new_conversation !== false,
    };

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const location = activeRequest?.requestId === requestId ? "ChatGPT response" : "an available browser tab";
        pending.delete(requestId);
        console.warn(`[gateway] Timed out waiting for ${location} for ${requestId}`);
        reject(new Error(`Timeout waiting for ${location}`));
      }, timeoutMs);
      pending.set(requestId, { socket, message, resolve, reject, timer });
    });

    // The request body can finish while the client is still waiting for our reply.
    res.once("close", () => cleanupRequest(requestId));

    // The browser can still be generating after an HTTP request is cancelled.
    dispatchNextRequest();

    try {
      const result = await promise;

      if (res.destroyed) return;

      if (!result.ok) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      let completion;
      try {
        completion = chat.decode(result.content);
      } catch (err) {
        console.warn(`[gateway] Rejected browser reply for ${requestId}: ${err.message}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "invalid_tool_call" } }));
        return;
      }
      sendCompletion(res, payload, requestId, completion);
    } catch (err) {
      if (res.destroyed) return;
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// WebSocket upgrade handler
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  const { port } = server.address();
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
