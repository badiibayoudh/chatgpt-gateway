// ChatGPT Gateway — Background service worker
// Connects to local gateway server via WebSocket
"use strict";

const GATEWAY_URL = "ws://localhost:18790/ws";
const HEARTBEAT_INTERVAL = 20_000;
const utf8 = new TextEncoder();
let ws = null;
let reconnectTimer = null;
const browserRequests = new Map();

function log(...args) {
  console.log("[Gateway BG]", ...args);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  let socket;
  try {
    socket = new WebSocket(GATEWAY_URL);
  } catch (err) {
    log("WebSocket constructor failed:", err.message);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    log("Connected to gateway server");
    sendToServer(socket, {
      type: "hello",
      capabilities: ["imageAttachments", "conversationReuse", "longMessageFallback", "continuationOnly", "attachmentPolicy", "contextMetrics", "telemetryV1"],
    });
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      log("Invalid JSON from server");
      return;
    }

    if (msg.type !== "chat") return;

    // Chrome can suspend an idle worker while the tab is generating a reply.
    const heartbeat = setInterval(() => {
      sendToServer(socket, { type: "ping" });
    }, HEARTBEAT_INTERVAL);
    try {
      await handleChatMessage(msg, socket);
    } catch (err) {
      if (/could not reopen/i.test(err.message)) emitTelemetry(socket, msg, "browser.tab_unavailable");
      sendToServer(socket, {
        type: "response",
        requestId: msg.requestId,
        ok: false,
        error: err.message,
      });
    } finally {
      clearInterval(heartbeat);
    }
  };

  socket.onclose = () => {
    log("Disconnected from gateway server");
    if (ws !== socket) return;
    ws = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after this
    socket.close();
  };
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setInterval(connect, 5000);
  }
}

