import { createHash, randomUUID } from "node:crypto";
import { identifier, roles } from "./config.mjs";
import { GatewayError } from "./protocol.mjs";

const fields = ["clientId", "factoryRunId", "role"];

export function createSessionRegistry(config, busy, now = Date.now) {
  const leases = new Map();
  const expired = (worker) => worker.closed || worker.expiresAt <= now();

  function reap() {
    for (const [sessionId, worker] of leases) {
      if (!expired(worker) || busy.has(worker.scope)) continue;
      leases.delete(sessionId);
    }
  }

  const summary = (worker) => ({ sessionId: worker.sessionId, apiBase: `/sessions/${worker.sessionId}/v1`, runTag: worker.runTag,
    role: worker.role, expiresAt: new Date(worker.expiresAt).toISOString() });

  return {
    lookup(sessionId) {
      reap();
      const worker = leases.get(sessionId);
      return worker && !expired(worker) ? worker : undefined;
    },
    register(body) {
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key)) ||
        [body.clientId, body.factoryRunId].some((id) => id !== undefined && (typeof id !== "string" || !identifier.test(id))) ||
        (body.role !== undefined && !roles.includes(body.role))) {
        throw new GatewayError(400, "invalid_session", "Use an empty object or provide valid clientId, factoryRunId and role labels.");
      }
      reap();
      if (leases.size >= config.maxSessions) {
        throw new GatewayError(429, "session_capacity", "Session capacity is exhausted. Close an unused session or wait for it to expire.");
      }
      const sessionId = randomUUID();
      const runTag = body.factoryRunId && createHash("sha256").update(`${config.epoch}/${body.factoryRunId}`).digest("hex").slice(0, 16);
      const worker = { clientId: body.clientId ?? sessionId, sessionId, runTag, role: body.role,
        scope: `${config.epoch}/${sessionId}`, expiresAt: now() + config.sessionMs };
      leases.set(sessionId, worker);
      return summary(worker);
    },
    list() {
      reap();
      return [...leases.values()].filter((worker) => !expired(worker)).map(summary);
    },
    close(sessionId) {
      reap();
      const worker = leases.get(sessionId);
      if (!worker || expired(worker)) return null;
      worker.closed = true;
      reap();
      return worker;
    },
  };
}
