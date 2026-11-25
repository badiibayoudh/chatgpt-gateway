import { createHash } from "node:crypto";

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

export function valueKey(value) {
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
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
  return valueKey({
    role, content: content ?? "", calls, tool_call_id, name,
  });
}

export function describeHistory(messages = []) {
  const conversation = [];
  const instructions = [];
  for (const message of messages) {
    const { role } = message;
    (role === "system" || role === "developer" ? instructions : conversation).push(message);
  }
  return { conversation, instructions, keys: conversation.map(messageKey), instructionsKey: valueKey(instructions) };
}

export function newMessages(history, previous) {
  const { conversation, instructions, keys, instructionsKey } = history;
  let anchor = -1;
  if (keys.length > previous.keys.length && previous.keys.every((key, index) => keys[index] === key)) {
    anchor = previous.keys.length - 1;
  } else if (previous.callIds.length) {
    // A gateway-issued call ID survives Cline's serialization and history compaction.
    anchor = conversation.findLastIndex(({ role, tool_calls }) => role === "assistant" &&
      Array.isArray(tool_calls) && tool_calls.length === previous.callIds.length &&
      previous.callIds.every((id) => tool_calls.some((call) => call?.id === id)));
  }
  if (anchor === -1) return null;
  const suffix = conversation.slice(anchor + 1);
  if (!suffix.some(({ role }) => role === "user" || role === "tool")) return null;
  const priorCall = previous.callIds.length && suffix[0].role === "tool" ? [conversation[anchor]] : [];
  return [...(instructionsKey === previous.instructionsKey ? [] : instructions), ...priorCall, ...suffix];
}

export function conversationKey(url) {
  const match = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)((?:\/g\/[^/?#]+)?\/c\/[^/?#]+)\/?(?:[?#].*)?$/i.exec(url ?? "");
  return match?.[1] ?? null;
}
