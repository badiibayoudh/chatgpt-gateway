import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../background.js", import.meta.url), "utf8");
const target = { id: 7, url: "https://chatgpt.com/c/fixture" };

async function relay(tabs, changed = false) {
  let socket;
  const prompts = [];
  const replies = [];
  class WebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { socket = this; }
    send(data) { replies.push(JSON.parse(data)); }
  }
  const event = { addListener() {} };
  runInNewContext(script, {
    WebSocket, setInterval: () => 1, clearInterval() {},
    console: { log() {} },
    chrome: {
      alarms: { create() {}, onAlarm: event },
      runtime: { onMessage: event, onStartup: event, onInstalled: event },
      tabs: {
        query: async () => tabs,
        sendMessage: async (id, message) => {
          prompts.push({ id, message });
          if (changed && message.expectedConversation) return { ok: false, conversationChanged: true };
          return { ok: true, content: "Reply", url: target.url };
        },
      },
    },
  });
  await socket.onmessage({ data: JSON.stringify({
    type: "chat",
    requestId: "request",
    messages: [{ role: "user", content: "Full transcript" }],
    continuation: {
      tabId: target.id,
      url: target.url,
      messages: [{ role: "user", content: "New turn only" }],
      attachments: [],
    },
  }) });
  return { prompts, replies };
}

test("sends only the new turn to the matching tab even when another tab is listed first", async () => {
  const { prompts, replies } = await relay([{ id: 1, url: "https://chatgpt.com/" }, target]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, target.id);
  assert.equal(prompts[0].message.userMessage, "New turn only");
  assert.equal(prompts[0].message.newConversation, false);
  assert.equal(replies[0].url, target.url);
});

test("uses the full transcript when the selected tab has changed conversations", async () => {
  const { prompts } = await relay([target], true);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].message.userMessage, "Full transcript");
  assert.equal(prompts[1].message.newConversation, true);
});
