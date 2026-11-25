# ChatGPT Gateway

> **Optimized successor:** for smooth ChatGPT **Pro** (extended thinking) access without
> a manual browser tab, see [`camoufox-gateway/`](camoufox-gateway/) — a headless Camoufox
> (stealth Firefox) with a persistent logged-in profile, auto-login, robust
> response-completion, exposed as a Claude Code skill + MCP. This extension still works
> for quick use in your everyday browser.

Use ChatGPT from any code, script, or tool — without an API key.

This is a browser extension paired with a tiny local server that exposes your **logged-in ChatGPT session** as a standard OpenAI-compatible API at `localhost:18790`. Any application that speaks the OpenAI chat completions format can use it out of the box — just swap the base URL.

**Why?** OpenAI API access requires a separate paid plan and API keys. If you already have a ChatGPT subscription (Free, Plus, or Team), this tool lets you use it programmatically. It automates the ChatGPT web interface through your browser — exactly like you would manually, but from code.

![ChatGPT Gateway Icon](icons/icon128.png)

## How it works

```
Your app / curl / any OpenAI-compatible client
        ↓ HTTP POST (localhost:18790)
Local gateway server (Node.js)
        ↓ WebSocket
Browser extension (background worker)
        ↓ chrome.tabs message
Content script on chatgpt.com
        ↓ DOM automation (type → send → read response)
ChatGPT (your logged-in browser session)
```

The extension's content script types the message, uploads any image attachments, and extracts ChatGPT's reply. The gateway returns OpenAI-compatible JSON or streams plain-text updates as server-sent events.

## Can I keep using my browser?

**Yes.** The extension only interacts with the ChatGPT tab. All other tabs work normally. You can browse, work, watch videos — whatever you want.

The only rule: **don't manually type in the ChatGPT tab while a request is in progress.** The content script is actively using that tab's input field and reading the response DOM. Between requests, you can use ChatGPT manually as usual.

You do **not** need a separate browser profile or window. Your everyday Chrome or Firefox works fine.

## Setup

### 1. Install the extension

**Chrome:**
1. Go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** → select this repo's root directory

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on** → select `manifest.firefox.json`

### 2. Start the gateway server

```bash
npm install
npm start
```

### 3. Open ChatGPT

Navigate to [chatgpt.com](https://chatgpt.com) and make sure you're logged in. Click the extension icon to verify — both dots should be green.

## Usage

### curl

```bash
curl -X POST http://localhost:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'
```

### Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:18790/v1", api_key="unused")
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:18790/v1", apiKey: "unused" });
const response = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);
```

### Continue Agent mode

Add `capabilities: [tool_use]` to the gateway model in Continue's `config.yaml`.

```yaml
models:
  - name: ChatGPT-Gateway
    provider: openai
    model: auto
    apiBase: http://localhost:18790/v1
    apiKey: unused
    capabilities: [tool_use]
