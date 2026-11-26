import { homedir } from "node:os";
import { join } from "node:path";

export function monitorConfig(env = process.env) {
  const setting = (name) => env[`CHATGPT_GATEWAY_MONITOR_${name}`];
  const bool = (name, fallback) => {
    const value = setting(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    throw new Error(`Invalid monitoring setting ${name}`);
  };
  const integer = (name, fallback, min, max) => {
    const value = Number(setting(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid monitoring setting ${name}`);
    return value;
  };
  return {
    enabled: bool("ENABLED", true), persist: bool("PERSIST", false),
    logDir: setting("LOG_DIR") || join(env.LOCALAPPDATA || join(homedir(), ".local", "state"), "chatgpt-gateway", "monitor"),
    requests: integer("REQUESTS", 500, 1, 2000), events: integer("EVENTS", 5000, 1, 20000),
    eventBytes: integer("EVENT_BYTES", 8 * 1024 * 1024, 4096, 32 * 1024 * 1024),
    logBytes: integer("LOG_BYTES", 5 * 1024 * 1024, 4096, 16 * 1024 * 1024),
    logFiles: integer("LOG_FILES", 5, 1, 10),
    writeQueue: integer("WRITE_QUEUE", 1000, 1, 2000),
    exportBytes: integer("EXPORT_BYTES", 1024 * 1024, 8192, 4 * 1024 * 1024),
  };
}
