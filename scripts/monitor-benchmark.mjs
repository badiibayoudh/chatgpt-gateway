import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const server = new URL("../server.mjs", import.meta.url).href;
const entry = `process.on('message', () => process.send({ memory: process.memoryUsage(), cpu: process.cpuUsage() })); await import(${JSON.stringify(server)});`;
const rounds = 120;
const initial = { role: "user", content: "Synthetic gateway monitor fixture.\n" + "deterministic terminal output\n".repeat(80) };
const modelReply = "Synthetic fixture complete.";

async function run(mode, preview = false) {
  const logDir = await mkdtemp(join(tmpdir(), "gateway-monitor-measure-"));
  const gateway = spawn(process.execPath, ["--input-type=module", "-e", entry], { stdio: ["ignore", "pipe", "inherit", "ipc"], env: {
    ...process.env, PORT: "0", CHATGPT_GATEWAY_API_KEY: "", CHATGPT_GATEWAY_EXTENSION_ORIGIN: "",
    CHATGPT_GATEWAY_MAX_CONTEXT_TOKENS: "0", CHATGPT_GATEWAY_MAX_PROMPT_BYTES: "0", CHATGPT_GATEWAY_TEXT_ATTACHMENT_FALLBACK: "true",
    CHATGPT_GATEWAY_MONITOR_ENABLED: String(mode !== "disabled"), CHATGPT_GATEWAY_MONITOR_PERSIST: String(mode === "jsonl"),
    CHATGPT_GATEWAY_MONITOR_LOG_DIR: logDir,
  } });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      let output = "";
      gateway.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/HTTP API:\s+http:\/\/localhost:(\d+)/);
        if (match) resolve(`http://127.0.0.1:${match[1]}`);
      });
      gateway.once("exit", () => reject(new Error("Gateway fixture stopped during startup")));
      gateway.once("error", reject);
    });
    browser = new WebSocket(base.replace("http:", "ws:") + "/ws");
    await once(browser, "open");
    const send = (message) => browser.send(JSON.stringify(message));
    send({ type: "hello", capabilities: ["conversationReuse", "continuationOnly", "contextMetrics", "telemetryV1"] });
    let turn = 0;
    browser.on("message", (raw) => {
      const msg = JSON.parse(raw);
      const id = msg.requestId;
      const content = (msg.continuation ?? msg).messages.at(-1).content;
      if (msg.telemetry) send({ type: "telemetry", version: 1, requestId: id,
        events: ["browser.prompt_submitted", "browser.generation_detected", "browser.response_received"].map((event) =>
          ({ event, requestId: id, component: "content-script", data: {} })) });
      send({ type: "chat-transmission", requestId: id, promptCharacters: content.length,
        promptBytes: Buffer.byteLength(content), textBytes: 0, images: 0 });
      const fail = preview && turn % 5 === 4;
      send({ type: "response", requestId: id, tabId: 1, url: `https://chatgpt.com/c/fixture-${Math.floor(turn / 2)}`,
        ok: !fail, content: modelReply, ...(fail && { errorCode: "chatgpt_upload_allowance", error: "Synthetic upload allowance fixture" }) });
      turn++;
    });
    const sample = async () => {
      const message = once(gateway, "message");
      gateway.send("sample");
      return (await message)[0];
    };
    const before = await sample();
    const start = performance.now();
    let roundTripMs = 0;
    const requests = preview ? 14 : rounds;
    for (let index = 0; index < requests; index++) {
      const messages = index % 2 === 0 ? [initial] : [initial, { role: "assistant", content: modelReply },
        { role: "user", content: `Follow-up ${index}` }];
      const began = performance.now();
      const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, new_conversation: index % 2 === 0 }) });
      if (!response.ok && !preview) throw new Error(`Fixture request returned ${response.status}`);
      await response.arrayBuffer();
      roundTripMs += performance.now() - began;
      if (!preview) await delay(28);
    }
    const elapsed = performance.now() - start;
    const after = await sample();
    let retained;
    if (mode !== "disabled") {
      for (let tries = 0; tries < 40; tries++) {
        retained = (await (await fetch(base + "/monitor/status")).json()).retention;
        if (!retained.storage.pending) break;
        await delay(25);
      }
    }
    let diskBytes = 0;
    for (const file of await readdir(logDir)) diskBytes += (await stat(join(logDir, file))).size;
    if (preview) {
      console.log(`Preview ${base}/dashboard`);
      // Leave the isolated fixture available for a local dashboard smoke test.
      await delay(240_000);
    } else {
      console.log(JSON.stringify({ mode, requests, wallMs: Math.round(elapsed), meanRoundTripMs: +(roundTripMs / requests).toFixed(2),
        cpuMs: Math.round((after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000),
        rssBytes: after.memory.rss, heapBytes: after.memory.heapUsed, events: retained?.events ?? 0,
        eventBytes: retained?.eventBytes ?? 0, rejectedExtensionEvents: retained?.rejectedExtensionEvents ?? 0, diskBytes }));
    }
  } finally {
    browser?.terminate();
    const exit = gateway.exitCode === null ? once(gateway, "exit") : null;
    gateway.kill();
    if (exit) await exit;
    await rm(logDir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--preview")) await run("memory", true);
else for (const mode of ["disabled", "memory", "jsonl"]) await run(mode);
