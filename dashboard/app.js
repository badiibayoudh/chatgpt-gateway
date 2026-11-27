import { download, get } from "./api.js";
import { button, context as contextView, detail, element, logs, overview, requests, time, tools } from "./views.js";

const $ = (id) => document.getElementById(id);
const views = { overview: "Overview", requests: "Requests", context: "Context", tools: "Tools", logs: "Logs" };
const screen = $("view");
let selected = "overview";
let cursorStack = [null];
let nextCursor = null;
let preferences = {};
let active;
let timer;
let failureCount = 0;
let lastRefresh;
let session;
let currentRows;
let inspected;
let detailFetch;
let generation = 0;
let refreshPending = false;

$("endpoint").textContent = location.host;

function notice(text = "") {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

function connection(text, tone) {
  $("connection").textContent = text;
  $("connection").className = `pill ${tone}`;
}

function createFilter(name, label, values) {
  const field = element("label", label);
  const input = element(values ? "select" : "input");
  input.name = name;
  if (values) for (const value of ["", ...values]) {
    const option = element("option", value.replaceAll("_", " ") || "All");
    option.value = value;
    input.append(option);
  }
  else if (name === "from" || name === "to") input.type = "datetime-local";
  else { input.type = name === "q" ? "search" : "text"; input.maxLength = name === "requestId" ? 36 : 64; }
  field.append(input);
  return field;
}

function buildFilters() {
  const host = $("filters");
  host.replaceChildren();
  host.hidden = selected !== "requests" && selected !== "logs";
  if (host.hidden) return;
  const form = element("form", undefined, "filters");
  if (selected === "requests") form.append(createFilter("q", "Request, model or error"), createFilter("state", "Status",
    ["received", "queued", "dispatched", "processing", "completed", "failed", "cancelled", "timed_out"]));
  else form.append(createFilter("level", "Severity", ["debug", "info", "warn", "error"]),
    createFilter("component", "Component", ["gateway", "background", "content-script", "monitoring"]),
    createFilter("event", "Event name"), createFilter("code", "Error code"), createFilter("requestId", "Request UUID"));
  form.append(createFilter("from", "From"), createFilter("to", "To"));
  const apply = element("button", "Apply filters", "primary");
  apply.type = "submit";
  form.append(apply, button("Clear", () => { form.reset(); form.requestSubmit(); }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    preferences = Object.fromEntries([...new FormData(form)].filter(([, value]) => value).map(([key, value]) =>
      [key, key === "from" || key === "to" ? new Date(value).toISOString() : value.trim()]));
    cursorStack = [null];
    restartPoll();
  });
  host.append(form);
}

function goto(view) {
  selected = view;
  preferences = {};
  cursorStack = [null];
  nextCursor = null;
  currentRows = undefined;
  $("title").textContent = views[view];
  for (const tab of document.querySelectorAll("[data-view]")) {
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  const actions = $("view-actions");
  actions.replaceChildren();
  if (view === "logs") actions.append(button("Copy event summary", () => copyEvents()),
    button("Download JSON", () => exportRange("json")), button("Download JSONL", () => exportRange("jsonl")));
  $("pagination").hidden = true;
  buildFilters();
  screen.replaceChildren(element("p", "Loading gateway observations…", "fine"));
  restartPoll();
}

function restartPoll() {
  generation++;
  clearTimeout(timer);
  if (active) { refreshPending = true; active.abort(); }
  else void poll();
}

async function poll() {
  if (active || document.hidden) return;
  const current = generation;
  const controller = new AbortController();
  active = controller;
  try {
    const status = await get("status", null, controller.signal);
    if (current !== generation) return;
    if (session && session !== status.sessionId) {
      cursorStack = [null];
      inspected = undefined;
      if ($("inspector").open) $("inspector").close();
      notice("The gateway restarted. In-memory history now reflects the new process.");
    }
    session = status.sessionId;
    const options = { ...preferences, cursor: cursorStack.at(-1), limit: 50 };
    const path = selected === "overview" ? "requests" : selected === "context" ? "conversations" : selected;
    const data = await get(path, selected === "overview" ? { limit: 6 } : ["requests", "logs"].includes(selected) ? options : null, controller.signal);
    if (current !== generation) return;
    if (data.sessionId !== status.sessionId) { refreshPending = true; return; }
    currentRows = data.items;
    const backend = status.health.gateway;
    if (backend && !backend.interactive) {
      const label = { simulated: "Mock transport", verified: "Provider verified", blocked: "Dispatch paused", unavailable: "Provider unavailable" }[backend.availability];
      connection(label ?? "Provider unverified", backend.availability === "verified" ? "good" : "warn");
    } else connection(status.health.extensionConnected ? "Interactive Gateway" : "Extension disconnected", status.health.extensionConnected ? "good" : "warn");
    lastRefresh = Date.now();
    $("refresh-status").textContent = `Updated ${new Date(lastRefresh).toLocaleTimeString()}`;
    if (failureCount) notice();
    failureCount = 0;
    const focused = document.activeElement?.getAttribute("aria-label");
    const content = {
      overview: () => overview(status, data.items, openRequest), requests: () => [requests(data.items, openRequest)],
      context: () => contextView(data, openRequest), tools: () => tools(data, openRequest), logs: () => [logs(data.items, openRequest)],
    }[selected]();
    screen.replaceChildren(...content);
    if (focused) [...screen.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === focused)?.focus();
    $("pagination").hidden = !["requests", "logs"].includes(selected);
    nextCursor = data.nextCursor;
    $("previous").disabled = cursorStack.length === 1;
    $("next").disabled = !nextCursor;
    $("page-number").textContent = `Page ${cursorStack.length}`;
  } catch (error) {
    if (error.name === "AbortError" || current !== generation) return;
    failureCount++;
    connection(lastRefresh ? "Stale" : "Offline", "warn");
    notice(lastRefresh ? `Refresh failed. Showing data from ${time(lastRefresh)}. ${error.message}` : error.message);
  } finally {
    active = undefined;
    const delay = refreshPending ? 0 : Math.min(30_000, 2000 * 2 ** failureCount);
    refreshPending = false;
    if (!document.hidden) timer = setTimeout(poll, delay);
  }
}

async function openRequest(id) {
  detailFetch?.abort();
  detailFetch = new AbortController();
  const signal = detailFetch.signal;
  inspected = undefined;
  $("detail-id").textContent = id;
  $("detail-notice").textContent = "";
  $("copy-detail").disabled = $("download-detail").disabled = true;
  $("detail").replaceChildren(element("p", "Loading request timeline…", "fine"));
  if (!$("inspector").open) $("inspector").showModal();
  try {
    const data = await get(`requests/${encodeURIComponent(id)}`, null, signal);
    if (signal.aborted) return;
    inspected = data;
    $("detail").replaceChildren(...detail(data, openRequest));
    $("copy-detail").disabled = $("download-detail").disabled = false;
  } catch (error) {
    if (!signal.aborted) $("detail").replaceChildren(element("p", error.message, "notice"));
  }
}

async function copyText(value, report = notice) {
  try { await navigator.clipboard.writeText(value); report("Copied sanitized summary."); }
  catch { report("Clipboard access is unavailable. Use the diagnostic download."); }
}

function copyEvents() {
  const rows = currentRows ?? [];
  void copyText(JSON.stringify({ sessionId: session, events: rows.slice(0, 20) }, null, 2));
}

async function exportRange(format) {
  try { await download({ ...preferences, format }); }
  catch (error) { notice(error.message); }
}

document.querySelectorAll("[data-view]").forEach((tab) => tab.addEventListener("click", () => goto(tab.dataset.view)));
document.querySelectorAll("[data-close]").forEach((item) => item.addEventListener("click", () => $(item.dataset.close).close()));
$("refresh").addEventListener("click", restartPoll);
$("inspector").addEventListener("close", () => { detailFetch?.abort(); inspected = undefined; });
$("next").addEventListener("click", () => { if (nextCursor) { cursorStack.push(nextCursor); restartPoll(); } });
$("previous").addEventListener("click", () => { if (cursorStack.length > 1) { cursorStack.pop(); restartPoll(); } });
$("copy-detail").addEventListener("click", () => {
  if (inspected) void copyText(JSON.stringify(inspected, null, 2), (text) => { $("detail-notice").textContent = text; });
});
$("download-detail").addEventListener("click", async () => {
  if (!inspected) return;
  try { await download({ requestId: inspected.request.requestId, format: "json" }); }
  catch (error) { $("detail-notice").textContent = error.message; }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(timer); active?.abort(); detailFetch?.abort(); }
  else restartPoll();
});
window.addEventListener("pagehide", () => { clearTimeout(timer); active?.abort(); detailFetch?.abort(); });
goto("overview");
