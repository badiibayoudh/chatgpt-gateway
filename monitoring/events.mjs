export const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const isNumber = (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const isBool = (value) => typeof value === "boolean";
const oneOf = (...values) => (value) => values.includes(value);
export const outcomes = ["completed", "failed", "cancelled", "timed_out"];
export const states = ["received", "queued", "dispatched", "processing", ...outcomes];
export const reasons = ["explicit_new", "no_tracked_chat", "model_mismatch", "no_reliable_match", "ambiguous", "exact_history", "verified_tool_anchor"];
export const errors = {
  invalid_json: "The client body was not valid JSON.", invalid_request: "The gateway rejected the request input.",
  context_length: "The request exceeded a context or message limit.", image_budget: "The request exceeded the gateway image allowance.",
  extension_unavailable: "The browser extension was disconnected or unavailable.", extension_upgrade: "The installed extension lacks a required capability.",
  extension_send: "The request could not be sent to the browser extension.", browser_error: "The browser turn did not complete successfully.",
  browser_unavailable: "The extension could not find a usable ChatGPT tab.", navigation_changed: "The ChatGPT chat changed during the turn.",
  upload_allowance: "ChatGPT reported that its upload allowance was reached.", upload_unconfirmed: "The extension could not confirm an attachment upload.",
  response_unavailable: "The extension could not extract the ChatGPT response.", invalid_tool_call: "The model tool response failed validation.",
  invalid_response: "The model response could not be decoded.", revised_response: "ChatGPT revised text that was already streamed.",
  queue_timeout: "The client timed out while waiting for the browser slot.", browser_timeout: "The client timed out while waiting for the browser response.",
  client_disconnected: "The client closed the response connection.", client_cancelled: "The client cancelled the request.",
  processing_timeout: "The factory request exceeded the provider processing deadline.",
  session_reset: "The tool history could not be verified in this factory session.",
  upstream_uncertain: "Provider completion could not be confirmed. Factory dispatch is paused.",
  upstream_rate_limit: "The provider reported a rate or usage limit.", upstream_rejected: "The provider rejected the request.",
  upstream_authorization: "The provider denied access to the configured project or model.",
};
const code = (value) => Object.hasOwn(errors, value);
const knownCaps = ["imageAttachments", "conversationReuse", "longMessageFallback", "continuationOnly", "attachmentPolicy", "contextMetrics", "telemetryV1"];
export const monitorCapabilities = (values) => knownCaps.filter((capability) => values?.has(capability));
export function safeName(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/i.test(value) ||
    /(?:^|[-_])(?:sk|ghp|gho|github_pat|xox[baprs]|bearer|secret|token)(?:[-_]|$)/i.test(value) || /[a-z\d]{25,}/i.test(value)) return undefined;
  return value;
}
export function safeModel(value) {
  if (typeof value !== "string") return undefined;
  return /^(?:auto|chatgpt-web|gpt-[\d.]+(?:-(?:mini|nano|turbo|pro|codex|latest|chat|\d{4}-\d\d-\d\d))*|o[1-9](?:-(?:mini|pro|\d{4}-\d\d-\d\d))?)$/i.test(value) ? value : "custom model";
}
const count = { count: isNumber };
const attachment = { kind: oneOf("image", "text"), bytes: isNumber, code };
const tool = { name: (value) => safeName(value) === value, callId: (value) => typeof value === "string" && /^[\da-f]{16}$/.test(value),
  originRequestId: (value) => typeof value === "string" && uuid.test(value), elapsedMs: isNumber };
const sizes = { incomingBytes: isNumber, incomingCharacters: isNumber, logicalBytes: isNumber,
  incomingMessages: isNumber, estimatedInputTokens: isNumber };

