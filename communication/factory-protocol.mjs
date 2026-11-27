import { toolCallKeys, valueKey } from "../chat-history.mjs";
import { chatMessages, compileTools, selectTools } from "../chat-tools.mjs";

export class FactoryError extends Error {
  constructor(status, code, message, { uncertain = false, retryAfter } = {}) {
    super(message);
    Object.assign(this, { status, code, uncertain, retryAfter });
  }
}

const invalid = (message) => new FactoryError(400, "invalid_request", message);
const stale = () => new FactoryError(409, "session_reset", "A tool call is unknown in this worker session or its history changed. Start a fresh task without replaying that tool result.");
const roles = new Set(["system", "developer", "user", "assistant", "tool"]);
const allowed = ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "temperature", "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format", "seed", "stop", "frequency_penalty", "presence_penalty"];

export function prepareFactoryPayload(body, models) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Expected a completion object.");
  if (!models.includes(body.model)) throw invalid("Select a model enabled on the factory Gateway.");
  if (body.n !== undefined && body.n !== 1) throw invalid("The factory Gateway supports one completion choice.");
  if (body.new_conversation !== undefined || body.clientId !== undefined || body.sessionId !== undefined || body.factoryRunId !== undefined) {
    throw invalid("Factory ownership is configured with a scoped credential. Start a new worker profile for a new session.");
  }
  try {
    const messages = chatMessages(body);
    if (messages.length === 0 || messages.length > 4096 || messages.some(({ role }) => !roles.has(role))) throw invalid("Provide 1–4096 supported chat messages.");
    if (Array.isArray(body.tools) && body.tools.length > 128) throw invalid("Use at most 128 native tools.");
    const selection = selectTools(body);
    const validators = compileTools(selection.functions);
    const payload = Object.fromEntries(allowed.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
    return { payload, selection, validators };
  } catch (error) {
    if (error instanceof FactoryError) throw error;
    throw invalid("Messages and function schemas must use supported OpenAI Chat Completions formats.");
  }
}

export function checkResultHistory(messages, session) {
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
  if (presented.size) throw stale();
  return checked;
}

export function validateOutput(result, prepared, requestId, observe) {
  const failure = () => new FactoryError(502, "invalid_tool_call", "The provider returned an invalid or unrequested function call.");
  const message = result?.message;
  if (!message || (typeof message.content !== "string" && message.content !== null)) {
    throw new FactoryError(502, "invalid_response", "The provider returned an invalid assistant response.");
  }
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || calls.length > 128 || (calls.length > 1 && !prepared.selection.parallel) ||
    (!calls.length && prepared.selection.required && result.reason === "stop")) throw failure();
  const validated = calls.map((call, index) => {
    const { name, arguments: args } = call?.function ?? {};
    observe("tool.requested", name);
    try {
      if (call?.type !== "function" || typeof args !== "string") throw failure();
      const parameters = JSON.parse(args);
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || !prepared.validators.get(name)?.(parameters)) throw failure();
    } catch {
      observe("tool.validation_failed", name);
      throw failure();
    }
    observe("tool.validated", name);
    return { id: `call_${requestId.replaceAll("-", "")}_${index}`, type: "function", function: { name, arguments: args } };
  });
  return { role: "assistant", content: message.content, ...(validated.length && { tool_calls: validated }),
    ...(typeof message.refusal === "string" && { refusal: message.refusal }) };
}

export async function readFactoryBody(req, limit) {
  if (Number(req.headers["content-length"]) > limit) {
    req.resume();
    throw new FactoryError(413, "context_length", "Reduce the request body before retrying.");
  }
  const parts = [];
  let bytes = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    bytes += part.length;
    if (bytes > limit) {
      req.resume();
      throw new FactoryError(413, "context_length", "Reduce the request body before retrying.");
    }
    parts.push(part);
  }
  const text = Buffer.concat(parts, bytes).toString("utf8");
  try { return { body: JSON.parse(text), bytes, characters: text.length }; }
  catch { throw new FactoryError(400, "invalid_json", "Expected a valid JSON completion request."); }
}