function sendToServer(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function emitTelemetry(socket, msg, event, data = {}, component = "background") {
  if (msg.telemetry !== 1) return;
  try {
    sendToServer(socket, { type: "telemetry", version: 1, requestId: msg.requestId,
      events: [{ requestId: msg.requestId, component, event, data }] });
  } catch { /* Observability must not prevent a browser reply. */ }
}

function userText(messages = []) {
  const content = [...messages].reverse().find(({ role }) => role === "user")?.content;
  return Array.isArray(content)
    ? content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
    : content;
}

function chatUrl(url) {
  return url?.split(/[?#]/)[0].replace(/\/$/, "");
}

async function isConversationReady(tabId, url) {
  const page = await chrome.tabs.sendMessage(tabId, { type: "ping" }).catch(() => null);
  return page?.ok && chatUrl(page.url) === chatUrl(url);
}

async function reopenConversation(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await isConversationReady(tab.id, url)) return tab;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Could not reopen the ChatGPT chat for this task. Open or refresh that chat and retry.");
}

async function handleChatMessage(msg, socket) {
  const continuation = msg.continuation;
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  if (!continuation && tabs.length === 0) {
    emitTelemetry(socket, msg, "browser.tab_unavailable");
    sendToServer(socket, {
      type: "response",
      requestId: msg.requestId,
      ok: false,
      error: "No ChatGPT tab open. Please navigate to chatgpt.com",
    });
    return;
  }

  const { messages, attachments } = continuation ?? msg;
  const userMessage = userText(messages);

  if (typeof userMessage !== "string" || !userMessage) {
    sendToServer(socket, {
      type: "response",
      requestId: msg.requestId,
      ok: false,
      error: "No user message in request",
    });
    return;
  }

  const expectedConversation = continuation?.url;
  let candidates = tabs;
  if (continuation) {
    const matches = tabs.filter((tab) => chatUrl(tab.url) === chatUrl(expectedConversation));
    const ready = await Promise.all(matches.map(({ id }) => isConversationReady(id, expectedConversation)));
    candidates = matches.filter((_, index) => ready[index]);
    candidates.sort((left, right) => Number(right.id === continuation.tabId) - Number(left.id === continuation.tabId));
    if (!candidates.length) candidates.push(await reopenConversation(expectedConversation));
  }
  const errors = [];
  for (const tab of candidates) {
    try {
      if (msg.streamText || msg.telemetry === 1) browserRequests.set(msg.requestId, { socket, tabId: tab.id, msg });
      emitTelemetry(socket, msg, "browser.tab_located");
      const send = async (text, files, newConversation, expectedDraftUrl, fallback = false) => {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "chat",
          requestId: msg.requestId,
          model: msg.model,
          userMessage: text,
          attachments: files,
          streamText: msg.streamText,
          newConversation,
          expectedConversation,
          expectedDraftUrl,
          ...(msg.telemetry === 1 ? { telemetry: 1 } : {}),
        });
        if (!response.conversationChanged) {
          sendToServer(socket, {
            type: "chat-transmission", requestId: msg.requestId,
            promptCharacters: text.length, promptBytes: utf8.encode(text).byteLength,
            images: files?.filter(({ mimeType }) => mimeType.startsWith("image/")).length ?? 0,
            textBytes: fallback ? utf8.encode(userMessage).byteLength : 0, fallback,
          });
        }
        return response;
      };
      const newConversation = !continuation && msg.newConversation !== false;
      let response = await send(userMessage, attachments, newConversation);
      if (response.conversationChanged) throw new Error("ChatGPT navigated away from the task chat. Retry to reopen it.");
      const oversized = response.errorCode === "chatgpt_input_too_long" || response.errorCode === "chatgpt_draft_blocked";
      if (msg.textAttachmentFallback !== false && oversized) {
        const name = `gateway-request-${msg.requestId.slice(0, 8)}.txt`;
        const draftUrl = response.retryDraftUrl;
        const reason = response.error;
        const files = [
          ...(draftUrl ? [] : attachments ?? []),
          { name, mimeType: "text/plain", text: userMessage },
        ];
        const instruction = `Read ${name} as the original request for this turn. Use the conversation, tool definitions, and response format specified there. Reply to the latest message or tool result. If that request calls for gateway_request_id, use ${msg.requestId}.`;
        let retry;
        try {
          if (msg.maxPromptBytes && utf8.encode(instruction).byteLength > msg.maxPromptBytes) {
            retry = { ok: false, error: "The fallback prompt exceeds the configured byte limit", errorCode: response.errorCode };
          } else {
            emitTelemetry(socket, msg, "attachment.fallback", { code: "context_length", keptDraft: !!draftUrl });
            retry = await send(instruction, files, !draftUrl && newConversation, draftUrl, true);
          }
        } catch (err) {
          retry = { ok: false, error: err.message };
        }
        response = retry.ok ? retry : {
          ...retry,
          error: `${reason}. The attachment retry failed: ${retry.error ?? "ChatGPT changed conversations"}`,
        };
      }

      sendToServer(socket, {
        type: "response",
        requestId: msg.requestId,
        ok: response.ok,
        content: response.content || "",
        error: response.error || "",
        errorCode: response.errorCode,
        oversized,
        tabId: tab.id,
        url: response.url,
      });
      return; // Success — stop trying other tabs
    } catch (err) {
      errors.push(`Tab ${tab.id}: ${err.message}`);
    } finally {
      browserRequests.delete(msg.requestId);
    }
  }

  // All tabs failed
  emitTelemetry(socket, msg, "browser.tab_unavailable");
  sendToServer(socket, {
    type: "response",
    requestId: msg.requestId,
    ok: false,
    error: `No ChatGPT tab responded (${tabs.length} tab(s) tried). Refresh chatgpt.com.\n${errors.join("\n")}`,
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "chat-progress" && msg.type !== "gateway-telemetry") return;
  const request = browserRequests.get(msg.requestId);
  if (request && sender.tab?.id === request.tabId && sender.frameId === 0) {
    if (msg.type === "gateway-telemetry") emitTelemetry(request.socket, request.msg, msg.event, msg.data, "content-script");
    else if (request.msg.streamText) sendToServer(request.socket, { type: "progress", requestId: msg.requestId, content: msg.content });
  }
});

// Connect on startup
connect();

// Reconnect on service worker events
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Keep service worker alive with periodic alarm
chrome.alarms.create("keepAlive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
  }
});

log("Service worker started");
