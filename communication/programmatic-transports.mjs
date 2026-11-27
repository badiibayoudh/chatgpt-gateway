import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, statSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { identifier } from "./config.mjs";
import { GatewayError, prepareNativePayload } from "./protocol.mjs";

const responseLimit = 2 * 1024 * 1024;
const uncertain = () => new GatewayError(503, "upstream_uncertain", "The provider did not confirm completion. Reconcile the upstream request before restarting Gateway inference.", { uncertain: true });
const malformed = () => new GatewayError(502, "invalid_response", "The provider response exceeded its limit or used an invalid completion format.");

export function openAiConfig(env, { admin, drainMs }) {
  const upstreamKey = env.CHATGPT_GATEWAY_OPENAI_API_KEY;
  if (!upstreamKey || upstreamKey === admin) throw new Error("Configure a separate authorized OpenAI project key for the Gateway");
  const stateDir = env.CHATGPT_GATEWAY_STATE_DIR ?? env.CHATGPT_GATEWAY_FACTORY_STATE_DIR;
  if (!stateDir || !isAbsolute(stateDir)) throw new Error("Configure an absolute private OpenAI transport state directory");
  const models = (env.CHATGPT_GATEWAY_MODELS ?? env.CHATGPT_GATEWAY_FACTORY_MODELS ?? "").split(",").map((model) => model.trim());
  if (models.length > 16 || models.some((model) => !identifier.test(model))) throw new Error("Configure the Gateway model allowlist");
  return { upstreamKey, stateDir, models, drainMs };
}

async function* responseText(response) {
  if (!response.body) throw malformed();
  const decoder = new TextDecoder();
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > responseLimit) throw uncertain();
    yield decoder.decode(chunk, { stream: true });
  }
  yield decoder.decode();
}

async function streamCompletion(response, progress) {
  let pending = "";
  let usage;
  let reason;
  let done = false;
  const calls = new Map();
  const message = { content: null };
  for await (const part of responseText(response)) {
    pending += part;
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { done = true; continue; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { throw uncertain(); }
      if (chunk.error) throw uncertain();
      usage = chunk.usage ?? usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      reason = choice?.finish_reason ?? reason;
      if (typeof delta?.content === "string") {
        message.content = (message.content ?? "") + delta.content;
        progress(delta.content);
      }
      if (typeof delta?.refusal === "string") message.refusal = (message.refusal ?? "") + delta.refusal;
      for (const call of delta?.tool_calls ?? []) {
        if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 128) throw uncertain();
        const aggregate = calls.get(call.index) ?? { function: { name: "", arguments: "" } };
        aggregate.type = call.type ?? aggregate.type;
        aggregate.function.name += call.function?.name ?? "";
        aggregate.function.arguments += call.function?.arguments ?? "";
        calls.set(call.index, aggregate);
      }
    }
  }
  if (!done || !reason) throw uncertain();
  if (calls.size) message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return { message, usage, reason };
}

function providerLease(directory) {
  const file = join(directory, "upstream-in-flight.json");
  return {
    ready: () => statSync(directory, { throwIfNoEntry: false })?.isDirectory() === true && !existsSync(file),
    async acquire(requestId) {
      let handle;
      try {
        handle = await open(file, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ requestId, startedAt: new Date().toISOString() }));
        await handle.sync();
        await handle.close();
      } catch {
        await handle?.close().catch(() => {});
        throw uncertain();
      }
    },
    async release() {
      try { await unlink(file); } catch { throw uncertain(); }
    },
  };
}

