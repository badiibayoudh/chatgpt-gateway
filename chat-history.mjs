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
  const calls = Array.isArray(tool_calls) && tool_calls.length ? tool_calls.map(toolCallSignature) : undefined;
  return valueKey({
    role, content: content ?? "", calls, tool_call_id, name,
  });
}

function toolCallSignature(call) {
  const fn = call?.function;
  let args = fn?.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* Keep the original arguments. */ }
  }
  return { id: call?.id, name: fn?.name, args };
}

export function toolCallKeys(calls = []) {
  return new Map(calls.map((call) => [call.id, valueKey(toolCallSignature(call))]));
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

function findToolAnchor(conversation, expected) {
  if (!expected.size) return null;
  let first = 0;
  let seen = new Set();
  for (const [index, { role, tool_calls: calls }] of conversation.entries()) {
    if (role !== "assistant" || !Array.isArray(calls) || !calls.length ||
      calls.some((call) => !expected.has(call?.id) || expected.get(call.id) !== valueKey(toolCallSignature(call)))) {
      seen.clear();
      continue;
    }
    if (!seen.size) first = index;
    for (const call of calls) seen.add(call.id);
    if (seen.size === expected.size) return { first, end: index + 1 };
  }
  return null;
}

export function newMessages(history, previous) {
  const { conversation, instructions, keys, instructionsKey } = history;
  const exact = keys.length > previous.keys.length && previous.keys.every((key, index) => keys[index] === key);
  const anchor = exact
    ? { first: previous.keys.length - 1, end: previous.keys.length }
    : findToolAnchor(conversation, previous.calls);
  if (!anchor) return null;
  const suffix = conversation.slice(anchor.end);
  if (!exact && suffix.some(({ role }) => role === "assistant")) return null;
  if (!suffix.some(({ role }) => role === "user" || role === "tool")) return null;
  let hasToolResults = false;
  for (const message of suffix) {
    if (message.role === "assistant") break;
    if (message.role !== "tool") continue;
    if (!previous.calls.has(message.tool_call_id)) return null;
    hasToolResults = true;
  }
  const priorCalls = hasToolResults ? conversation.slice(anchor.first, anchor.end) : [];
  return {
    reason: exact ? "exact_history" : "verified_tool_anchor",
    strong: previous.calls.size > 0,
    messages: [...(instructionsKey === previous.instructionsKey ? [] : instructions), ...priorCalls, ...suffix],
  };
}

export function conversationKey(url) {
  const match = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)((?:\/g\/[^/?#]+)?\/c\/[^/?#]+)\/?(?:[?#].*)?$/i.exec(url ?? "");
  return match?.[1] ?? null;
}
