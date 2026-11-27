import { readFile } from "node:fs/promises";
import { components, errors, levels, schemas, states, uuid } from "./events.mjs";

const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const assets = new Map([
  ["/dashboard", ["index.html", "text/html"]], ["/dashboard/", ["index.html", "text/html"]],
  ["/dashboard/assets/styles.css", ["styles.css", "text/css"]], ["/dashboard/assets/app.js", ["app.js", "text/javascript"]],
  ["/dashboard/assets/api.js", ["api.js", "text/javascript"]], ["/dashboard/assets/views.js", ["views.js", "text/javascript"]],
]);
const version = await readFile(new URL("../package.json", import.meta.url), "utf8").then((file) => JSON.parse(file).version).catch(() => null);
export const isMonitorPath = (url) => /^\/(?:monitor|dashboard)(?:\/|$)/.test(url);

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const fail = (res, status, code, message) => json(res, status, { error: { code, message } });

function query(url, allowed) {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new Error("Invalid monitor filter");
  }
  const filter = Object.fromEntries(params);
  for (const [key, min, max] of [["limit", 1, 200], ["cursor", 1, Number.MAX_SAFE_INTEGER]]) {
    if (!(key in filter)) continue;
    if (!/^\d+$/.test(filter[key]) || +filter[key] < min || +filter[key] > max) throw new Error("Invalid monitor page");
    filter[key] = Number(filter[key]);
  }
  for (const [key, values] of Object.entries({ level: levels, component: components, state: states,
    event: Object.keys(schemas), code: Object.keys(errors), format: ["json", "jsonl"] })) {
    if (key in filter && !values.includes(filter[key])) throw new Error("Invalid monitor filter value");
  }
  if ("requestId" in filter && !uuid.test(filter.requestId)) throw new Error("Invalid request ID");
  if ("q" in filter && (filter.q.length > 64 || /[\x00-\x1f]/.test(filter.q))) throw new Error("Invalid search term");
  for (const key of ["from", "to"]) {
    if (!(key in filter)) continue;
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(filter[key]) || !Number.isFinite(Date.parse(filter[key]))) throw new Error("Use a UTC ISO timestamp");
    filter[key] = new Date(filter[key]).toISOString();
  }
  if (filter.from && filter.to && filter.from > filter.to) throw new Error("Invalid time range");
  return filter;
}

const inRange = (time, f) => (!f.from || time >= f.from) && (!f.to || time <= f.to);
const requestFilter = (row, f) => (!f.requestId || row.requestId === f.requestId) && (!f.state || row.state === f.state) &&
  (!f.code || row.errorCode === f.code) && inRange(row.receivedAt, f) &&
  (!f.q || [row.requestId, row.model, row.errorCode].some((value) => value?.toLowerCase().includes(f.q.toLowerCase())));
const eventFilter = (row, f) => ["requestId", "level", "component", "event"].every((key) => !f[key] || f[key] === row[key]) &&
  (!f.code || row.data.code === f.code) && inRange(row.timestamp, f);

function page(items, key, filter) {
  const limit = filter.limit ?? 50;
  const ordered = items.filter((row) => !filter.cursor || row[key] < filter.cursor).sort((a, b) => b[key] - a[key]);
  return { items: ordered.slice(0, limit), nextCursor: ordered.length > limit ? ordered[limit - 1][key] : null };
}

