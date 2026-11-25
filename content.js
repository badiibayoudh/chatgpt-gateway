// ChatGPT Gateway — Content script
// Injected into chatgpt.com, handles DOM automation
(function () {
  "use strict";

  const POLL_INTERVAL = 750;
  const MAX_WAIT = 180_000; // 3 minutes
  const LEGACY_ASSISTANT = '[data-message-author-role="assistant"]';
  const ANSWER_BODY = '[data-markdown-text-style="assistant-message"], .markdown';
  const ASSISTANT_MESSAGE = [
    LEGACY_ASSISTANT,
    '[data-turn="assistant"] .markdown',
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-markdown-text-style="assistant-message"]',
  ].join(", ");
  const COPY_REPLY = [
    'button[data-testid="copy-turn-action-button"]',
    'button[data-test-id="copy-turn-action-button"]',
    '.turn-action-controls button[aria-label="Copy" i]',
    '.turn-action-controls button[aria-label="Copy response" i]',
    '.turn-action-controls button[aria-label="Kopieren" i]',
  ].join(", ");
  const STOP_GENERATION = [
    'button[data-testid="stop-button"]',
    'button[data-test-id="stop-button"]',
    'button[aria-label="Stop generating" i]',
    'button[aria-label="Stop streaming" i]',
    'form[data-chatgpt-composer] button[aria-label="Stop" i]',
    'form[data-chatgpt-composer] button[aria-label*="stopp" i]',
    'form[data-chatgpt-composer] button[aria-label*="anhalten" i]',
    'form[data-chatgpt-composer] button[aria-label*="beenden" i]',
  ].join(", ");

  // ── Helpers ──────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));



  function findInput() {
    const selectors = [
        'div.ProseMirror[contenteditable="true"]',
        '#prompt-textarea',
        '[contenteditable="true"]',
        'textarea'
    ];

    for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);

        for (const el of elements) {
            const rect = el.getBoundingClientRect();

            if (rect.width > 0 && rect.height > 0) {
                console.log("[Gateway] Input found:", selector);
                return el;
            }
        }
    }

    return null;
 }

  async function waitForInput(timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
          const input = findInput();

          if (input) {
              return input;
          }

          await sleep(500);
      }

      throw new Error(
          "Cannot find ChatGPT input field after " +
          timeoutMs + " ms"
      );
  }

  function findSendButton() {
    const selectors = [
      '[data-testid="send-button"]',
      "#composer-submit-button",
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) return btn;
    }
    return null;
  }

  function findAssistantMessages() {
    return document.querySelectorAll(ASSISTANT_MESSAGE);
  }

  function getAssistantTurn(message) {
    return (
      message.closest('[data-turn="assistant"], [data-turn-key], [data-testid^="conversation-turn-"], [data-test-id^="conversation-turn-"]') ||
      message.closest('[data-chatgpt-search-unit-key$=":assistant"]') ||
      message.closest(LEGACY_ASSISTANT) ||
      message
    );
  }

  function getTurnId(turn) {
    return (
      turn.getAttribute("data-turn-id") ||
      turn.getAttribute("data-turn-key") ||
      turn.getAttribute("data-chatgpt-search-unit-key") ||
      turn.getAttribute("data-message-id") ||
      turn
    );
  }

  function getAssistantText(message) {
    const body = message.matches(ANSWER_BODY) ? message : message.querySelector(ANSWER_BODY);
    const content = body || (message.matches(LEGACY_ASSISTANT) ? message : null);
    return (content?.innerText ?? content?.textContent ?? "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();
  }

  function isGenerating() {
    return Array.from(document.querySelectorAll(STOP_GENERATION)).some(
      (button) => button.getClientRects().length > 0
    );
  }

  // ── Actions ──────────────────────────────────────────────

  async function startNewChat() {
    // Try the "New chat" button/link
    const selectors = [
      'a[href="/"]',
      '[data-testid="create-new-chat-button"]',
      'nav a[href="/"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        await sleep(1500);
        return;
      }
    }
    // Fallback: navigate
    window.location.href = "https://chatgpt.com/";
    await sleep(2500);
  }

  async function selectModel(modelSlug) {
    if (!modelSlug || modelSlug.toLowerCase() === "auto") {
      return;
    }
    // if (!modelSlug) return;

    // Try clicking the model picker
    const pickerSelectors = [
      '[data-testid="model-switcher"]',
      'button[aria-haspopup="listbox"]',
      'button[aria-haspopup="menu"]',
    ];

    let picker = null;
    for (const sel of pickerSelectors) {
      picker = document.querySelector(sel);
      if (picker) break;
    }

    if (!picker) return; // No model picker found, proceed with default

    picker.click();
    await sleep(800);

    // Find model option
    const options = document.querySelectorAll(
      '[role="option"], [role="menuitemradio"], [role="menuitem"]'
    );
    const slug = modelSlug.toLowerCase();
    for (const opt of options) {
      const text = (opt.textContent || "").toLowerCase();
      if (text.includes(slug) || text.includes(slug.replace(/-/g, " "))) {
        opt.click();
        await sleep(500);
        return;
      }
    }
    // Close picker if model not found
    document.body.click();
    await sleep(300);
  }

  async function typeMessage(text) {
    const input = await waitForInput();
    //const input = findInput();

    if (!input) throw new Error("Cannot find ChatGPT input field");

    input.focus();
    await sleep(200);

    // Select all existing content and delete it
    document.execCommand("selectAll");
    document.execCommand("delete");
    await sleep(100);

    // Insert text — execCommand works with both textarea and contenteditable
    // For long texts, chunk it to avoid issues
    if (text.length > 4000) {
      // For very long text, set directly and dispatch events
      if (input.contentEditable === "true") {
        // ProseMirror/contenteditable
        const p = document.createElement("p");
        p.textContent = text;
        input.innerHTML = "";
        input.appendChild(p);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      document.execCommand("insertText", false, text);
    }

    await sleep(400);

    // Verify text was entered
    const currentText =
      input.contentEditable === "true"
        ? (input.textContent || "").trim()
        : (input.value || "").trim();

    if (!currentText) {
      // Retry with direct assignment
      if (input.contentEditable === "true") {
        input.textContent = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await sleep(400);
    }
  }

  async function attachImages(attachments) {
    if (!attachments?.length) return;
    const composer = (await waitForInput()).closest("form");
    if (!composer) throw new Error("Cannot find the ChatGPT attachment composer");
    const tiles = () => composer.querySelectorAll(
      'div[class*="file-tile"], [data-testid*="attachment"], img[src^="blob:"], img[src*="estuary/content"], img[src*="oaiusercontent.com"]'
    );
    const uploadDeadline = Date.now() + 45_000;
    for (const image of attachments) {
      const previous = tiles().length;
      const fileInput = () => document.querySelector('#upload-files[type="file"]') ||
        composer.querySelector('input[type="file"]');
      if (!fileInput()) {
        const plus = document.querySelector('[data-testid="composer-plus-btn"]');
        if (!plus) throw new Error("Cannot open the ChatGPT attachment menu");
        plus.click();
      }
      let picker = fileInput();
      for (let attempts = 0; !picker && attempts < 20; attempts++) {
        await sleep(100);
        picker = fileInput();
      }
      if (!picker) throw new Error("Cannot find the ChatGPT file input");

      const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], image.name, { type: image.mimeType }));
      picker.files = transfer.files;
      picker.dispatchEvent(new Event("input", { bubbles: true }));
      picker.dispatchEvent(new Event("change", { bubbles: true }));

      const deadline = Math.min(Date.now() + 20_000, uploadDeadline);
      while (Date.now() < deadline) {
        await sleep(250);
        if (tiles().length > previous && findSendButton() &&
          !composer.querySelector('[role="progressbar"], [class*="spinner"]')) break;
      }
      if (Date.now() >= deadline) throw new Error(`ChatGPT did not confirm upload of ${image.name}`);
    }
  }

  async function clickSend() {
    // Wait a moment for the send button to become enabled
    for (let i = 0; i < 10; i++) {
      const btn = findSendButton();
      if (btn && !btn.disabled) {
        btn.click();
        return;
      }
      await sleep(300);
    }
    throw new Error("Send button not found or disabled");
  }

  async function waitForNewResponse(previousTurns, onProgress) {
    const deadline = Date.now() + MAX_WAIT;
    let lastTurnId = null;
    let lastText = "";
    let stableCount = 0;

    while (Date.now() < deadline) {
      const messages = findAssistantMessages();
      const message = messages[messages.length - 1];
      if (message) {
        const turn = getAssistantTurn(message);
        const turnId = getTurnId(turn);
        if (!previousTurns.has(turnId)) {
          const text = getAssistantText(message);
          const generating = isGenerating();
          if (onProgress && generating && lastText && turnId === lastTurnId && text.startsWith(lastText)) {
            onProgress(lastText);
          }
          stableCount = !generating && text === lastText && turnId === lastTurnId ? stableCount + 1 : 0;
          lastTurnId = turnId;
          lastText = text;
          if (text && !generating && (turn.querySelector(COPY_REPLY) || stableCount >= 2)) {
            return text;
          }
        }
      }
      await sleep(POLL_INTERVAL);
    }

    throw new Error(lastText
      ? "Timeout: ChatGPT started replying but did not finish"
      : "Timeout: could not find the new ChatGPT reply on the page");
  }

  // ── Message handler ──────────────────────────────────────

  async function handleChatRequest(msg) {
    try {
      const expected = msg.expectedConversation?.split(/[?#]/)[0];
      const conversationChanged = () => expected && window.location.href.split(/[?#]/)[0] !== expected;
      if (conversationChanged()) return { ok: false, conversationChanged: true };
      // Start new conversation if requested
      if (msg.newConversation !== false) {
        await startNewChat();
        await selectModel(msg.model);
      }

      await typeMessage(msg.userMessage);
      await attachImages(msg.attachments);
      if (conversationChanged()) return { ok: false, conversationChanged: true };
      const previousTurns = new Set(
        Array.from(findAssistantMessages(), (message) => getTurnId(getAssistantTurn(message)))
      );
      await clickSend();

      let streamed = "";
      const onProgress = msg.streamText ? (content) => {
        if (conversationChanged() || content === streamed || !content.startsWith(streamed)) return;
        streamed = content;
        chrome.runtime.sendMessage({ type: "chat-progress", requestId: msg.requestId, content }).catch(() => {});
      } : undefined;
      const response = await waitForNewResponse(previousTurns, onProgress);

      if (conversationChanged()) throw new Error("ChatGPT conversation changed after submitting the prompt");
      return { ok: true, content: response, url: window.location.href };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Listen for messages from background script ───────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") {
      sendResponse({ ok: true, url: window.location.href });
      return;
    }

    if (msg.type === "chat") {
      handleChatRequest(msg).then(sendResponse);
      return true; // Will respond asynchronously
    }
  });

  console.log("[ChatGPT Gateway] Content script loaded on", window.location.href);
})();
