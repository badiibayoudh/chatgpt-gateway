import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const tokenPattern = /^[a-zA-Z0-9_-]{24,128}$/;
const roles = ["planner", "architect", "developer", "reviewer", "test-analyst"];
export const digest = (text) => createHash("sha256").update(text).digest("hex");

export function factoryConfig(env) {
  const mode = env.CHATGPT_GATEWAY_FACTORY_TRANSPORT;
  if (!mode) return null;
  if (!["mock", "openai"].includes(mode)) throw new Error("Invalid factory transport mode");
  const admin = env.CHATGPT_GATEWAY_API_KEY;
  if (!tokenPattern.test(admin ?? "")) throw new Error("Factory mode requires a separate high-entropy gateway admin key");
  const upstreamKey = env.CHATGPT_GATEWAY_OPENAI_API_KEY;
  if (mode === "openai" && (!upstreamKey || upstreamKey === admin)) throw new Error("Configure a separate authorized OpenAI project key for the Gateway");
  const stateDir = env.CHATGPT_GATEWAY_FACTORY_STATE_DIR;
  if (mode === "openai" && (!stateDir || !isAbsolute(stateDir))) throw new Error("Configure an absolute private factory transport state directory");
  const models = mode === "mock" ? ["factory-mock"] : (env.CHATGPT_GATEWAY_FACTORY_MODELS ?? "").split(",").map((model) => model.trim());
  if (!models.length || models.length > 16 || models.some((model) => !identifier.test(model))) throw new Error("Configure the factory model allowlist");
  let profiles;
  try { profiles = JSON.parse(env.CHATGPT_GATEWAY_FACTORY_CLIENTS); } catch { throw new Error("Configure factory client profiles as a JSON array"); }
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 32) throw new Error("Configure 1–32 factory client profiles");
  const epoch = randomUUID();
  const byToken = new Map();
  const owners = new Set();
  for (const profile of profiles) {
    const { token, clientId, sessionId, factoryRunId, role } = profile ?? {};
    const ids = [clientId, sessionId, factoryRunId];
    if (typeof token !== "string" || !tokenPattern.test(token) || token === admin || token === upstreamKey ||
      ids.some((id) => typeof id !== "string" || !identifier.test(id)) || !roles.includes(role)) throw new Error("Invalid factory client profile");
    const key = digest(token);
    const owner = `${clientId}/${sessionId}`;
    if (byToken.has(key) || owners.has(owner)) throw new Error("Duplicate factory client credentials or session ownership");
    // Deployment-owned metadata never comes from chat payloads or correlation headers.
    byToken.set(key, { clientId, role, runTag: digest(`${epoch}/${factoryRunId}`).slice(0, 16), scope: `${epoch}/${owner}` });
    owners.add(owner);
  }
  const number = (name, fallback, min, max) => {
    const value = Number(env[`CHATGPT_GATEWAY_FACTORY_${name}`] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid factory setting ${name}`);
    return value;
  };
  return { mode, upstreamKey, stateDir, models, byToken,
    maxQueued: number("MAX_QUEUED", 8, 1, 32),
    maxPerClient: number("MAX_PER_CLIENT", 2, 1, 8),
    maxBody: number("MAX_BODY_BYTES", 4 * 1024 * 1024, 1024, 8 * 1024 * 1024),
    queueMs: number("QUEUE_MS", 120_000, 10, 300_000),
    processMs: number("PROCESS_MS", 300_000, 10, 600_000),
    drainMs: number("DRAIN_MS", 360_000, 100, 900_000),
    sessionMs: number("SESSION_MS", 3_600_000, 30_000, 86_400_000),
  };
}

export function workerFor(config, authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return tokenPattern.test(token) ? config.byToken.get(digest(token)) : null;
}
