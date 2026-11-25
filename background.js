// ChatGPT Gateway — Background service worker
// Connects to local gateway server via WebSocket
"use strict";

const GATEWAY_URL = "ws://localhost:18790/ws";
const HEARTBEAT_INTERVAL = 20_000;
let ws = null;
let reconnectTimer = null;
const streamingRequests = new Map();

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
    sendToServer(socket, { type: "hello", capabilities: ["imageAttachments", "conversationReuse"] });
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

function userText(messages = []) {
  const content = [...messages].reverse().find(({ role }) => role === "user")?.content;
  return Array.isArray(content)
    ? content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
    : content;
}

async function handleChatMessage(msg, socket) {
  // Find a ChatGPT tab
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });

  if (tabs.length === 0) {
    sendToServer(socket, {
      type: "response",
      requestId: msg.requestId,
      ok: false,
      error: "No ChatGPT tab open. Please navigate to chatgpt.com",
    });
    return;
  }

  const userMessage = userText(msg.messages);

  if (typeof userMessage !== "string" || !userMessage) {
    sendToServer(socket, {
      type: "response",
      requestId: msg.requestId,
      ok: false,
      error: "No user message in request",
    });
    return;
  }

  const continuation = msg.continuation;
  const preferred = continuation && tabs.find((tab) => tab.id === continuation.tabId &&
    tab.url?.split(/[?#]/)[0] === continuation.url.split(/[?#]/)[0]);
  const candidates = preferred ? [preferred, ...tabs.filter((tab) => tab !== preferred)] : tabs;
  const errors = [];
  for (const tab of candidates) {
    try {
      if (msg.streamText) streamingRequests.set(msg.requestId, { socket, tabId: tab.id });
      const send = (text, attachments, newConversation, expectedConversation) => chrome.tabs.sendMessage(tab.id, {
        type: "chat",
        requestId: msg.requestId,
        model: msg.model,
        userMessage: text,
        attachments,
        streamText: msg.streamText,
        newConversation,
        expectedConversation,
      });
      let response;
      if (tab === preferred) {
        response = await send(userText(continuation.messages), continuation.attachments, false, continuation.url);
      }
      if (!response || response.conversationChanged) {
        response = await send(userMessage, msg.attachments, msg.newConversation !== false);
      }

      sendToServer(socket, {
        type: "response",
        requestId: msg.requestId,
        ok: response.ok,
        content: response.content || "",
        error: response.error || "",
        tabId: tab.id,
        url: response.url,
      });
      return; // Success — stop trying other tabs
    } catch (err) {
      if (tab === preferred) throw err;
      errors.push(`Tab ${tab.id}: ${err.message}`);
    } finally {
      streamingRequests.delete(msg.requestId);
    }
  }

  // All tabs failed
  sendToServer(socket, {
    type: "response",
    requestId: msg.requestId,
    ok: false,
    error: `No ChatGPT tab responded (${tabs.length} tab(s) tried). Refresh chatgpt.com.\n${errors.join("\n")}`,
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "chat-progress") return;
  const request = streamingRequests.get(msg.requestId);
  if (request && sender.tab?.id === request.tabId && sender.frameId === 0) {
    sendToServer(request.socket, { type: "progress", requestId: msg.requestId, content: msg.content });
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
