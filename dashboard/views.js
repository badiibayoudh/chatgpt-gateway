export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export const pretty = (value) => value == null ? "—" : String(value).replaceAll("_", " ");
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
export const count = (value) => value == null ? "—" : number.format(value);
export const percent = (value) => value == null ? "—" : `${count(value)}%`;
export const duration = (value) => value == null ? "—" : value < 1000 ? `${count(value)} ms` : `${count(value / 1000)} s`;
export const time = (value) => value ? new Date(value).toLocaleString() : "—";
export function bytes(value) {
  if (value == null) return "—";
  if (value < 1024) return `${count(value)} B`;
  if (value < 1024 ** 2) return `${count(value / 1024)} KiB`;
  return `${count(value / 1024 ** 2)} MiB`;
}

function pill(value) {
  const tone = { completed: "good", ready: "good", failed: "bad", timed_out: "warn", queued: "warn", processing: "good" }[value] ?? "neutral";
  return element("span", pretty(value), `pill ${tone}`);
}

export function button(text, execute, style) {
  const node = element("button", text, style);
  node.type = "button";
  node.addEventListener("click", execute);
  return node;
}

function requestLink(id, open) {
  if (!id) return "—";
  const link = button(id.slice(0, 8), () => open(id), "link mono");
  link.title = id;
  link.setAttribute("aria-label", `Inspect request ${id}`);
  return link;
}

function cards(items) {
  const grid = element("div", undefined, "cards");
  for (const [label, value, help] of items) {
    const card = element("div", undefined, "card");
    card.append(element("span", label, "fine"), element("p", value, "value"));
    if (help) card.append(element("span", help, "fine"));
    grid.append(card);
  }
  return grid;
}

function table(title, columns, rows, empty = "No observations yet.") {
  const panel = element("section", undefined, "panel");
  if (title) {
    const heading = element("div", undefined, "panel-title");
    heading.append(element("h2", title));
    panel.append(heading);
  }
  if (!rows.length) { panel.append(element("p", empty, "empty fine")); return panel; }
  const scroll = element("div", undefined, "table-scroll");
  const grid = element("table");
  if (title) grid.setAttribute("aria-label", title);
  const head = grid.createTHead().insertRow();
  for (const title of columns) {
    const cell = element("th", title);
    cell.scope = "col";
    head.append(cell);
  }
  const body = grid.createTBody();
  for (const row of rows) {
    const line = body.insertRow();
    row.forEach((value) => {
      const cell = line.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? "—";
    });
  }
  scroll.append(grid);
  panel.append(scroll);
  return panel;
}

export function requests(rows, open, title = "Request history") {
  return table(title, ["Request", "Status", "Received", "Model", "Route", "Logical / sent", "Images prepared", "Queue", "Total", "Error"],
    rows.map((row) => [requestLink(row.requestId, open), pill(row.state), time(row.receivedAt), row.model, pretty(row.mode),
      `${bytes(row.logicalBytes)} / ${bytes(row.wireBytes ?? row.forwardedTextBytes)}`, count(row.images), duration(row.queueMs), duration(row.durationMs), pretty(row.errorCode)]),
    "No requests match these filters.");
}

