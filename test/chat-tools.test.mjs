import assert from "node:assert/strict";
import test from "node:test";
import { prepareChat } from "../chat-tools.mjs";

const requestId = "12345678-1234-1234-1234-123456789abc";
const edit = {
  type: "function",
  function: {
    name: "edit_existing_file",
    parameters: {
      type: "object",
      properties: { filepath: { type: "string" }, changes: { type: "string" } },
      required: ["filepath", "changes"],
      additionalProperties: false,
    },
  },
};
const read = { type: "function", function: { name: "read_currently_open_file" } };
const args = { filepath: "sample.py", changes: "def add(a, b):\n    return a + b" };
const call = { name: edit.function.name, arguments: args };
const user = { role: "user", content: "Fix the selected file" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

function envelope(calls, id = requestId) {
  return JSON.stringify({ gateway_request_id: id, tool_calls: calls });
}

test("keeps plain chat and ordinary JSON replies as text", () => {
  const plain = prepareChat({ messages: [user] }, requestId);
  assert.deepEqual(plain.messages, [user]);
  assert.deepEqual(plain.decode("Plain reply"), { content: "Plain reply" });

  const agent = prepareChat({ tools: [edit], messages: [user] }, requestId);
  const content = JSON.stringify({ tool_calls: [call] });
  assert.deepEqual(agent.decode(content), { content });
  const example = "Example:\n```json\n" + envelope([call]) + "\n```";
  assert.deepEqual(agent.decode(example), { content: example });
});

test("extracts OpenAI image content without putting base64 in the browser prompt", () => {
  const messages = [{ role: "user", content: [
    { type: "text", text: "Where are the tanks?" },
    { type: "image_url", image_url: { url: "data:image/png;base64," + png } },
  ] }];
  const chat = prepareChat({ messages }, requestId);
  assert.deepEqual(chat.attachments, [{ name: "image-1.png", mimeType: "image/png", data: png }]);
  assert.match(chat.messages[0].content, /Attached image: image-1.png/);
  assert.ok(!chat.messages[0].content.includes(png));
  messages[0].content[1].image_url.url = "https://example.org/image.png";
  assert.throws(() => prepareChat({ messages }, requestId), /base64 image data URL/);
});

test("keeps the full transcript across the former gateway context budget", () => {
  const messages = [
    { role: "system", content: "Keep instructions" },
    { role: "user", content: "old".repeat(90_000) },
    { role: "assistant", content: "Old reply" },
    user,
    { role: "assistant", tool_calls: [{ id: "active-call" }] },
    { role: "tool", tool_call_id: "active-call", content: "Current result" },
  ];
  const chat = prepareChat({ messages }, requestId);
  const prompt = chat.messages[0].content;
  assert.ok(prompt.length > 240_000);
  assert.deepEqual(JSON.parse(prompt.split("Conversation (JSON):\n\n")[1]), messages);
});

test("preserves large tool output, including its middle", () => {
  const messages = [user, {
    role: "tool",
    tool_call_id: "large-result",
    content: "start\r\n" + "x".repeat(40_000) + "\r\n    exact middle\r\n" + "y".repeat(40_000) + "\r\nend",
  }];
  const chat = prepareChat({ messages }, requestId);
  const transcript = JSON.parse(chat.messages[0].content.split("Conversation (JSON):\n\n")[1]);
  assert.equal(transcript.at(-1).content, messages[1].content);
});

test("retains earlier text when its image exceeds the attachment allowance", () => {
  const messages = Array.from({ length: 9 }, (_value, index) => ({
    role: "user", content: [
      { type: "text", text: `Screenshot description ${index}` },
      { type: "image", mimeType: "image/png", data: png },
    ],
  }));
  const chat = prepareChat({ messages }, requestId);
  assert.equal(chat.attachments.length, 8);
  const transcript = JSON.parse(chat.messages[0].content.split("Conversation (JSON):\n\n")[1]);
  assert.equal(transcript.length, 9);
  assert.equal(transcript[0].content, "Screenshot description 0\n[Earlier image unavailable: image-1.png]");
  assert.equal(transcript.at(-1).content, "Screenshot description 8\n[Attached image: image-9.png]");
});

test("passes the system prompt, selected source, prior function call and tool result", () => {
  const messages = [
    { role: "system", content: "Call the edit tool for workspace changes." },
    { role: "user", content: [{ type: "text", text: user.content }, { type: "text", text: args.changes }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_previous",
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }],
    },
    { role: "tool", tool_call_id: "call_previous", content: "Edit saved successfully." },
  ];
  const { messages: [browserPrompt] } = prepareChat({ messages, tools: [edit] }, requestId);
  const [instructions, transcript] = browserPrompt.content.split("Conversation (JSON):\n\n");
  assert.ok(instructions.includes(edit.function.name));
  assert.ok(instructions.includes(requestId));
  assert.match(instructions, /fenced code block labeled json/);
  assert.deepEqual(JSON.parse(transcript), [
    messages[0],
    { role: "user", content: user.content + "\n" + args.changes },
    messages[2],
    messages[3],
  ]);
});

