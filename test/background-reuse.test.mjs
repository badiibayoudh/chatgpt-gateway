import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../background.js", import.meta.url), "utf8");
const target = { id: 7, url: "https://chatgpt.com/c/fixture" };

async function relay(tabs, { changed = false, tooLong = false, retryError, draftUrl, useContinuation = true,
  fallback = true, quota = false } = {}) {
  let socket;
  const prompts = [];
  const reopened = [];
  const replies = [];
  class WebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { socket = this; }
    send(data) { replies.push(JSON.parse(data)); }
  }
  const event = { addListener() {} };
  runInNewContext(script, {
    WebSocket, TextEncoder, setInterval: () => 1, clearInterval() {},
    console: { log() {} },
    chrome: {
      alarms: { create() {}, onAlarm: event },
      runtime: { onMessage: event, onStartup: event, onInstalled: event },
      tabs: {
        query: async () => tabs,
        create: async ({ url, active }) => {
          reopened.push({ url, active });
          return { id: 42, url };
        },
        sendMessage: async (id, message) => {
          if (message.type === "ping") return { ok: true, url: target.url };
          prompts.push({ id, message });
          if (changed && message.expectedConversation) return { ok: false, conversationChanged: true };
          if (quota) return { ok: false, errorCode: "chatgpt_upload_allowance", error: "Upload allowance reached" };
          if (draftUrl && prompts.length === 1) {
            return { ok: false, errorCode: "chatgpt_draft_blocked", error: "Send stayed disabled", retryDraftUrl: draftUrl };
          }
          if (tooLong && (prompts.length === 1 || retryError)) {
            return { ok: false, errorCode: "chatgpt_input_too_long", error: retryError ?? "Messages were too long" };
          }
          return { ok: true, content: "Reply", url: target.url };
        },
      },
    },
  });
  await socket.onmessage({ data: JSON.stringify({
    type: "chat",
    requestId: "request",
    textAttachmentFallback: fallback,
    messages: [{ role: "user", content: "Full transcript" }],
    attachments: [{ name: "image-1.png", mimeType: "image/png", data: "fixture" }],
    continuation: useContinuation ? {
      tabId: target.id,
      url: target.url,
      messages: [{ role: "user", content: "New turn only" }],
      attachments: [{ name: "new-screenshot.png", mimeType: "image/png", data: "new" }],
    } : undefined,
  }) });
  return { prompts, replies: replies.filter(({ type }) => type === "response"), reopened,
    transmissions: replies.filter(({ type }) => type === "chat-transmission") };
}

test("sends only the new turn to the matching tab even when another tab is listed first", async () => {
  const { prompts, replies } = await relay([{ id: 1, url: "https://chatgpt.com/" }, target]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, target.id);
  assert.equal(prompts[0].message.userMessage, "New turn only");
  assert.equal(prompts[0].message.newConversation, false);
  assert.equal(replies[0].url, target.url);
});

test("reopens the same chat when the tab has moved to a different conversation", async () => {
  const { prompts, reopened } = await relay([{ ...target, url: "https://chatgpt.com/c/different" }]);
  assert.deepEqual(reopened, [{ url: target.url, active: false }]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, 42);
  assert.equal(prompts[0].message.userMessage, "New turn only");
  assert.equal(prompts[0].message.expectedConversation, target.url);
  assert.equal(prompts[0].message.newConversation, false);
});

test("does not send the full transcript if the user navigates during a continuation", async () => {
  const { prompts, replies } = await relay([target], { changed: true });
  assert.equal(prompts.length, 1);
  assert.equal(replies[0].ok, false);
  assert.match(replies[0].error, /navigated away/);
});

test("attaches only the oversized new turn and its images in the same chat", async () => {
  const { prompts, replies, transmissions } = await relay([target], { tooLong: true });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].message.userMessage, "New turn only");
  const { message } = prompts[1];
  assert.equal(message.newConversation, false);
  assert.equal(message.expectedConversation, target.url);
  assert.match(message.userMessage, /gateway-request-request\.txt/);
  assert.equal(message.attachments[0].name, "new-screenshot.png");
  assert.deepEqual(JSON.parse(JSON.stringify(message.attachments[1])), {
    name: "gateway-request-request.txt", mimeType: "text/plain", text: "New turn only",
  });
  assert.equal(replies[0].ok, true);
  assert.equal(transmissions[1].fallback, true);
  assert.equal(transmissions[1].textBytes, Buffer.byteLength("New turn only"));
});

test("returns context or quota errors without sending an automatic attachment", async () => {
  for (const [options, code] of [
    [{ tooLong: true, fallback: false }, "chatgpt_input_too_long"],
    [{ quota: true }, "chatgpt_upload_allowance"],
  ]) {
    const { prompts, replies, transmissions } = await relay([target], options);
    assert.equal(prompts.length, 1);
    assert.equal(replies[0].errorCode, code);
    assert.equal(transmissions[0].fallback, false);
  }
});

test("returns the rejection when ChatGPT also rejects the attachment retry", async () => {
  const { prompts, replies } = await relay([target], { tooLong: true, retryError: "still too long" });
  assert.equal(prompts.length, 2);
  assert.equal(replies[0].errorCode, "chatgpt_input_too_long");
  assert.match(replies[0].error, /attachment retry failed: still too long/);
});

test("retries a blocked draft in place and keeps its staged screenshots", async () => {
  const home = { id: 1, url: "https://chatgpt.com/" };
  const { prompts, replies } = await relay([home], { draftUrl: home.url, useContinuation: false });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].message.newConversation, true);
  const { message } = prompts[1];
  assert.equal(message.newConversation, false);
  assert.equal(message.expectedDraftUrl, home.url);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].text, "Full transcript");
  assert.equal(replies[0].ok, true);
});
