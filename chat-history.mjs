import { createHash } from "node:crypto";

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

export function messageKey({ role, content, tool_calls, tool_call_id, name }) {
  if (Array.isArray(content) && content.every((part) => part?.type === "text")) {
    content = content.map((part) => part.text).join("\n");
  }
  const calls = Array.isArray(tool_calls) && tool_calls.length ? tool_calls.map((call) => {
    const fn = call?.function;
    let args = fn?.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { /* Keep the original arguments. */ }
    }
    return { id: call?.id, name: fn?.name, args };
  }) : undefined;
  return createHash("sha256").update(JSON.stringify(ordered({
    role, content: content ?? "", calls, tool_call_id, name,
  }))).digest("hex");
}

export function conversationMessages(messages = []) {
  return messages.filter(({ role }) => role !== "system" && role !== "developer");
}

export function newMessages(messages, previousKeys) {
  const conversation = conversationMessages(messages);
  if (conversation.length <= previousKeys.length ||
    previousKeys.some((key, index) => messageKey(conversation[index]) !== key)) return null;
  const suffix = conversation.slice(previousKeys.length);
  if (!suffix.some(({ role }) => role === "user" || role === "tool")) return null;
  const instructions = messages.filter(({ role }) => role === "system" || role === "developer");
  const previous = conversation[previousKeys.length - 1];
  // Give tool results the IDs assigned by the gateway for the previous calls.
  const toolCalls = previous?.tool_calls?.length && suffix[0].role === "tool" ? [previous] : [];
  return [...instructions, ...toolCalls, ...suffix];
}

export function conversationKey(url) {
  const match = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)((?:\/g\/[^/?#]+)?\/c\/[^/?#]+)\/?(?:[?#].*)?$/i.exec(url ?? "");
  return match?.[1] ?? null;
}