test("decodes a complete call with serialized arguments and a stable ID", () => {
  const { decode } = prepareChat({ tools: [edit], messages: [user] }, requestId);
  const encoded = envelope([call]);
  const expected = {
    content: null,
    toolCalls: [{
      id: "call_12345678123412341234123456789abc_0",
      type: "function",
      function: { name: edit.function.name, arguments: JSON.stringify(args) },
    }],
  };
  assert.deepEqual(decode(encoded), expected);
  assert.deepEqual(decode("```json\n" + encoded + "\n```"), expected);
  assert.deepEqual(decode("json\n" + encoded), expected);
});

test("returns raw Python with its indentation and final newline for Continue Apply", () => {
  const code = args.changes + "\n";
  const apply = prepareChat({
    messages: [user, { role: "assistant", content: "```\n" }],
  }, requestId);
  assert.match(apply.messages[0].content, /indentation and line breaks preserved/);
  assert.deepEqual(
    apply.decode(JSON.stringify({ gateway_request_id: requestId, content: code })),
    { content: code }
  );
  assert.throws(() => apply.decode("I updated the file."), /requested code content/);
});

test("rejects malformed, unlisted, stale, and schema-invalid calls", () => {
  const { decode } = prepareChat({ tools: [edit], messages: [user] }, requestId);
  assert.throws(() => decode(`{"gateway_request_id":"${requestId}"`), /valid function call/);
  assert.throws(() => decode(envelope([call], "another-request")), /different gateway request/);
  assert.throws(() => decode(envelope([])), /non-empty tool_calls array/);
  assert.throws(() => decode(envelope([{ ...call, name: read.function.name }])), /outside the allowed list/);
  assert.throws(() => decode(envelope([{ ...call, arguments: { filepath: args.filepath } }])), /invalid arguments/);
  assert.throws(() => decode(envelope([{ ...call, arguments: { ...args, changes: 4 } }])), /invalid arguments/);
  assert.throws(() => decode(envelope([{ ...call, arguments: { ...args, extra: 4 } }])), /invalid arguments/);
});

test("validates Cline 2020-12 tools alongside Continue tools", () => {
  const ask = {
    type: "function",
    function: {
      name: "ask_question",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          question: { type: "string", minLength: 1 },
          options: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", minLength: 1 } },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
  };
  const { decode } = prepareChat({ tools: [ask, edit], messages: [user] }, requestId);
  const question = { name: ask.function.name, arguments: { question: "Which file?", options: ["a.py", "b.py"] } };

  const { toolCalls } = decode(envelope([question, call]));
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), question.arguments);
  assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), args);
  assert.throws(() => decode(envelope([
    { ...question, arguments: { ...question.arguments, options: ["a.py"] } },
  ])), /invalid arguments for ask_question/);
});

test("enforces none, required, named, and single-call choices", () => {
  const tools = [edit, read];
  const content = envelope([call]);
  const disabled = prepareChat({ tools, tool_choice: "none", messages: [user] }, requestId);
  assert.deepEqual(disabled.decode(content), { content });

  const required = prepareChat({ tools, tool_choice: "required" }, requestId);
  assert.throws(() => required.decode("Plain reply"), /valid function call/);
  assert.throws(() => prepareChat({ tool_choice: "required" }, requestId), /available function/);

  const selected = prepareChat({
    tools,
    tool_choice: { type: "function", function: { name: read.function.name } },
  }, requestId);
  assert.throws(() => selected.decode(content), /outside the allowed list/);
  assert.equal(selected.decode(envelope([{ name: read.function.name, arguments: {} }])).toolCalls.length, 1);

  const single = prepareChat({ tools, parallel_tool_calls: false }, requestId);
  const multiple = envelope([call, { name: read.function.name, arguments: {} }]);
  assert.throws(() => single.decode(multiple), /single-call request/);
  assert.equal(prepareChat({ tools }, requestId).decode(multiple).toolCalls.length, 2);
});
