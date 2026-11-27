import { WebSocket, WebSocketServer } from "ws";
import { prepareChat } from "../chat-tools.mjs";
import { conversationKey, describeHistory, messageKey, newMessages, toolCallKeys } from "../chat-history.mjs";
import { browserError, monitorCapabilities, safeName } from "../monitoring/events.mjs";
import { GatewayError } from "./protocol.mjs";

const MAX_BROWSER_WAIT = 240_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TRACKED_CHATS = 100;
const monitorScope = (worker, chat) => worker.legacy ? chat : worker.scope;

export function browserTransport(settings, monitor) {
  const extensionCapabilities = new WeakMap();
  const conversations = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
  let extensionWs;
  let activeRequest;
  const metrics = {
    browserReplies: 0, lastBrowserReplyMs: null,
    outgoingPromptCharacters: 0, outgoingPromptBytes: 0, fullHistoryRequests: 0,
    continuationRequests: 0, conversationReuseSuccesses: 0, toolDefinitionRequests: 0, toolDefinitionReuses: 0,
    imageAttachmentCount: 0, textAttachmentFallbackCount: 0, textAttachmentBytes: 0,
    oversizedRequestCount: 0, uploadAllowanceErrors: 0, fullContextBaselineBytes: 0,
    historyMatches: { explicit_new: 0, no_tracked_chat: 0, model_mismatch: 0, no_reliable_match: 0, ambiguous: 0,
      exact_history: 0, verified_tool_anchor: 0 },
  };

  wss.on("connection", (ws) => {
    extensionWs = ws;
    monitor.emit("gateway.extension_connected");
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === "hello" && Array.isArray(msg.capabilities)) {
        extensionCapabilities.set(ws, new Set(msg.capabilities));
        if (ws === extensionWs) monitor.emit("gateway.extension_capabilities", null, { capabilities: observedCapabilities() });
        return;
      }
      const request = activeRequest;
      const matches = request?.socket === ws && request.requestId === msg?.requestId;
      if (msg?.type === "telemetry" && monitor.enabled) {
        const valid = matches && msg.version === 1 && raw.length <= 64 * 1024 && extensionCapabilities.get(ws)?.has("telemetryV1");
        monitor.extension(valid ? msg.requestId : null, valid ? msg.events : null);
      } else if (matches && msg.type === "response") {
        monitor.emit("browser.reply_relayed", request.requestId, { ok: msg.ok === true });
        if (msg.oversized === true || isOversizedError(msg.errorCode)) recordOversized();
        if (msg.errorCode === "chatgpt_upload_allowance") metrics.uploadAllowanceErrors++;
        metrics.browserReplies++;
        metrics.lastBrowserReplyMs = Date.now() - request.startedAt;
        request.settle(msg);
      } else if (matches && msg.type === "chat-transmission") {
        recordTransmission(msg);
      } else if (matches && msg.type === "progress" && request.streamText && typeof msg.content === "string") {
        request.progress(msg.content);
      }
    });
    ws.once("close", () => {
      if (extensionWs === ws) {
        extensionWs = undefined;
        monitor.emit("gateway.extension_disconnected");
      }
      if (activeRequest?.socket === ws) activeRequest.settle({ disconnected: true });
    });
  });

  function observedCapabilities() {
    return monitorCapabilities(extensionCapabilities.get(extensionWs));
  }
  function matchContinuation(payload, message, history, owner) {
    if (payload.new_conversation === true) return { reason: "explicit_new" };
    const known = [...conversations.values()].filter((previous) => previous.owner === owner);
    if (!known.length) return { reason: "no_tracked_chat" };
    const matches = [];
    let hasModel = false;
    for (const previous of known) {
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

  function prepareBrowserChat(payload, message, capabilities, worker) {
    const history = describeHistory(payload.messages);
    const match = matchContinuation(payload, message, history, worker.scope);
    metrics.historyMatches[match.reason]++;
    monitor.emit(match.previous ? "context.matched" : "context.reuse_missed", message.requestId, { reason: match.reason }, "gateway", monitorScope(worker, conversationKey(match.previous?.url)));
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
      streamText: !!worker.legacy && payload.stream === true && chat.streamText,
      textAttachmentFallback: !!worker.legacy && settings.textAttachmentFallback,
      ...(!worker.legacy && { scopedConversation: true }),
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

  function observePrepared(requestId, payload, prepared, context, worker) {
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
      if (worker.legacy) monitor.resultsObserved(requestId, conversationKey(outgoing.continuation?.url), results);
    } catch { /* Monitoring must not change request dispatch. */ }
  }

  function rememberConversation(model, result, { content, toolCalls }, toolsKey, worker) {
    const key = conversationKey(result.url);
    if (!Number.isInteger(result.tabId) || !key) return;
    const assistant = { role: "assistant", content, tool_calls: toolCalls };
    const { keys, instructionsKey } = result.history;
    conversations.delete(key);
    conversations.set(key, {
      tabId: result.tabId, url: result.url, model, instructionsKey, toolsKey, owner: worker.scope,
      keys: [...keys, messageKey(assistant)],
      calls: toolCallKeys(toolCalls),
    });
    if (conversations.size > MAX_TRACKED_CHATS) conversations.delete(conversations.keys().next().value);
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

  function extensionUnavailable() {
    return new GatewayError(503, "extension_unavailable", "Extension not connected. Load the extension and open chatgpt.com");
  }

  function browserFailure(result, worker) {
    const message = typeof result.error === "string" ? result.error : "ChatGPT did not return a reply";
    if (isOversizedError(result.errorCode)) {
      return new GatewayError(413, "context_length_exceeded", `${message}. Send a smaller file selection, tool result, or task.`,
        { legacyType: "context_length_exceeded", recorded: true });
    }
    if (result.errorCode === "chatgpt_upload_allowance") {
      return new GatewayError(429, "upload_allowance_exceeded", "ChatGPT reported that its upload allowance was reached.", { legacyType: "upload_allowance_exceeded" });
    }
    const code = result.monitorCode ?? browserError(result.errorCode, message);
    return new GatewayError(500, code, worker.legacy ? message : "The browser turn failed. Check the active ChatGPT tab before retrying.");
  }

  function capture(worker) {
    const socket = extensionWs;
    if (socket?.readyState !== WebSocket.OPEN) throw extensionUnavailable();
    if (!worker.legacy && !extensionCapabilities.get(socket)?.has("scopedConversations")) {
      throw new GatewayError(503, "extension_upgrade", "Reload the Gateway extension and refresh ChatGPT to enable isolated interactive sessions.");
    }
    return socket;
  }

  async function complete(payload, { requestId, worker, context, connection: socket, progress, cancelled }) {
    if (socket?.readyState !== WebSocket.OPEN) throw extensionUnavailable();
    const capabilities = extensionCapabilities.get(socket);
    const message = { type: "chat", requestId, model: payload.model || "auto" };
    let prepared;
    try {
      prepared = prepareBrowserChat(payload, message, capabilities, worker);
    } catch (error) {
      if (error.code === "image_budget_exceeded") metrics.oversizedRequestCount++;
      throw new GatewayError(400, error.code === "image_budget_exceeded" ? "image_budget" : "invalid_request",
        error.message, { legacyType: "invalid_request_error" });
    }
    if (prepared.attachmentsNeedSupport) {
      throw new GatewayError(503, "extension_upgrade", "Reload the updated browser extension and refresh ChatGPT to enable image attachments");
    }
    const { chat, outgoing, history } = prepared;
    const prompt = chat.messages[0]?.content;
    const promptStats = { promptCharacters: typeof prompt === "string" ? prompt.length : 0,
      promptBytes: typeof prompt === "string" ? Buffer.byteLength(prompt) : 0, images: chat.attachments.length, textBytes: 0 };
    if (settings.maxPromptBytes && promptStats.promptBytes > settings.maxPromptBytes) {
      throw new GatewayError(413, "context_length_exceeded",
        `Browser prompt exceeds ${settings.maxPromptBytes} bytes. Send a smaller file selection, tool result, or task.`, { legacyType: "context_length_exceeded" });
    }
    if ((!settings.textAttachmentFallback || settings.maxPromptBytes) && !capabilities?.has("attachmentPolicy")) {
      throw new GatewayError(503, "extension_upgrade", "Reload the updated extension to enforce the configured browser prompt and attachment policy");
    }
    const continuedChat = conversationKey(outgoing.continuation?.url);
    let streamed = "";
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => socket.terminate(), MAX_BROWSER_WAIT);
      const settle = (result) => {
        if (activeRequest?.requestId !== requestId) return;
        clearTimeout(timer);
        activeRequest = undefined;
        resolve(result);
      };
      activeRequest = { socket, requestId, startedAt: Date.now(), streamText: outgoing.streamText, baselineBytes: context.baselineBytes, settle,
        progress(content) {
          if (cancelled() || content === streamed || !content.startsWith(streamed)) return;
          progress(content.slice(streamed.length));
          streamed = content;
        } };
      observePrepared(requestId, payload, prepared, context, worker);
      metrics[outgoing.continuation ? "continuationRequests" : "fullHistoryRequests"]++;
      if (chat.hasTools) metrics.toolDefinitionRequests++;
      if (chat.toolsReused) metrics.toolDefinitionReuses++;
      if (!capabilities?.has("contextMetrics")) recordTransmission(promptStats);
      socket.send(JSON.stringify(outgoing), (error) => {
        if (error) socket.terminate();
      });
    });
    if (cancelled() || !result.ok) {
      if (continuedChat) conversations.delete(continuedChat);
      if (cancelled()) return null;
      if (result.disconnected) throw extensionUnavailable();
      throw browserFailure(result, worker);
    }
    const key = conversationKey(result.url);
    const knownOwner = conversations.get(key)?.owner;
    if ((knownOwner && knownOwner !== worker.scope) ||
      (!worker.legacy && (!key || !Number.isInteger(result.tabId) || (continuedChat && continuedChat !== key)))) {
      if (continuedChat) conversations.delete(continuedChat);
      throw new GatewayError(502, "conversation_conflict", "The extension could not confirm the correct isolated browser conversation.");
    }
    let decoded;
    try {
      if (typeof result.content !== "string") throw new Error("ChatGPT did not return text content");
      decoded = chat.decode(result.content, (event, name) => monitor.emit(event, requestId, { name: safeName(name) ?? "redacted" }));
      if (streamed && !decoded.content?.startsWith(streamed)) throw new Error("ChatGPT revised the streamed text. Retry for the complete reply.");
    } catch (error) {
      if (continuedChat) conversations.delete(continuedChat);
      const code = streamed ? "revised_response" : chat.hasTools ? "invalid_tool_call" : "invalid_response";
      throw new GatewayError(502, code, error.message, { legacyType: streamed ? "revised_response" : "invalid_tool_call" });
    }
    rememberConversation(message.model, { ...result, history }, decoded, chat.toolsKey, worker);
    if (continuedChat && continuedChat === key) {
      metrics.conversationReuseSuccesses++;
      monitor.emit("context.reused", requestId);
    }
    return { message: { role: "assistant", content: decoded.content, ...(decoded.toolCalls && { tool_calls: decoded.toolCalls }) },
      reason: decoded.toolCalls ? "tool_calls" : "stop", scope: monitorScope(worker, key) };
  }

  return {
    id: "browser", models: ["auto"], legacyInteractive: true,
    capabilities: { programmatic: true, interactive: true, unattended: false, simulated: false, streaming: true, toolCalls: true,
      cancellation: "drain", concurrency: 1, contextLimit: "browser" },
    availability: () => ({ state: extensionWs?.readyState === WebSocket.OPEN ? "connected" : "disconnected" }),
    legacyHealth: () => {
      const caps = extensionCapabilities.get(extensionWs);
      return { extensionConnected: extensionWs?.readyState === WebSocket.OPEN, imageAttachments: caps?.has("imageAttachments") ?? false,
        conversationReuse: caps?.has("conversationReuse") ?? false,
        longMessageFallback: settings.textAttachmentFallback && (caps?.has("longMessageFallback") ?? false) };
    },
    scopedReady: () => extensionCapabilities.get(extensionWs)?.has("scopedConversations") ?? false,
    metrics: () => metrics, observedCapabilities,
    upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)),
    capture, prepare: (payload) => ({ payload }), complete,
  };
}
