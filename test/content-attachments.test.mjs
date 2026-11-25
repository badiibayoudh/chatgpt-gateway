import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../content.js", import.meta.url), "utf8");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

async function runAttachmentTurn(uploadSucceeds, {
  attachment = { name: "image-1.png", mimeType: "image/png", data: png }, tooLong = false, alertText,
  uploadLabel, localizedSend = false, ariaDisabled = false, existingPreview = false,
  userMessage = "Inspect the screenshot", inlineLimit = Infinity, draftTooltip,
} = {}) {
  let receive;
  let now = 0;
  let pickerMounted = false;
  let uploaded = null;
  let submitted = false;
  const picker = {
    dispatchEvent(event) {
      if (event.type === "change" && uploadSucceeds) uploaded = this.files[0];
    },
  };
  const composer = {
    querySelectorAll: () => Array.from({ length: Number(existingPreview) + Number(!!uploaded && !uploadLabel) },
      () => ({ tagName: "IMG", complete: true, naturalWidth: 100, getClientRects: () => [{}] })),
    querySelector: (selector) => selector.includes("spinner") && localizedSend ? {} : null,
  };
  const input = {
    contentEditable: "true",
    textContent: "",
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    focus() {},
    appendChild(node) { this.textContent = node.textContent; },
    dispatchEvent() {},
    closest: () => composer,
  };
  const reply = {
    innerText: "Inspected",
    matches: () => true,
    closest: () => null,
    getAttribute: () => null,
    querySelector: () => ({}),
  };
  const send = {
    get disabled() { return input.textContent.length > inlineLimit; },
    getAttribute: (name) => name === "aria-disabled" && ariaDisabled ? "true" : null,
    click() { submitted = true; },
  };
  const retry = {
    textContent: "Erneut versuchen",
    getClientRects: () => [{}],
    closest: () => null,
    parentElement: {
      tagName: "DIV",
      textContent: "Deine gesendeten Nachrichten waren zu lang. Bitte bearbeite sie und sende sie erneut.",
    },
  };
  class DataTransfer {
    files = [];
    items = { add: (file) => this.files.push(file) };
  }
  runInNewContext(script, {
    atob, File, DataTransfer, Event,
    console: { log() {} },
    window: { location: { href: "https://chatgpt.com/" } },
    setTimeout(callback, ms) { now += ms; queueMicrotask(callback); },
    Date: { now: () => now },
    chrome: { runtime: { onMessage: { addListener: (listener) => { receive = listener; } } } },
    document: {
      createElement: () => ({}),
      querySelector(selector) {
        if (selector === '#upload-files[type="file"]') return pickerMounted ? picker : null;
        if (selector === '[data-testid="composer-plus-btn"]') {
          return { click() { pickerMounted = true; } };
        }
        if (selector === (localizedSend ? 'button[aria-label="Senden" i]' : '[data-testid="send-button"]')) return send;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === 'div.ProseMirror[contenteditable="true"]') return [input];
        if (selector.startsWith('button, [role="button"]') && uploaded && uploadLabel) {
          return [{ getAttribute: (name) => name === "aria-label" ? uploadLabel : null, getClientRects: () => [{}] }];
        }
        if (selector.startsWith('[role="alert"]') && submitted && alertText) {
          return [{ textContent: alertText, getClientRects: () => [{}] }];
        }
        if (selector.startsWith('[role="tooltip"]') && send.disabled && draftTooltip) {
          return [{ textContent: draftTooltip, getClientRects: () => [{}] }];
        }
        if (selector.startsWith("main button") && submitted && tooLong) return [retry];
        if (selector.includes("data-message-author-role") && submitted && !tooLong) return [reply];
        return [];
      },
      execCommand(command, _unused, text) {
        if (command === "delete") input.textContent = "";
        if (command === "insertText") input.textContent = text;
      },
    },
  });
  const response = await new Promise((resolve) => receive({
    type: "chat",
    userMessage,
    attachments: [attachment],
    newConversation: false,
  }, {}, resolve));
  return { response, uploaded, submitted };
}

test("uploads the original image bytes through the ChatGPT file input", async () => {
  const { response, uploaded, submitted } = await runAttachmentTurn(true);
  assert.equal(response.content, "Inspected");
  assert.equal(submitted, true);
  assert.equal(uploaded.name, "image-1.png");
  assert.equal(uploaded.type, "image/png");
  assert.equal(Buffer.from(await uploaded.arrayBuffer()).toString("base64"), png);
});

test("uploads a text retry without changing the original line endings", async () => {
  const text = "Full request\r\n    indented code\r\n";
  const { response, uploaded } = await runAttachmentTurn(true, {
    attachment: { name: "gateway-request.txt", mimeType: "text/plain", text },
    uploadLabel: "gateway-request.txt",
  });
  assert.equal(response.ok, true);
  assert.equal(uploaded.name, "gateway-request.txt");
  assert.equal(await uploaded.text(), text);
});

test("recognizes ChatGPT’s German size rejection in an inline retry banner", async () => {
  const { response } = await runAttachmentTurn(true, { tooLong: true });
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "chatgpt_input_too_long");
});

test("recognizes a singular German rejection even without a retry button", async () => {
  const { response } = await runAttachmentTurn(true, {
    alertText: "Deine gesendete Nachricht war zu lang. Bitte bearbeite sie und sende sie erneut.",
  });
  assert.equal(response.errorCode, "chatgpt_input_too_long");
});

test("recognizes the German pre-submit tooltip with the screenshot already staged", async () => {
  const { response, uploaded, submitted } = await runAttachmentTurn(true, {
    userMessage: "Inspect the screenshot\n" + "x".repeat(100),
    inlineLimit: 64,
    draftTooltip: "Die Nachricht ist\nzu lang",
  });
  assert.equal(uploaded.name, "image-1.png");
  assert.equal(submitted, false);
  assert.equal(response.errorCode, "chatgpt_input_too_long");
  assert.equal(response.retryDraftUrl, "https://chatgpt.com/");
});

test("makes a long draft with Send disabled eligible for retry without a mounted tooltip", async () => {
  const { response, uploaded, submitted } = await runAttachmentTurn(true, {
    userMessage: "x".repeat(40_000),
    inlineLimit: 32_000,
  });
  assert.equal(uploaded.name, "image-1.png");
  assert.equal(submitted, false);
  assert.equal(response.errorCode, "chatgpt_draft_blocked");
  assert.equal(response.retryDraftUrl, "https://chatgpt.com/");
});

test("accepts a renamed image preview and the enabled German Send button", async () => {
  const { response, submitted } = await runAttachmentTurn(true, {
    uploadLabel: "image-1(2).png entfernen",
    localizedSend: true,
    existingPreview: true,
  });
  assert.equal(response.content, "Inspected");
  assert.equal(submitted, true);
});

test("does not send an image preview while Send is marked disabled by ARIA", async () => {
  const { response, submitted } = await runAttachmentTurn(true, { ariaDisabled: true });
  assert.match(response.error, /did not confirm upload/);
  assert.equal(submitted, false);
});

test("fails an unconfirmed upload without submitting a text-only turn", async () => {
  const { response, submitted } = await runAttachmentTurn(false, { existingPreview: true });
  assert.equal(response.ok, false);
  assert.match(response.error, /did not confirm upload/);
  assert.equal(submitted, false);
});
