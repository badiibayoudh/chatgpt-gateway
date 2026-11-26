import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { textContext } from "./chat-input.mjs";

function integerSetting(name) {
  const value = Number(process.env[name] ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function booleanSetting(name) {
  const value = process.env[name]?.toLowerCase() ?? "true";
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

export function contextSettings() {
  return {
    maxPromptBytes: integerSetting("CHATGPT_GATEWAY_MAX_PROMPT_BYTES"),
    maxContextTokens: integerSetting("CHATGPT_GATEWAY_MAX_CONTEXT_TOKENS"),
    textAttachmentFallback: booleanSetting("CHATGPT_GATEWAY_TEXT_ATTACHMENT_FALLBACK"),
    includeHistoricalImages: booleanSetting("CHATGPT_GATEWAY_INCLUDE_HISTORICAL_IMAGES"),
  };
}

export function estimateTokens(text) {
  return countTokens(text, { disallowedSpecial: new Set() });
}

export function clientContext(payload) {
  const { messages, imageCount } = textContext(payload.messages ?? []);
  const tools = payload.tools?.length ? payload.tools : undefined;
  const context = { messages, tools };
  const baseline = !tools && messages.length === 1 && messages[0].role === "user" && typeof messages[0].content === "string"
    ? messages[0].content : JSON.stringify(context, null, 2);
  // Browser-side vision accounting is private. Reserve a fixed estimate per image.
  const tokens = estimateTokens(JSON.stringify(context)) + imageCount * 1024;
  return { tokens, baselineBytes: Buffer.byteLength(baseline) };
}
