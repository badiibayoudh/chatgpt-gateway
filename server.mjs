import { createServer } from "node:http";
import { browserTransport } from "./communication/browser-transport.mjs";
import { gatewayConfig } from "./communication/config.mjs";
import { createGateway, writeJson } from "./communication/gateway.mjs";
import { mockTransport, openAiConfig, openAiTransport } from "./communication/programmatic-transports.mjs";
import { contextSettings } from "./context.mjs";
import { createMonitor } from "./monitoring/index.mjs";
import { isMonitorPath, monitorRoutes } from "./monitoring/routes.mjs";

const PORT = parseInt(process.env.PORT || "18790", 10);
const EXTENSION_ORIGIN = process.env.CHATGPT_GATEWAY_EXTENSION_ORIGIN;
const settings = contextSettings();
const config = gatewayConfig(process.env);
const monitor = createMonitor();
const adapters = new Map([
  ["browser", () => browserTransport(settings, monitor)],
  ["mock", () => mockTransport()],
  ["openai", () => openAiTransport(openAiConfig(process.env, config))],
]);
const makeTransport = adapters.get(config.mode);
if (!makeTransport) throw new Error("Unknown Gateway transport");
const transport = makeTransport();
const gateway = createGateway(config, settings, monitor, transport);
monitor.emit("gateway.started");

function loopbackHost(host = "") {
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

function extensionOrigin(origin = "") {
  return /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

function healthSnapshot(snapshot = gateway.snapshot()) {
  const legacy = transport.legacyHealth?.() ?? { extensionConnected: false, imageAttachments: false, conversationReuse: false, longMessageFallback: false };
  const availability = snapshot.paused ? "blocked" : transport.availability().state;
  return { status: "ok", ...legacy, pendingRequests: snapshot.pending,
    gateway: { transport: transport.id, availability, programmatic: transport.capabilities.programmatic,
      interactive: transport.capabilities.interactive, unattended: transport.capabilities.unattended,
      simulated: transport.capabilities.simulated } };
}

function metricsSnapshot(snapshot = gateway.snapshot()) {
  const percent = (part, total) => total ? Math.round(10_000 * part / total) / 100 : 0;
  const textBytesSent = snapshot.outgoingPromptBytes + snapshot.textAttachmentBytes;
  return { ...snapshot, pendingRequests: snapshot.pending,
    gateway: { transport: transport.id, capabilities: transport.capabilities,
      availability: snapshot.paused ? "blocked" : transport.availability().state },
    conversationReuseSuccessRate: percent(snapshot.conversationReuseSuccesses, snapshot.continuationRequests),
    toolDefinitionReuseRate: percent(snapshot.toolDefinitionReuses, snapshot.toolDefinitionRequests),
    redundantDataAvoidedPercent: percent(Math.max(0, snapshot.fullContextBaselineBytes - textBytesSent), snapshot.fullContextBaselineBytes),
  };
}

const serveMonitor = monitorRoutes(monitor, () => {
  const state = gateway.snapshot();
  return {
    health: healthSnapshot(state), metrics: metricsSnapshot(state), activeRequestId: state.activeRequestId, queued: state.queued,
    capabilities: transport.observedCapabilities?.() ?? [],
    configuration: { ...settings, extensionOriginRestricted: !!EXTENSION_ORIGIN, connectionMode: "loopback",
      maxBodyBytes: config.maxBody, transport: transport.id, maxQueued: config.maxQueued, maxSessions: config.maxSessions,
      ...(monitor.config && { requestRetention: monitor.config.requests, eventRetention: monitor.config.events,
        eventBytes: monitor.config.eventBytes, persist: monitor.config.persist, logFiles: monitor.config.logFiles, logBytes: monitor.config.logBytes }) },
  };
});

async function handleHttp(req, res) {
  const origin = req.headers.origin;
  const path = req.url.split("?")[0];
  const ownOrigin = `http://${req.headers.host?.toLowerCase()}`;
  const extensionHealth = path === "/health" && req.method === "GET" && extensionOrigin(origin);
  if (!loopbackHost(req.headers.host) || (origin && origin.toLowerCase() !== ownOrigin && !extensionHealth)) {
    writeJson(res, 403, { error: "The gateway accepts only local requests" });
    return;
  }
  if (isMonitorPath(path) && await serveMonitor(req, res, path)) return;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && path === "/health") { writeJson(res, 200, healthSnapshot()); return; }
  if (await gateway.route(req, res, path)) return;
  if (req.method === "GET" && path === "/metrics") { writeJson(res, 200, metricsSnapshot()); return; }
  writeJson(res, 404, { error: "Not found" });
}

function listener() {
  const server = createServer({ requestTimeout: 60_000, connectionsCheckingInterval: 5_000 }, handleHttp);
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    const allowed = EXTENSION_ORIGIN ? origin === EXTENSION_ORIGIN : !origin || extensionOrigin(origin);
    if (!transport.upgrade || req.url !== "/ws" || !loopbackHost(req.headers.host) || !allowed) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    transport.upgrade(req, socket, head);
  });
  return server;
}

const server = listener();
if (monitor.enabled && monitor.config.persist) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => monitor.close().finally(() => process.exit(0)));
}
server.listen(PORT, "127.0.0.1", () => {
  const { port } = server.address();
  const ipv6 = listener();
  ipv6.on("error", (err) => {
    if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(err.code)) throw err;
  });
  ipv6.listen(port, "::1");
  console.log(`ChatGPT Gateway (${transport.id})
  HTTP API:    http://localhost:${port}/v1/chat/completions
  Health:      http://localhost:${port}/health`);
});
