// ChatGPT Gateway Server
// HTTP API + WebSocket relay to Chrome extension
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = parseInt(process.env.PORT || "18790", 10);

// Pending HTTP requests waiting for extension response
const pending = new Map(); // requestId -> { socket, resolve, reject, timer }

let extensionWs = null;

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

    if (msg.type === "response" && pending.get(msg.requestId)?.socket === ws) {
      console.log(`[gateway] Received browser reply for ${msg.requestId} (ok=${msg.ok})`);
      resolveRequest(msg.requestId, msg);
    }
  });

  ws.on("close", () => {
    console.log("[gateway] Extension disconnected");
    if (extensionWs === ws) extensionWs = null;
    for (const [requestId, entry] of pending) {
      if (entry.socket === ws) {
        resolveRequest(requestId, {
          ok: false,
          error: "Browser extension disconnected while waiting for ChatGPT",
        });
      }
    }
  });
});

// ── Helpers ────────────────────────────────────────────────

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

function sendCompletion(res, payload, requestId, content) {
  const completion = {
    id: `chatcmpl-${requestId}`,
    created: Math.floor(Date.now() / 1000),
    model: payload.model || "chatgpt-web",
  };
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const message = { role: "assistant", content };

  if (payload.stream === true) {
    const chunk = { ...completion, object: "chat.completion.chunk" };
    const includeUsage = payload.stream_options?.include_usage === true;
    const events = [
      { ...chunk, choices: [{ index: 0, delta: message, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
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
      choices: [{ index: 0, message, finish_reason: "stop" }],
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
    } catch {
      if (res.destroyed) return;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const socket = extensionWs;
    if (!socket || socket.readyState !== 1) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "Extension not connected. Load the extension and open chatgpt.com",
        })
      );
      return;
    }

    const requestId = randomUUID();
    const timeoutMs = parseInt(payload.timeout || "90000", 10);

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        console.warn(`[gateway] Timed out waiting for browser reply for ${requestId}`);
        reject(new Error("Timeout waiting for ChatGPT response"));
      }, timeoutMs);
      pending.set(requestId, { socket, resolve, reject, timer });
    });

    // The request body can finish while the client is still waiting for our reply.
    res.once("close", () => cleanupRequest(requestId));

    // Send to extension
    console.log(`[gateway] Sent request ${requestId} to the browser extension`);
    socket.send(
      JSON.stringify({
        type: "chat",
        requestId,
        model: payload.model || "auto",
        messages: payload.messages || [],
        newConversation: payload.new_conversation !== false,
      }),
      (err) => {
        if (err) {
          resolveRequest(requestId, { ok: false, error: "Could not send request to the browser extension" });
        }
      }
    );

    try {
      const result = await promise;

      if (res.destroyed) return;

      if (!result.ok) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      sendCompletion(res, payload, requestId, result.content);
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
  console.log(`
  ChatGPT Gateway Server
  ──────────────────────
  HTTP API:    http://localhost:${PORT}/v1/chat/completions
  Health:      http://localhost:${PORT}/health
  WebSocket:   ws://localhost:${PORT}/ws

  Usage:
    curl -X POST http://localhost:${PORT}/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -d '{"model":"auto","messages":[{"role":"user","content":"Say hi"}]}'
  `);
});
