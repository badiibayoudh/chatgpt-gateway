import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export const tokenPattern = /^[a-zA-Z0-9_-]{24,128}$/;
export const roles = ["planner", "architect", "developer", "reviewer", "test-analyst"];
export const digest = (text) => createHash("sha256").update(text).digest("hex");

export function apiKeyMatches(key, authorization) {
  if (!key || typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${key}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function workerProfile(epoch, { clientId, sessionId, factoryRunId, role }) {
  return { clientId, role, runTag: digest(`${epoch}/${factoryRunId}`).slice(0, 16), scope: `${epoch}/${clientId}/${sessionId}` };
}

export function gatewayConfig(env) {
  const mode = env.CHATGPT_GATEWAY_TRANSPORT ?? env.CHATGPT_GATEWAY_FACTORY_TRANSPORT ?? "browser";
  const browser = mode === "browser";
  const admin = env.CHATGPT_GATEWAY_API_KEY;
  const scopedManagement = tokenPattern.test(admin ?? "");
  const strict = (env.CHATGPT_GATEWAY_REQUIRE_SCOPED_CLIENTS ?? "false").toLowerCase();
  if (!["true", "false", "1", "0"].includes(strict)) throw new Error("CHATGPT_GATEWAY_REQUIRE_SCOPED_CLIENTS must be true or false");
  const requireScoped = !browser || ["true", "1"].includes(strict);
  if (requireScoped && !scopedManagement) throw new Error("Scoped clients require a separate high-entropy Gateway admin key");
  const upstreamKey = env.CHATGPT_GATEWAY_OPENAI_API_KEY;
  let profiles;
  try { profiles = JSON.parse(env.CHATGPT_GATEWAY_CLIENTS ?? env.CHATGPT_GATEWAY_FACTORY_CLIENTS ?? "[]"); }
  catch { throw new Error("Configure Gateway client profiles as a JSON array"); }
  if (!Array.isArray(profiles) || profiles.length > 32 || (profiles.length && !scopedManagement)) throw new Error("Configure at most 32 scoped client profiles with a strong Gateway admin key");
  const epoch = randomUUID();
  const byToken = new Map();
  const owners = new Set();
  for (const profile of profiles) {
    const { token, clientId, sessionId, factoryRunId, role } = profile ?? {};
    const ids = [clientId, sessionId, factoryRunId];
    if (typeof token !== "string" || !tokenPattern.test(token) || token === admin || token === upstreamKey ||
      ids.some((id) => typeof id !== "string" || !identifier.test(id)) || !roles.includes(role)) throw new Error("Invalid Gateway client profile");
    const key = digest(token);
    const owner = `${clientId}/${sessionId}`;
    if (byToken.has(key) || owners.has(owner)) throw new Error("Duplicate Gateway client credentials or session ownership");
    // Deployment-owned metadata never comes from chat payloads or correlation headers.
    byToken.set(key, workerProfile(epoch, { clientId, sessionId, factoryRunId, role }));
    owners.add(owner);
  }
  const number = (name, fallback, min, max) => {
    const value = Number(env[`CHATGPT_GATEWAY_${name}`] ?? env[`CHATGPT_GATEWAY_FACTORY_${name}`] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid Gateway setting ${name}`);
    return value;
  };
  const maxSessions = number("MAX_SESSIONS", 32, 1, 32);
  if (byToken.size > maxSessions) throw new Error("Startup profiles exceed the Gateway session limit");
  return { mode, admin, scopedManagement, requireScoped, byToken, epoch, maxSessions,
    maxQueued: number("MAX_QUEUED", 8, 1, 32),
    maxPerClient: number("MAX_PER_CLIENT", 2, 1, 8),
    maxBody: number("MAX_BODY_BYTES", (browser ? 32 : 4) * 1024 * 1024, 1024, 32 * 1024 * 1024),
    queueMs: number("QUEUE_MS", browser ? 300_000 : 120_000, 10, 300_000),
    processMs: number("PROCESS_MS", 300_000, 10, 600_000),
    drainMs: number("DRAIN_MS", 360_000, 100, 900_000),
    sessionMs: number("SESSION_MS", 3_600_000, 30_000, 86_400_000),
  };
}
