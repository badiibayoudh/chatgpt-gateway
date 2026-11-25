import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../content.js", import.meta.url), "utf8");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

async function runAttachmentTurn(uploadSucceeds) {
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
    querySelectorAll: () => uploaded ? [{}] : [],
    querySelector: () => null,
  };
  const input = {
    contentEditable: "true",
    textContent: "",
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    focus() {},
    closest: () => composer,
  };
  const reply = {
    innerText: "Inspected",
    matches: () => true,
    closest: () => null,
    getAttribute: () => null,
    querySelector: () => ({}),
  };
  const send = { click() { submitted = true; } };
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
      querySelector(selector) {
        if (selector === '#upload-files[type="file"]') return pickerMounted ? picker : null;
        if (selector === '[data-testid="composer-plus-btn"]') {
          return { click() { pickerMounted = true; } };
        }
        if (selector === '[data-testid="send-button"]') return send;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === 'div.ProseMirror[contenteditable="true"]') return [input];
        if (selector.includes("data-message-author-role") && submitted) return [reply];
        return [];
      },
      execCommand(command, _unused, text) {
        if (command === "insertText") input.textContent = text;
      },
    },
  });
  const response = await new Promise((resolve) => receive({
    type: "chat",
    userMessage: "Inspect the screenshot",
    attachments: [{ name: "image-1.png", mimeType: "image/png", data: png }],
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

test("fails an unconfirmed upload without submitting a text-only turn", async () => {
  const { response, submitted } = await runAttachmentTurn(false);
  assert.equal(response.ok, false);
  assert.match(response.error, /did not confirm upload/);
  assert.equal(submitted, false);
});
