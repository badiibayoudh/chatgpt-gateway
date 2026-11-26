# Gateway Monitor

## Phase 0 — Baseline

- Base commit `d946d93` on `fix/chatgpt-dom-compatibility`. Implementation branch `codex/gateway-monitor`.
- `node --test --test-reporter=dot` passed all 47 baseline tests.
- The HTTP server binds `127.0.0.1` and `::1`, checks Host and Origin, and optionally requires a bearer key. `/health` reports extension capability flags and pending count without authentication. `/metrics` returns aggregate counters and requires the configured key. `/v1/chat/completions` supports JSON and SSE. `DELETE /v1/requests/:id` removes a waiting client while any dispatched browser turn can finish independently.
- `chat-history.mjs` matches exact histories and verified tool-call anchors. `chat-input.mjs` prepares images and compact transcripts, and `chat-tools.mjs` validates responses against client tool schemas. `background.js` routes browser work and relays transmission metadata. `content.js` observes the composer, uploads, and generation. Both manifests use classic extension scripts.
- Monitor instrumentation will observe lifecycle boundaries, selected context, socket/browser events, tool validation, and HTTP delivery. Browser readiness and execution outcomes remain observation-based. Existing public endpoint shapes are unchanged.

## Implementation phases

| Phase | Status | Evidence |
|---|---|---|
| 1. Dashboard and routing | Implemented | `dashboard/` and `monitoring/routes.mjs`, read-only static allowlist and protected JSON routes |
| 2. Lifecycle tracking | Implemented | `monitoring/index.mjs`, queue, browser and delivery timings, idempotent terminal states |
| 3. Extension telemetry | Implemented | `background.js`, `content.js`, versioned capability on the existing socket, correlated and rate-limited |
| 4. Context and attachments | Implemented | `context.mjs`, `chat-input.mjs`, `chat-tools.mjs`, current and historical images, comparable text deltas |
| 5. Tool correlation | Implemented | Observed definitions, validated model requests and later IDE results scoped to the matched chat |
| 6. Diagnostics and retention | Implemented | `monitoring/log-store.mjs`, bounded JSON/JSONL exports, opt-in rotation, benchmark below |
| 7. Validation | Verified with synthetic requests | 55 automated tests, including the 47 original gateway tests, and a browser smoke test |

## Reproducing verification

- `node --test` runs the gateway regression suite plus monitor coverage for API security, malformed telemetry, lifecycle, replay, retention, rotation, write failures and bounded private exports.
- `node scripts/monitor-benchmark.mjs` runs an isolated 120-request HTTP/WebSocket fixture with monitoring disabled, memory retention, and JSONL persistence. `node scripts/monitor-benchmark.mjs --preview` starts a four-minute local dashboard populated only with synthetic requests. Open the dashboard URL printed by the command.
- In the browser, the overview showed 14 synthetic requests, including two upload-allowance failures. Opening a failure showed generation, the classified error, and client delivery in one timeline. Automated HTTP tests verify the sanitized JSON and JSONL downloads. The browser session expired before the download control could be verified end to end.
- A live ChatGPT account, Cline or Continue session, and physical MCP devices remain unverified. The local fixtures exercise the HTTP and WebSocket paths without those dependencies.

### Resource sample

One run on the local Windows host with Node 24.22.3, on 2026-11-26. Each mode sent the same 120 sequential requests, alternating fresh chats and continuations with a 28 ms pause between requests. Round-trip time excludes the pause. RSS is a post-run sample, CPU is cumulative gateway process CPU during the fixture, and bytes are measured after the fixture. The mock browser removes model and browser timing variance. These measurements describe this fixture and host.

| Mode | Mean HTTP round trip | Process CPU | RSS | Retained events / bytes | Disk bytes |
|---|---:|---:|---:|---:|---:|
| Disabled | 8.28 ms | 219 ms | 108.3 MiB | 0 / 0 | 0 |
| Memory | 8.96 ms | 234 ms | 112.3 MiB | 1,983 / 620,822 | 0 |
| JSONL | 12.74 ms | 1,110 ms | 112.3 MiB | 1,983 / 620,822 | 620,822 |

### Boundaries

- The monitor adopts the existing health and metrics snapshots and adds independent per-request read models. Routes, schemas, persistence and UI are separate modules. The facade co-locates the small in-memory collectors so a single sanitized event is recorded and applied once.
- Browser readiness and generation are best-effort observations. Event timestamps are server receipt times. Browser-local duration and tool execution success are unavailable. Tool group names derived from a namespace are marked inferred.
- Polling is implemented. The optional event SSE feed is deferred. Persistence is a rotating local diagnostic sink. The live dashboard reads the current process only.
- Comparable full-prompt preparation is skipped for continuation inputs above 256 KiB or if an older image cannot be rendered. The UI shows unavailable rather than estimating that value from HTTP bytes.