export function overview(status, rows, open) {
  const { health, totals, terminal, latency, resources, retention, browser, metrics } = status;
  const active = status.activeRequestId ? requestLink(status.activeRequestId, open) : "Idle";
  const backend = metrics.gateway;
  const interactive = backend?.capabilities.interactive ?? true;
  const transport = !interactive ? [
    ["Backend", pretty(backend.transport), pretty(backend.availability)],
    ["Model slots", `${metrics.activeSlots} / ${backend.capabilities.concurrency}`, "Active / configured"],
  ] : [
    ["Extension", health.extensionConnected ? "Connected" : "Disconnected", status.capabilities.join(" · ") || "Capabilities unavailable"],
    ["Browser", pretty(browser.status), browser.observedAt ? `Observed ${time(browser.observedAt)}` : "No recent observation"],
  ];
  const recent = table("Recent failures", ["Request", "Time", "Category", "What happened"],
    status.recentFailures.map((row) => [requestLink(row.requestId, open), time(row.timestamp), pretty(row.code), row.message]));
  return [cards([
    ["Gateway uptime", duration(status.uptimeSeconds * 1000), "Current process"],
    ...transport,
    ["Queued", count(status.queued), `${count(totals.received)} received in this process`],
    ["Success rate", percent(status.successRate), `${count(totals.completed)} completed / ${count(terminal)} terminal, includes cancellations`],
    ["Mean / P95 latency", `${duration(latency.meanMs)} / ${duration(latency.p95Ms)}`, `${latency.sample} recent completed requests, up to ${latency.window}`],
    ["Node RSS / heap", `${bytes(resources.rssBytes)} / ${bytes(resources.heapBytes)}`, "Gateway process memory"],
    ["CPU", percent(resources.cpuOneCorePercent), "100% represents one logical core"],
    ...(!interactive ? [["Input reserved", bytes(metrics.retainedBytes), "Read, queued and draining requests"],
      ["Overloaded", count(metrics.overloaded), "Requests denied admission"]] : [
      ["Conversation reuse", percent(metrics.continuationRequests ? metrics.conversationReuseSuccessRate : null), `${count(metrics.continuationRequests)} continuation attempts`],
      ["Image attachments", count(metrics.imageAttachmentCount), `${count(metrics.textAttachmentFallbackCount)} text fallback attempts`],
    ]),
    ["Request outcomes", `${totals.failed} failed`, `${totals.cancelled} cancelled · ${totals.timed_out} timed out`],
    ["Telemetry", count(retention.events), `${retention.dropped} dropped · ${retention.evictedEvents} evicted · ${retention.storage.errors} storage errors`],
  ]), table(interactive ? "Browser slot" : "Model slot", ["Active request", "Waiting", "Log storage"], [[active, count(status.queued), retention.storage.enabled ? "JSONL enabled" : "Memory only"]]),
  requests(rows, open, "Recent requests"), recent];
}

export function context(view, open) {
  const { metrics, items, attachments } = view;
  if (metrics.gateway?.capabilities.interactive === false) return [table("Provider requests", ["Request", "Role", "Run tag", "Logical context", "Provider request", "Tool definitions", "Usage"],
    items.map((row) => [requestLink(row.requestId, open), pretty(row.role), row.runTag, bytes(row.logicalBytes), bytes(row.wireBytes),
      count(row.exposedTools), row.providerUsage ? `${count(row.providerUsage.input)} / ${count(row.providerUsage.output)} (${row.providerUsage.authoritative ? "transport" : "estimated"})` : "—"]))];
  const reduction = (row) => row.fullTextBytes && row.forwardedTextBytes != null
    ? percent((1 - (row.forwardedTextBytes + (row.textAttachmentBytes ?? 0)) / row.fullTextBytes) * 100) : "—";
  return [cards([
    ["Full history", count(metrics.fullHistoryRequests), "Dispatched"], ["Continuations", count(metrics.continuationRequests), "Dispatched"],
    ["Same chat reuse", percent(metrics.continuationRequests ? metrics.conversationReuseSuccessRate : null), `${count(metrics.conversationReuseSuccesses)} successful continuations`],
    ["Tool definition reuse", percent(metrics.toolDefinitionRequests ? metrics.toolDefinitionReuseRate : null), `${count(metrics.toolDefinitionReuses)} catalogs omitted`],
    ["HTTP input", bytes(metrics.incomingRequestBytes), "Includes binary data encoded as text"],
    ["Browser prompt text", bytes(metrics.outgoingPromptBytes), `${bytes(metrics.textAttachmentBytes)} in text files`],
    ["Estimated input / output tokens", `${count(metrics.estimatedInputTokens)} / ${count(metrics.estimatedOutputTokens)}`, "Logical client context and returned output"],
    ["Size / upload errors", `${count(metrics.oversizedRequestCount)} / ${count(metrics.uploadAllowanceErrors)}`, "Observed errors and recovered oversized requests"],
  ]), table("Recent context preparation", ["Request", "Route", "Matching decision", "Messages", "Tools", "Full prompt", "Sent text + files", "Reduction"],
    items.map((row) => [requestLink(row.requestId, open), pretty(row.mode), pretty(row.reuseReason),
      `${count(row.forwardedMessages)} / ${count(row.incomingMessages)}`, `${count(row.exposedTools)} · ${row.toolsReused ? "reused" : bytes(row.toolDefinitionBytes)}`,
      bytes(row.fullTextBytes), row.forwardedTextBytes == null ? "—" : bytes(row.forwardedTextBytes + (row.textAttachmentBytes ?? 0)), reduction(row)])),
  table("Attachment events in retained history", ["Stage", "Events"], Object.entries(attachments).map(([key, value]) => [pretty(key), count(value)])),
  table("History matching decisions", ["Decision", "Requests"], Object.entries(metrics.historyMatches ?? {}).map(([key, value]) => [pretty(key), count(value)]))];
}

