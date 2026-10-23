import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOG_NAMES = [
  "telegram-codex-bridge.log",
  "launchd.out",
  "launchd.err",
  "ollama.out",
  "ollama.err",
];

// launchd.out/err have no timestamps of their own; prefix each line so incidents can be dated.
export function installLogTimestamps(target = console, now = () => new Date()) {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = target[level].bind(target);
    target[level] = (...args) => original(now().toISOString(), ...args);
  }
}

export async function trimRuntimeLogs({
  stateDir = path.join(os.homedir(), ".codex", "ai-workmate"),
  maxBytes = 10 * 1024 * 1024,
  keepBytes = 5 * 1024 * 1024,
  names = DEFAULT_LOG_NAMES,
} = {}) {
  const trimmed = [];
  for (const name of names) {
    const filePath = path.join(stateDir, name);
    try {
      const stats = await fs.stat(filePath);
      if (stats.size <= maxBytes) continue;
      const file = await fs.open(filePath, "r+");
      try {
        const length = Math.min(stats.size, keepBytes);
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, stats.size - length);
        await file.truncate(0);
        await file.write(buffer, 0, buffer.length, 0);
      } finally {
        await file.close();
      }
      trimmed.push(name);
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`Log maintenance failed for ${name}: ${error.message}`);
    }
  }
  return trimmed;
}
