import { toolCallKeys, valueKey } from "../chat-history.mjs";
import { compileTools, selectTools, validatedToolCall } from "../chat-tools.mjs";

export class GatewayError extends Error {
  constructor(status, code, message, { uncertain = false, retryAfter, legacyType, recorded = false } = {}) {
    super(message);
    Object.assign(this, { status, code, uncertain, retryAfter, legacyType, recorded });
  }
}

const invalid = (message) => new GatewayError(400, "invalid_request", message, { legacyType: "invalid_request_error" });
const stale = () => new GatewayError(409, "session_reset", "A tool call is unknown in this worker session or its history changed. Start a fresh task without replaying that tool result.");
const roles = new Set(["system", "developer", "user", "assistant", "tool"]);
const allowed = ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "temperature", "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format", "seed", "stop", "frequency_penalty", "presence_penalty"];

export function prepareNativePayload(body, models) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Expected a completion object.");
  if (!models.includes(body.model)) throw invalid("Select a model enabled on the Gateway.");
  if (body.n !== undefined && body.n !== 1) throw invalid("The Gateway supports one completion choice.");
  if (body.new_conversation !== undefined || body.clientId !== undefined || body.sessionId !== undefined || body.factoryRunId !== undefined) {
    throw invalid("Select an independent conversation using its session base URL.");
  }
  try {
    const messages = body.messages ?? [];
    if (messages.length === 0 || messages.length > 4096 || messages.some(({ role }) => !roles.has(role))) throw invalid("Provide 1–4096 supported chat messages.");
    if (Array.isArray(body.tools) && body.tools.length > 128) throw invalid("Use at most 128 native tools.");
    const selection = selectTools(body);
    const validators = compileTools(selection.functions);
    const payload = Object.fromEntries(allowed.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
    return { payload, selection, validators };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw invalid("Messages and function schemas must use supported OpenAI Chat Completions formats.");
  }
}

export function checkResultHistory(messages, session, { allowPending = false } = {}) {
  const presented = new Set();
  const seen = new Set();
  const checked = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 128) throw invalid("Invalid assistant tool history.");
      const calls = toolCallKeys(message.tool_calls);
      if (calls.size !== message.tool_calls.length) throw stale();
      for (const [id, signature] of calls) {
        if (typeof id !== "string" || seen.has(id) || session.calls.get(id)?.signature !== signature) throw stale();
        seen.add(id);
        presented.add(id);
      }
    }
    if (message.role !== "tool") continue;
    const id = message.tool_call_id;
    if (!presented.delete(id)) throw stale();
    const result = valueKey(message.content ?? null);
    if (session.calls.get(id).result && session.calls.get(id).result !== result) throw stale();
    checked.push([id, result]);
  }
  if (presented.size && !allowPending) throw stale();
  return checked;
}

export function validateOutput(result, prepared, requestId, observe) {
  const failure = () => new GatewayError(502, "invalid_tool_call", "The provider returned an invalid or unrequested function call.");
  const message = result?.message;
  if (!message || (typeof message.content !== "string" && message.content !== null)) {
    throw new GatewayError(502, "invalid_response", "The provider returned an invalid assistant response.");
  }
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || calls.length > 128 || (calls.length > 1 && !prepared.selection.parallel) ||
    (!calls.length && prepared.selection.required && result.reason === "stop")) throw failure();
  const validated = calls.map((call, index) => {
    const { name, arguments: args } = call?.function ?? {};
    try {
      return validatedToolCall(name, call?.type === "function" ? args : undefined, prepared.validators, requestId, index, observe, true);
    } catch {
      throw failure();
    }
  });
  return { role: "assistant", content: message.content, ...(validated.length && { tool_calls: validated }),
    ...(typeof message.refusal === "string" && { refusal: message.refusal }) };
}

export async function readBody(req, limit, { allowEmpty = false } = {}) {
  if (Number(req.headers["content-length"]) > limit) {
    req.resume();
    throw new GatewayError(413, "context_length_exceeded", "Reduce the request body before retrying.", { legacyType: "context_length_exceeded" });
  }
  const parts = [];
  let bytes = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    bytes += part.length;
    if (bytes > limit) {
      req.resume();
      throw new GatewayError(413, "context_length_exceeded", "Reduce the request body before retrying.", { legacyType: "context_length_exceeded" });
    }
    parts.push(part);
  }
  const text = Buffer.concat(parts, bytes).toString("utf8");
  if (allowEmpty && bytes === 0) return { body: {}, bytes, characters: 0 };
  try { return { body: JSON.parse(text), bytes, characters: text.length }; }
  catch { throw new GatewayError(400, "invalid_json", "Invalid JSON"); }
}