export function tools(view, open) {
  const items = [...view.items].sort((a, b) => b.requested - a.requested || a.name.localeCompare(b.name));
  return [cards([["Tools observed", count(items.length), "Retained name groups"], ["Unmatched results", count(view.unmatchedResults), "Gateway correlation unavailable"]]),
    table("Tool lifecycle", ["Tool", "Group", "Exposed", "Requested", "Validated", "Rejected", "Forwarded", "Result observed"], items.map((row) =>
      [row.name, `${row.group}${row.inferred ? " (inferred)" : ""}`, ...["exposed", "requested", "validated", "validation_failed", "forwarded", "result_received"].map((key) => count(row[key]))])),
    table("Recent tool calls", ["Call", "Tool", "Origin request", "Result request", "Elapsed to result"], view.calls.map((row) =>
      [row.callId, row.name, requestLink(row.originRequestId, open), requestLink(row.resultRequestId, open), duration(row.elapsedMs)])),
    element("p", "A received result establishes correlation. Tool execution and its success are observed by the IDE.", "fine")];
}

export function logs(rows, open, title = "Structured events") {
  return table(title, ["Time", "Level", "Component", "Event", "Request", "Observed data"], rows.map((row) => [time(row.timestamp),
    pretty(row.level), row.component, element("span", row.event, "mono"), requestLink(row.requestId, open),
    element("span", Object.entries(row.data).map(([key, value]) => `${key} ${String(value)}`).join("\n") || "—", "data mono")]),
    "No events match these filters.");
}

export function detail(data, open) {
  const r = data.request;
  const stage = r.transport && r.transport !== "browser" ? [["Provider / delivery", `${duration(r.serviceMs)} / ${duration(r.deliveryMs)}`],
    ["Worker role", pretty(r.role), r.runTag]] : [["Browser / delivery", `${duration(r.browserMs)} / ${duration(r.deliveryMs)}`],
    ["Generation observed", duration(r.generationStartMs), "After Send, based on server receipt"]];
  const fragments = [cards([["Status", pretty(r.state)], ["Total / queue", `${duration(r.durationMs)} / ${duration(r.queueMs)}`],
    ...stage, ...(r.transport === "browser" && r.role ? [["Worker role", pretty(r.role), r.runTag]] : []),
    ["Input / output tokens", `${count(r.providerUsage?.input ?? r.estimatedInputTokens)} / ${count(r.providerUsage?.output ?? r.estimatedOutputTokens)}`],
    ["Logical / forwarded", `${bytes(r.logicalBytes)} / ${bytes(r.wireBytes ?? r.forwardedTextBytes)}`],
    ["Route", pretty(r.mode), pretty(r.reuseReason)], ["Error", pretty(r.errorCode), r.errorMessage]]),
    logs(data.timeline, open, "Request timeline")];
  if (data.timelineTruncated) fragments.unshift(element("p", "Some timeline events are outside the retention or display window.", "notice"));
  return fragments;
}