```

Reload Continue's config and select this model in **Agent** mode. Attach the Python file and ask Continue to edit it. If **Edit File** is set to **Ask First**, click **Continue** on the tool card and review the resulting diff. Continue runs the tool and sends its result back through the gateway.

### Chat reuse

The IDE can keep sending its usual OpenAI-compatible history. When the gateway recognizes a follow-up, it sends only the new turn, including any new tool results and screenshots, to the same ChatGPT chat. It resends instructions and tool definitions when they change. Cline tool-call IDs help the gateway recognize the task even when Cline compacts the earlier history.

The gateway can reopen a matched chat in a browser tab. If ChatGPT rejects a follow-up as too long, the gateway retries the new turn as a text attachment in that chat. A new task or a history the gateway cannot match starts a fresh ChatGPT chat with the supplied context. The gateway keeps recent matches in memory until the server restarts.

Restart the server, reload the unpacked extension, and refresh the ChatGPT tab after updating. API callers can explicitly request a fresh chat with `new_conversation: true`, or use `false` to continue in an open ChatGPT chat when there is no history match.

### Screenshot input

Restart the server, reload the unpacked extension, and refresh the ChatGPT tab after updating. Enable image input for the gateway model so the IDE forwards screenshots to the API. In Continue, set `capabilities: [tool_use, image_input]` for the model. In Cline, enable image support in the OpenAI-compatible model configuration.

The gateway accepts Chat Completions `image_url` parts containing base64 data URLs, and MCP `image` parts with `mimeType` and base64 `data` in a tool result. It also recognizes a JSON-encoded MCP result in tool text. The extension uploads those images beside the prompt and the prompt references each attachment by filename.

PNG, JPEG, WebP, and GIF are supported. Each browser turn can upload up to 8 images totaling 20 MiB, with a maximum of 8 MiB per image. When reusing a chat, the gateway uploads only the new screenshots. When replaying history in a fresh chat, it prioritizes the newest tool-result batch and keeps the text of earlier results whose images exceed the upload allowance. Send images inline as base64 data URLs.

### Local access

The server listens on `127.0.0.1` and `::1`. Set `CHATGPT_GATEWAY_API_KEY` on the server to require an `Authorization: Bearer ...` header for the API, including metrics. Use that key in Continue or Cline. Set the same environment variable for the bundled MCP wrapper when using it.

The browser extension connects over a separate loopback WebSocket. Set `CHATGPT_GATEWAY_EXTENSION_ORIGIN` to its exact extension origin if you want to restrict which extension can connect.

## API

### `POST /v1/chat/completions`

OpenAI-compatible chat completions endpoint.

| Field | Type | Default | Description |
|---|---|---|---|
| `messages` | array | required | Array of `{role, content}` message objects |
| `model` | string | `"auto"` | Model hint — attempts to select via ChatGPT's model picker |
| `stream` | boolean | `false` | Stream plain-text deltas as the browser renders them |
| `tools` | array | `[]` | Function definitions with draft-07 or 2020-12 JSON Schema parameters |
| `tool_choice` | string or object | `"auto"` | `auto`, `none`, `required`, or a named function object |
| `parallel_tool_calls` | boolean | `true` | Set to `false` to allow at most one function call per reply |
| `new_conversation` | boolean | automatic | Force a fresh chat with `true` or use an open chat with `false` |
| `timeout` | number | `300000` | Max wait time in ms, including time in the browser queue |

Response format matches the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create).

### `GET /health`

example: http://localhost:18790/health

```json
{"status": "ok", "extensionConnected": true, "imageAttachments": true, "conversationReuse": true, "longMessageFallback": true, "pendingRequests": 0}
```

### `GET /metrics`

Returns request outcome counters, queue depth, browser busy status, and the most recent queue and browser times. Counters reset on restart.

## MCP Server

The `mcp/` directory contains a [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the gateway. This lets AI tools like Claude Code use ChatGPT directly as a tool.

### Install

```bash
cd mcp && npm install
```

### Configure (Claude Code)

Add to your MCP settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "chatgpt": {
      "command": "node",
      "args": ["/path/to/chatgpt-gateway/mcp/index.mjs"]
    }
  }
}
```

### Tools

| Tool | Description |
|---|---|
| `chatgpt_status` | Check if the gateway is running and extension is connected |
| `chatgpt_ask` | Send a message to ChatGPT and get the response (10-120s, sends progress notifications) |

The `chatgpt_ask` tool supports progress notifications per the MCP spec — clients will see status updates like "Typing message...", "Waiting for response..." while ChatGPT processes the request.

## Project structure

```
├── manifest.json           # Chrome extension manifest (MV3)
├── manifest.firefox.json   # Firefox extension manifest (MV3)
├── background.js           # Service worker — WebSocket bridge to gateway
├── content.js              # Content script — ChatGPT DOM automation
├── popup.html / popup.js   # Extension popup — connection status UI
├── server.mjs              # Gateway HTTP + WebSocket server
├── icons/                  # Extension icons (16/32/48/128px)
├── package.json            # Server dependencies
└── mcp/                    # MCP server
    ├── index.mjs           # MCP stdio server
    └── package.json        # MCP dependencies
```

## Limitations

- **One request at a time.** The extension automates a single ChatGPT tab, so requests are serialized. Concurrent requests will queue on the server side.
- **Structured replies.** Function calls and Continue Apply output are buffered until the gateway can validate the complete response. Plain-text deltas follow the browser's rendered output.
- **Context and upload limits.** ChatGPT determines how much text it can accept and retain. When it rejects a message as too long, the updated extension retries once in a fresh chat with the full request as a text attachment. ChatGPT's file-upload and context limits apply to that retry. HTTP request bodies have a separate 32 MiB transport limit.
- **Browser-based tool calling.** The gateway describes client tools to ChatGPT as text and validates its structured reply before returning a tool call. The IDE client handles tool execution and approval.
- **DOM-dependent.** If ChatGPT significantly changes its UI, the content script selectors may need updating.
- **Session-bound.** If your ChatGPT session expires, refresh the tab or re-login.

## Requirements

- Node.js 18+
- Chrome or Firefox
- Active ChatGPT session (Free, Plus, or Team)

## License

MIT