export function monitorRoutes(monitor, getCore) {
  const cache = new Map();
  const envelope = () => ({ schemaVersion: 1, sessionId: monitor.sessionId, startedAt: monitor.startedAt, retention: monitor.retention() });
  const eventFilters = ["limit", "requestId", "level", "component", "event", "code", "from", "to"];
  return async (req, res, pathname) => {
    if (!isMonitorPath(pathname)) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!monitor.enabled) { fail(res, 404, "monitor_disabled", "Gateway monitoring is disabled."); return true; }
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); fail(res, 405, "read_only", "Monitoring routes are read-only."); return true; }
    try {
      if (assets.has(pathname)) {
        const [file, mime] = assets.get(pathname);
        if (!cache.has(file)) cache.set(file, await readFile(new URL(`../dashboard/${file}`, import.meta.url)));
        res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
        res.end(cache.get(file));
        return true;
      }
      if (pathname.startsWith("/dashboard")) { fail(res, 404, "not_found", "Dashboard asset not found."); return true; }
      const url = new URL(req.url, "http://localhost");
      const base = envelope();
      let filter;
      try {
        const allowed = pathname === "/monitor/requests" ? ["limit", "cursor", "requestId", "state", "code", "from", "to", "q"] :
          pathname === "/monitor/logs" ? [...eventFilters, "cursor"] : pathname === "/monitor/export" ? [...eventFilters, "format"] : [];
        filter = query(url, allowed);
      } catch {
        fail(res, 400, "invalid_filter", "Use valid filter values, a positive cursor, and a limit from 1 to 200.");
        return true;
      }
      if (pathname === "/monitor/status") {
        json(res, 200, { ...base, ...monitor.status(getCore()) });
      } else if (pathname === "/monitor/requests") {
        const items = monitor.requestRows().filter((row) => requestFilter(row, filter));
        json(res, 200, { ...base, ...page(items, "firstSequence", filter) });
      } else if (pathname.startsWith("/monitor/requests/")) {
        const id = pathname.slice("/monitor/requests/".length);
        if (!uuid.test(id)) { fail(res, 400, "invalid_request_id", "Use a gateway request UUID."); return true; }
        const request = monitor.requestRows().find((row) => row.requestId === id);
        if (!request) { fail(res, 404, "request_not_found", "The request is unknown or outside retention."); return true; }
        const timeline = monitor.eventRows().filter((row) => row.requestId === id);
        json(res, 200, { ...base, request: { ...request, errorMessage: errors[request.errorCode] },
          timeline: timeline.slice(-200), timelineTruncated: timeline.length > 200 || timeline[0]?.sequence !== request.firstSequence });
      } else if (pathname === "/monitor/conversations") {
        const core = getCore();
        const prepared = monitor.requestRows().filter(({ mode }) => mode).sort((a, b) => b.firstSequence - a.firstSequence).slice(0, 50);
        const attachments = Object.fromEntries(["prepared", "attempted", "accepted", "failed", "skipped", "fallback"].map((stage) => [stage,
          monitor.eventRows().filter(({ event }) => event === `attachment.${stage}`).length]));
        json(res, 200, { ...base, metrics: core.metrics, items: prepared, attachments });
      } else if (pathname === "/monitor/tools") {
        json(res, 200, { ...base, ...monitor.tools() });
      } else if (pathname === "/monitor/logs") {
        json(res, 200, { ...base, ...page(monitor.eventRows().filter((row) => eventFilter(row, filter)), "sequence", filter) });
      } else if (pathname === "/monitor/export") {
        const events = monitor.eventRows().filter((row) => eventFilter(row, filter));
        const relatedIds = new Set(events.map(({ requestId }) => requestId));
        const requests = monitor.requestRows().filter((row) => filter.requestId ? row.requestId === filter.requestId : relatedIds.has(row.requestId));
        if (filter.requestId && !requests.length) { fail(res, 404, "request_not_found", "The request is unknown or outside retention."); return true; }
        const core = getCore();
        const status = monitor.status(core);
        if (filter.requestId && status.activeRequestId !== filter.requestId) status.activeRequestId = null;
        status.recentFailures = status.recentFailures.filter((row) => (!filter.requestId || row.requestId === filter.requestId) && inRange(row.timestamp, filter));
        sendExport(res, monitor, { ...base, gatewayVersion: version, configuration: core.configuration,
          status, errors, requests: requests.slice(-50), requestsTruncated: requests.length > 50 }, filter, events);
      } else {
        fail(res, 404, "not_found", "Monitoring route not found.");
      }
    } catch {
      fail(res, 503, "monitor_unavailable", "Monitoring data is temporarily unavailable.");
    }
    return true;
  };
}

function sendExport(res, monitor, metadata, filter, rows) {
  const items = rows.slice(-(filter.limit ?? 200));
  const report = { ...metadata, truncated: items.length !== rows.length || metadata.requestsTruncated || !metadata.retention.historyComplete, events: items };
  const filtered = ["from", "to", "level", "component", "event", "code"].some((key) => key in filter);
  if (filter.requestId && !filtered && items[0]?.sequence !== metadata.requests[0]?.firstSequence) report.truncated = true;
  const serialize = filter.format === "jsonl" ? () => {
    const { events, ...header } = report;
    return [JSON.stringify(header), ...events.map((item) => JSON.stringify(item))].join("\n") + "\n";
  } : () => JSON.stringify(report, null, 2);
  let body = serialize();
  if (Buffer.byteLength(body) > monitor.config.exportBytes) {
    // Prefer filtered events and request summaries over the unfiltered legend and aggregate counters.
    delete report.errors;
    delete report.status.metrics;
    report.truncated = true;
    body = serialize();
  }
  while (Buffer.byteLength(body) > monitor.config.exportBytes && (items.length || report.requests.length)) {
    if (items.length) items.splice(0, Math.max(1, Math.ceil(items.length / 4)));
    else if (!filter.requestId || report.requests.length > 1) report.requests.shift();
    else break;
    report.truncated = true;
    body = serialize();
  }
  if (Buffer.byteLength(body) > monitor.config.exportBytes) { fail(res, 413, "export_budget", "Select a smaller diagnostic range."); return; }
  const format = filter.format ?? "json";
  res.writeHead(200, { "Content-Type": format === "jsonl" ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="gateway-monitor.${format}"` });
  res.end(body);
}
