import { randomBytes, randomUUID } from "node:crypto";
import { digest, identifier, roles, tokenPattern, workerProfile } from "./factory-config.mjs";
import { FactoryError } from "./factory-protocol.mjs";

const fields = ["clientId", "factoryRunId", "role"];

export function createWorkerRegistry(config, busy, now = Date.now) {
  const leases = new Map();
  const tokens = new Map();
  const expired = (worker) => worker.revoked || worker.expiresAt <= now();

  function reap() {
    for (const [sessionId, worker] of leases) {
      if (!expired(worker) || busy.has(worker.scope)) continue;
      leases.delete(sessionId);
      tokens.delete(worker.tokenKey);
    }
  }

  const summary = (worker) => ({ sessionId: worker.sessionId, runTag: worker.runTag,
    role: worker.role, expiresAt: new Date(worker.expiresAt).toISOString() });

  return {
    lookup(authorization) {
      reap();
      if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
      const token = authorization.slice(7);
      if (!tokenPattern.test(token)) return null;
      const key = digest(token);
      const worker = tokens.get(key);
      return worker && !expired(worker) ? worker : config.byToken.get(key);
    },
    register(body) {
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key)) ||
        [body.clientId, body.factoryRunId].some((id) => typeof id !== "string" || !identifier.test(id)) || !roles.includes(body.role)) {
        throw new FactoryError(400, "invalid_session", "Provide clientId, factoryRunId and a supported role for a new worker.");
      }
      reap();
      if (leases.size + config.byToken.size >= config.maxSessions) {
        throw new FactoryError(429, "session_capacity", "Worker session capacity is exhausted. Revoke an unused session or wait for it to expire.");
      }
      const token = randomBytes(32).toString("base64url");
      const tokenKey = digest(token);
      const sessionId = randomUUID();
      const worker = { ...workerProfile(config.epoch, { ...body, sessionId }), tokenKey, sessionId, expiresAt: now() + config.sessionMs };
      leases.set(sessionId, worker);
      tokens.set(tokenKey, worker);
      return { ...summary(worker), token };
    },
    list() {
      reap();
      return [...leases.values()].filter((worker) => !expired(worker)).map(summary);
    },
    revoke(sessionId) {
      reap();
      const worker = leases.get(sessionId);
      if (!worker || expired(worker)) return null;
      worker.revoked = true;
      tokens.delete(worker.tokenKey);
      reap();
      return worker;
    },
  };
}