// Only fields declared here enter memory, JSONL, or HTTP responses.
export const schemas = {
  "gateway.started": {}, "gateway.extension_connected": {}, "gateway.extension_disconnected": {},
  "gateway.extension_capabilities": { capabilities: (value) => Array.isArray(value) && value.length <= knownCaps.length && value.every((cap) => knownCaps.includes(cap)) },
  "request.received": { role: oneOf("planner", "architect", "developer", "reviewer", "test-analyst"), transport: oneOf("mock", "openai"),
    runTag: (value) => typeof value === "string" && /^[a-f0-9]{16}$/.test(value) }, "request.input": { ...sizes, model: (value) => safeModel(value) === value },
  "request.queued": {}, "request.dispatched": {}, "request.completed": { estimatedOutputTokens: isNumber },
  "request.failed": { code }, "request.cancelled": { code }, "request.timed_out": { code },
  "context.matched": { reason: oneOf(...reasons) }, "context.reuse_missed": { reason: oneOf(...reasons) },
  "context.prepared": { mode: oneOf("full", "continuation"), preparedTextBytes: isNumber, fullTextBytes: isNumber,
    forwardedMessages: isNumber, exposedTools: isNumber, toolDefinitionBytes: isNumber, toolsReused: isBool },
  "context.transmitted": { forwardedTextBytes: isNumber, forwardedCharacters: isNumber, textAttachmentBytes: isNumber, fallback: isBool },
  "context.reused": {},
  "transport.started": {}, "transport.finished": {}, "transport.usage": { authoritative: isBool, input: isNumber, output: isNumber },
  "transport.transmitted": { wireBytes: isNumber, wireCharacters: isNumber },
  "browser.tab_located": {}, "browser.tab_unavailable": {}, "browser.prompt_submitted": {},
  "browser.generation_detected": {}, "browser.response_received": { characters: isNumber },
  "browser.reply_relayed": { ok: isBool }, "browser.prompt_rejected": { code },
  "attachment.prepared": { images: isNumber, historicalImages: isNumber, bytes: isNumber },
  "attachment.attempted": attachment, "attachment.accepted": attachment, "attachment.failed": attachment,
  "attachment.skipped": { ...count, kind: oneOf("image", "text") },
  "attachment.fallback": { code, keptDraft: isBool },
  "tool.exposed": tool, "tool.requested": tool, "tool.validated": tool, "tool.validation_failed": tool,
  "tool.forwarded": tool, "tool.result_received": tool, "tool.result_unmatched": count,
  "response.decoded": {}, "response.client_finished": {}, "response.client_disconnected": {},
};

export const components = ["gateway", "background", "content-script", "monitoring"];
export const levels = ["debug", "info", "warn", "error"];
const browserEvents = {
  background: ["browser.tab_located", "browser.tab_unavailable", "attachment.fallback"],
  "content-script": ["browser.prompt_submitted", "browser.generation_detected", "browser.response_received", "browser.prompt_rejected",
    "attachment.attempted", "attachment.accepted", "attachment.failed"],
};

export function eventData(event, data, { strict = false, component } = {}) {
  if (!Object.hasOwn(schemas, event) || !data || typeof data !== "object" || Array.isArray(data)) return null;
  if (strict && !browserEvents[component]?.includes(event)) return null;
  const shape = schemas[event];
  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined && !strict) continue;
    if (Object.hasOwn(shape, key) && shape[key](value)) clean[key] = value;
    else if (strict || Object.hasOwn(shape, key)) return null;
  }
  if (strict && ["attachment.attempted", "attachment.accepted", "attachment.failed"].includes(event) && !clean.kind) return null;
  if (strict && ["browser.prompt_rejected", "attachment.fallback"].includes(event) && !clean.code) return null;
  return clean;
}

export function eventLevel(event) {
  if (event === "request.failed" || event === "tool.validation_failed" || event === "attachment.failed") return "error";
  if (/rejected|unavailable|timed_out|fallback|disconnected/.test(event)) return "warn";
  return "info";
}

export function browserError(code, message) {
  if (code === "chatgpt_upload_allowance") return "upload_allowance";
  if (code === "chatgpt_input_too_long" || code === "chatgpt_draft_blocked") return "context_length";
  if (/confirm upload|file input|attachment menu|attachment composer/i.test(message ?? "")) return "upload_unconfirmed";
  if (/timeout:|extract/i.test(message ?? "")) return "response_unavailable";
  if (/conversation changed|navigated away/i.test(message ?? "")) return "navigation_changed";
  if (/no chatgpt tab|could not reopen/i.test(message ?? "")) return "browser_unavailable";
  return "browser_error";
}
