import { randomUUID } from "node:crypto";

export const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export const roles = ["planner", "architect", "developer", "reviewer", "test-analyst"];

export function gatewayConfig(env) {
  const mode = env.CHATGPT_GATEWAY_TRANSPORT ?? env.CHATGPT_GATEWAY_FACTORY_TRANSPORT ?? "browser";
  const browser = mode === "browser";
  const number = (name, fallback, min, max) => {
    const value = Number(env[`CHATGPT_GATEWAY_${name}`] ?? env[`CHATGPT_GATEWAY_FACTORY_${name}`] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid Gateway setting ${name}`);
    return value;
  };
  return { mode, epoch: randomUUID(), maxSessions: number("MAX_SESSIONS", 32, 1, 32),
    maxQueued: number("MAX_QUEUED", 8, 1, 32),
    maxPerClient: number("MAX_PER_CLIENT", 2, 1, 8),
    maxBody: number("MAX_BODY_BYTES", (browser ? 32 : 4) * 1024 * 1024, 1024, 32 * 1024 * 1024),
    queueMs: number("QUEUE_MS", browser ? 300_000 : 120_000, 10, 300_000),
    processMs: number("PROCESS_MS", 300_000, 10, 600_000),
    drainMs: number("DRAIN_MS", 360_000, 100, 900_000),
    sessionMs: number("SESSION_MS", 3_600_000, 30_000, 86_400_000),
  };
}
