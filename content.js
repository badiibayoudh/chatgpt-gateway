// ChatGPT Gateway — Content script
// Injected into chatgpt.com, handles DOM automation
(function () {
  "use strict";

  const POLL_INTERVAL = 750;
  const MAX_WAIT = 180_000; // 3 minutes
  const LONG_DRAFT_LENGTH = 32_000;
  const SEND_BUTTONS = [
    '[data-testid="send-button"]',
    'button[aria-label="Send prompt" i]',
    'button[aria-label="Send" i]',
    'button[aria-label="Senden" i]',
    "#composer-submit-button",
  ];
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
  const INPUT_TOO_LONG = /(?:die nachricht ist|deine (?:gesendete nachricht war|gesendeten nachrichten waren)) zu lang|(?:the |this |your )?(?:submitted )?messages? (?:you (?:submitted|sent) )?(?:was|were|is|are) too long/i;
  const UPLOAD_ALLOWANCE = /(?:file[ -])?upload (?:limit|quota|allowance)\b.{0,80}(?:reach|exceed)|(?:reach|exceed)\w*.{0,80}(?:file[ -])?upload (?:limit|quota|allowance)|out of (?:file )?uploads|no (?:file )?uploads? (?:left|remaining)|too many (?:file )?uploads|upload[- ]?(?:limit|kontingent).{0,80}(?:erreicht|überschritten|aufgebraucht)|(?:limit|kontingent) für (?:datei[- ])?uploads.{0,80}(?:erreicht|überschritten|aufgebraucht)|keine (?:datei[- ])?uploads mehr/i;
  const RETRY_LABEL = /^(?:retry|try again|erneut versuchen)$/i;

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
    for (const selector of SEND_BUTTONS) {
      const button = document.querySelector(selector);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
    }
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

  function platformNotices(pattern) {
    const notices = new Set();
    for (const alert of document.querySelectorAll('[role="alert"], [data-testid*="error"], [role="status"], [data-sonner-toast], [data-testid*="toast"], [aria-live="assertive"], [role="tooltip"]')) {
      if (alert.getClientRects().length && !alert.closest?.('[data-message-author-role], .markdown') &&
        pattern.test(alert.textContent.replace(/\s+/g, " "))) notices.add(alert);
    }
    // The inline error can be a plain container with a retry button.
    for (const button of document.querySelectorAll('main button, main [role="button"]')) {
      if (!RETRY_LABEL.test(button.textContent.trim()) || !button.getClientRects().length ||
        button.closest('[data-message-author-role], .markdown')) continue;
      let container = button.parentElement;
      for (let depth = 0; container && container.tagName !== "MAIN" && depth < 3; depth++) {
        if (pattern.test(container.textContent.replace(/\s+/g, " "))) {
          notices.add(container);
          break;
        }
        container = container.parentElement;
      }
    }
    return notices;
  }

  function uploadAllowanceError() {
    const error = new Error("ChatGPT reports that its upload allowance was reached. Wait for the allowance to reset or send a request without attachments.");
    error.code = "chatgpt_upload_allowance";
    return error;
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

  function attachmentCounts(composer, name) {
    const matchesName = (label) => {
      const filename = label?.trim().replace(/^remove (?:file |image )?| entfernen$/gi, "");
      return filename === name || filename?.replace(/ ?\(\d+\)(?=\.[^.\s]+$)/, "") === name;
    };
    const namedPreviews = [...document.querySelectorAll('button, [role="button"], img[alt]')].filter((element) =>
      [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("alt"), element.textContent]
        .some(matchesName) && element.getClientRects().length > 0
    );
    const composerPreviews = [...(composer?.querySelectorAll(
      'div[class*="file-tile"], [data-testid*="attachment"], img[src^="blob:"], img[src^="data:image/"], img[src*="estuary/content"], img[src*="oaiusercontent.com"]'
    ) ?? [])].filter((element) => element.getClientRects().length > 0 &&
      (element.tagName !== "IMG" || (element.complete && element.naturalWidth > 0))
    );
    return { named: namedPreviews.length, composer: composerPreviews.length };
  }

  async function attachFiles(attachments) {
    if (!attachments?.length) return;
    await waitForInput();
    const composer = () => (document.querySelector("#prompt-textarea") || findInput())?.closest("form");
    if (!composer()) throw new Error("Cannot find the ChatGPT attachment composer");
    const uploadDeadline = Date.now() + 45_000;
    for (const attachment of attachments) {
      if (platformNotices(UPLOAD_ALLOWANCE).size) throw uploadAllowanceError();
      const previous = attachmentCounts(composer(), attachment.name);
      const fileInput = () => document.querySelector('#upload-files[type="file"]') ||
        composer()?.querySelector('input[type="file"]');
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

      const data = typeof attachment.text === "string"
        ? attachment.text
        : Uint8Array.from(atob(attachment.data), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], attachment.name, { type: attachment.mimeType }));
      picker.files = transfer.files;
      picker.dispatchEvent(new Event("input", { bubbles: true }));
      picker.dispatchEvent(new Event("change", { bubbles: true }));

      const deadline = Math.min(Date.now() + 20_000, uploadDeadline);
      let confirmed = false;
      while (Date.now() < deadline) {
        await sleep(250);
        if (platformNotices(UPLOAD_ALLOWANCE).size) throw uploadAllowanceError();
        if (!findSendButton()) continue;
        const current = attachmentCounts(composer(), attachment.name);
        if (current.named > previous.named || current.composer > previous.composer) {
          confirmed = true;
          break;
        }
      }
      if (!confirmed) throw new Error(`ChatGPT did not confirm upload of ${attachment.name}`);
    }
  }

  function isOversizedDraft() {
    for (const button of document.querySelectorAll(SEND_BUTTONS.join(", "))) {
      if ([button.getAttribute("title"), button.getAttribute("aria-label")].some((text) => INPUT_TOO_LONG.test(text))) return true;
      const descriptions = button.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
      if (descriptions.some((id) => INPUT_TOO_LONG.test(document.getElementById(id)?.textContent))) return true;
    }
    return [...document.querySelectorAll('[role="tooltip"], [role="alert"]')].some(
      (notice) => notice.getClientRects().length > 0 && INPUT_TOO_LONG.test(notice.textContent.replace(/\s+/g, " "))
    );
  }

  function blockedDraft(code, message) {
    const error = new Error(message);
    error.code = code;
    error.retryDraft = true;
    return error;
  }

  async function clickSend(text, hasAttachments) {
    // Wait a moment for the send button to become enabled
    for (let i = 0; i < 10; i++) {
      if (hasAttachments && platformNotices(UPLOAD_ALLOWANCE).size) throw uploadAllowanceError();
      const btn = findSendButton();
      if (btn) {
        btn.click();
        return;
      }
      if (isOversizedDraft()) {
        throw blockedDraft("chatgpt_input_too_long", "ChatGPT disabled Send because the draft is too long");
      }
      await sleep(300);
    }
    // ChatGPT can hide the reason until the user hovers over the disabled Send button.
    if (text.length >= LONG_DRAFT_LENGTH) {
      throw blockedDraft("chatgpt_draft_blocked", "ChatGPT kept Send disabled for the long draft");
    }
    throw new Error("Send button not found or disabled");
  }

  async function waitForNewResponse(previousTurns, previousNotices, previousUploadNotices, onProgress) {
    const deadline = Date.now() + MAX_WAIT;
    let lastTurnId = null;
    let lastText = "";
    let stableCount = 0;

    while (Date.now() < deadline) {
      if (!lastText && [...platformNotices(UPLOAD_ALLOWANCE)].some((notice) => !previousUploadNotices.has(notice))) {
        throw uploadAllowanceError();
      }
      if (!lastText && [...platformNotices(INPUT_TOO_LONG)].some((notice) => !previousNotices.has(notice))) {
        const error = new Error("ChatGPT rejected the submission because its messages were too long");
        error.code = "chatgpt_input_too_long";
        throw error;
      }
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
    let draftUrl;
    try {
      const chatUrl = (url) => url?.split(/[?#]/)[0].replace(/\/$/, "");
      const expected = chatUrl(msg.expectedConversation);
      const expectedDraft = chatUrl(msg.expectedDraftUrl);
      const conversationChanged = () => expected && chatUrl(window.location.href) !== expected;
      const draftChanged = () => expectedDraft && chatUrl(window.location.href) !== expectedDraft;
      if (conversationChanged() || draftChanged()) return { ok: false, conversationChanged: true };
      // Start new conversation if requested
      if (msg.newConversation !== false) {
        await startNewChat();
        await selectModel(msg.model);
      }

      if (msg.attachments?.length) {
        // Keep Send's upload readiness separate from the length of the final draft.
        await typeMessage("Preparing gateway attachments");
        await attachFiles(msg.attachments);
      }
      await typeMessage(msg.userMessage);
      if (conversationChanged() || draftChanged()) return { ok: false, conversationChanged: true };
      const previousTurns = new Set(
        Array.from(findAssistantMessages(), (message) => getTurnId(getAssistantTurn(message)))
      );
      const previousNotices = platformNotices(INPUT_TOO_LONG);
      const previousUploadNotices = platformNotices(UPLOAD_ALLOWANCE);
      draftUrl = window.location.href;
      await clickSend(msg.userMessage, msg.attachments?.length);

      let streamed = "";
      const onProgress = msg.streamText ? (content) => {
        if (conversationChanged() || content === streamed || !content.startsWith(streamed)) return;
        streamed = content;
        chrome.runtime.sendMessage({ type: "chat-progress", requestId: msg.requestId, content }).catch(() => {});
      } : undefined;
      const response = await waitForNewResponse(previousTurns, previousNotices, previousUploadNotices, onProgress);

      if (conversationChanged()) throw new Error("ChatGPT conversation changed after submitting the prompt");
      return { ok: true, content: response, url: window.location.href };
    } catch (err) {
      const retryDraftUrl = err.retryDraft && window.location.href === draftUrl ? draftUrl : undefined;
      return { ok: false, error: err.message, errorCode: err.code, retryDraftUrl };
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

  console.log("[ChatGPT Gateway] Content script loaded");
})();
