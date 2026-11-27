# Unified Gateway architecture

The Gateway exposes one loopback OpenAI-compatible interface for Cline, Continue, and the Software Factory. GitHub owns project data, Dagu owns workflow execution, and Cline owns code implementation. The Gateway owns communication and request diagnostics.

| Module | Responsibility |
|---|---|
| `server.mjs` | Loopback HTTP and WebSocket composition, transport selection and Monitor entry points |
| `communication/gateway.mjs` | Authentication decisions, bounded admission and FIFO dispatch, cancellation, request deadlines, context accounting, SSE and JSON responses |
| `communication/sessions.mjs` | Scoped credential lifetime and ownership, without access to transport state |
| `communication/protocol.mjs`, `chat-tools.mjs`, `chat-history.mjs` | Tool schemas, request-owned call IDs, exact result correlation, and transcript matching |
| `communication/browser-transport.mjs` | Extension messaging, scoped browser conversation lookup, browser prompt preparation and attachment handling |
| `communication/programmatic-transports.mjs` | Optional OpenAI network transport and deterministic mock |
| `monitoring/`, `dashboard/` | Redacted request events, state transitions and diagnostics |

## Adapter contract

The composition root registers a backend factory. The backend exposes an identifier, supported models, capabilities, observed availability, `prepare(payload)` and `complete(payload, execution)`. The execution object carries the request ID, authenticated scope, context sizes, progress and transmission callbacks, and an indication that the caller stopped waiting. The browser adapter also exposes its WebSocket upgrade, health and extension capture hooks. Browser protocol responses use the same Ajv schema validation and gateway-owned tool IDs as native completions. A native adapter supplies a normalized assistant message and finish reason for the shared decoder. The core does not route by provider or vendor name.

One slot is shared by all clients of the configured backend. The HTTP waiter can finish before the adapter settles. The slot stays reserved until the adapter confirms termination. Confirmed browser replies are bound to the captured socket and request ID. Browser conversations are scoped to the worker credential and current process. The content script verifies a clean composer before initial submission and checks the assigned route during a scoped turn. A mismatched conversation cannot deliver a scoped response. On timeout or socket loss the adapter forgets affected continuation state.

The browser transport advertises programmatic HTTP access for user-driven interactive turns. Its reported connection confirms that the extension socket is present. The browser still has to verify the tab and composer for each request. Scoped turns use a single existing tab, return an explicit platform rejection, and buffer the reply until ownership is checked. Existing single-identity interactive clients keep the legacy request and stream behavior. Distinct keys or strict-scope configuration are required when more than one client operates independently.

The capabilities response reports `programmatic` for HTTP access, `interactive` for supervised browser execution, and `unattended` for an adapter that supports unattended operation. `requestReady` reflects whether the supplied credential can submit to an available backend. `unattendedReady` additionally requires a verified, non-simulated backend with unattended support. The existing `programmaticReady` field is a compatibility alias for `unattendedReady`.

The mock is a test backend. The optional OpenAI adapter reports unverified, verified, unavailable, or blocked according to observed provider outcomes. Successful evidence ages out after five minutes. An ambiguous programmatic request leaves a local checkpoint and blocks subsequent dispatch until reconciled. A local authorized inference adapter can be registered at composition time with the same capability and completion contracts.

## Limits

All limits use a `CHATGPT_GATEWAY_` prefix. The old `CHATGPT_GATEWAY_FACTORY_` names remain aliases.

| Setting | Default |
|---|---|
| `MAX_SESSIONS` | 32 |
| `MAX_QUEUED` | 8 |
| `MAX_PER_CLIENT` | 2 across scoped sessions |
| `MAX_BODY_BYTES` | 32 MiB for browser and 4 MiB for programmatic adapters |
| `QUEUE_MS` | 300 seconds for browser and 120 seconds for programmatic adapters |
| `PROCESS_MS` | 300 seconds |
| `DRAIN_MS` | 360 seconds for the optional OpenAI adapter |
| `SESSION_MS` | 1 hour |

The queue reserves at most 32 MiB of request body bytes across reading, waiting and draining jobs. At most 256 tool calls are remembered per authenticated session. Conversation cache entries contain hashed transcript identities, browser location metadata and tool signatures, with a process-wide limit of 100. Diagnostics store allowlisted counters, opaque IDs and summaries.

## Verification

Use `node --test --test-concurrency=1` to run the compatibility, transport and scope regressions. Browser tests use a simulated extension socket and isolated DOM fixtures. The OpenAI adapter tests inject HTTP responses and do not contact a provider. Factory readiness is tested against real local mock Gateway and capability fixtures. Live browser IDE and authorized provider verification are separate acceptance tests.