export function openAiTransport(config, request = fetch) {
  const lease = config.stateDir && providerLease(config.stateDir);
  let observation = { state: "unverified" };
  const startsBlocked = lease?.ready() === false;
  const observe = (state) => { observation = { state, observedAt: new Date().toISOString() }; };
  return {
    id: "openai", models: config.models,
    ready: lease?.ready,
    blocked: startsBlocked,
    availability: () => startsBlocked ? { state: "blocked" } : Date.now() - Date.parse(observation.observedAt) > 300_000 ? { state: "unverified" } : observation,
    capabilities: { programmatic: true, interactive: false, unattended: true, simulated: false, streaming: true,
      toolCalls: true, cancellation: "drain", concurrency: 1, contextLimit: "provider" },
    prepare: (payload) => prepareNativePayload(payload, config.models),
    async complete(payload, { requestId, progress, transmitted }) {
      await lease?.acquire(requestId);
      let safe = false;
      try {
        const body = JSON.stringify({ ...payload, store: false });
        transmitted(Buffer.byteLength(body), body.length);
        const response = await request("https://api.openai.com/v1/chat/completions", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(config.drainMs),
          headers: { Authorization: `Bearer ${config.upstreamKey}`, "Content-Type": "application/json" },
          body,
        });
        if (!response.ok) {
          if (response.status >= 500 || response.status === 408) {
            void response.body?.cancel().catch(() => {});
            throw uncertain();
          }
          safe = true;
          if ([401, 403, 429].includes(response.status)) observe("unavailable");
          const retry = response.headers.get("retry-after");
          if (response.status === 400) {
            try {
              let envelope = "";
              for await (const part of responseText(response)) envelope += part;
              if (JSON.parse(envelope)?.error?.code === "context_length_exceeded") {
                throw new GatewayError(413, "context_length_exceeded", "The provider rejected this context size. Reduce the task input.");
              }
            } catch (cause) {
              if (cause instanceof GatewayError && cause.code === "context_length_exceeded") throw cause;
            }
          } else void response.body?.cancel().catch(() => {});
          if (response.status === 429) throw new GatewayError(429, "upstream_rate_limit", "The authorized provider reported a rate or usage limit.", { retryAfter: /^\d{1,6}$/.test(retry ?? "") ? retry : undefined });
          if (response.status === 401 || response.status === 403) throw new GatewayError(503, "upstream_authorization", "Check the Gateway's authorized provider credentials and model access.");
          if (response.status === 413) throw new GatewayError(413, "context_length_exceeded", "The provider rejected this request size. Reduce the task context.");
          throw new GatewayError(400, "upstream_rejected", "The provider rejected the request. Verify the configured model and request capabilities.");
        }
        if (payload.stream) {
          const result = await streamCompletion(response, progress);
          safe = true;
          if (result.message && result.reason) observe("verified");
          return result;
        }
        const chunks = [];
        for await (const part of responseText(response)) chunks.push(part);
        safe = true;
        let completed;
        try { completed = JSON.parse(chunks.join("")); } catch { throw malformed(); }
        const choice = completed.choices?.[0];
        if (choice?.message && choice.finish_reason) observe("verified");
        return { message: choice?.message, reason: choice?.finish_reason, usage: completed.usage };
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw uncertain();
      } finally {
        if (safe) await lease?.release();
      }
    },
  };
}

export function mockTransport() {
  const models = ["factory-mock"];
  return {
    id: "mock", models,
    availability: () => ({ state: "simulated" }),
    capabilities: { programmatic: true, interactive: false, unattended: false, simulated: true, streaming: true,
      toolCalls: true, cancellation: "drain", concurrency: 1, contextLimit: "gateway" },
    prepare: (payload) => prepareNativePayload(payload, models),
    async complete(payload, { requestId, progress }) {
      const latest = payload.messages.at(-1);
      const prompt = latest?.content;
      await sleep(prompt === "fixture:slow" ? 420 : 25);
      if (prompt === "fixture:uncertain") throw uncertain();
      if (prompt === "fixture:rate-limit") throw new GatewayError(429, "upstream_rate_limit", "The mock provider reported a rate limit.", { retryAfter: "3" });
      if (prompt === "fixture:fail") throw malformed();
      if (latest?.role !== "tool" && payload.tools?.length && payload.tool_choice !== "none") {
        const name = payload.tool_choice?.function?.name ?? payload.tools[0].function.name;
        return { message: { content: null, tool_calls: [{ id: "call_shared_fixture", type: "function",
          function: { name, arguments: "{}" } }] }, reason: "tool_calls" };
      }
      const content = `Mock reply ${requestId}`;
      if (payload.stream) {
        progress("Mock reply ");
        await sleep(10);
        progress(requestId);
      }
      return { message: { content }, reason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
  };
}
