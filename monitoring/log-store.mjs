import { appendFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export function createLogStore(config, io = { appendFile, lstat, mkdir, rename, rm }) {
  const path = (index) => join(config.logDir, index ? `gateway-monitor.${index}.jsonl` : "gateway-monitor.jsonl");
  const queue = [];
  const state = { enabled: config.persist, pending: 0, dropped: 0, errors: 0, written: 0, activeBytes: 0, incomplete: false };
  let worker;
  let bytes;
  let inFlight = false;
  let closed = false;

  async function rotate() {
    await io.rm(path(config.logFiles - 1), { force: true });
    for (let index = config.logFiles - 2; index >= 0; index--) {
      try { await io.rename(path(index), path(index + 1)); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    bytes = 0;
  }

  async function drain() {
    try {
      if (bytes === undefined) {
        await io.mkdir(config.logDir, { recursive: true, mode: 0o700 });
        try {
          const stat = await io.lstat(path(0));
          if (!stat.isFile()) throw new Error("Invalid monitor log destination");
          bytes = stat.size;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          bytes = 0;
        }
      }
      while (queue.length) {
        const line = queue.shift();
        inFlight = true;
        if (bytes + line.bytes > config.logBytes) await rotate();
        await io.appendFile(path(0), line.text, { encoding: "utf8", mode: 0o600 });
        bytes += line.bytes;
        state.activeBytes = bytes;
        state.written++;
        inFlight = false;
      }
    } catch {
      state.errors++;
      state.dropped += queue.length + Number(inFlight);
      inFlight = false;
      state.incomplete = true;
      queue.length = 0;
      bytes = undefined;
    }
  }

  return {
    offer(text) {
      if (!config.persist || closed) return;
      const bytes = Buffer.byteLength(text);
      if (queue.length >= config.writeQueue || bytes > config.logBytes) {
        state.dropped++;
        return;
      }
      queue.push({ text, bytes });
      worker ??= Promise.resolve().then(drain).finally(() => { worker = undefined; });
    },
    snapshot: () => ({ ...state, pending: queue.length + Number(inFlight) }),
    async close(timeout = 1500) {
      closed = true;
      if (!worker) return;
      let timer;
      await Promise.race([worker, new Promise((resolve) => {
        timer = setTimeout(() => { state.incomplete = true; resolve(); }, timeout);
      })]);
      clearTimeout(timer);
    },
  };
}
