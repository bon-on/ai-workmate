import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export class ProcessManager {
  constructor() {
    this.processes = new Map();
    this.byChat = new Map();
  }

  async start({ chatId, workspace, argv }) {
    const processId = randomUUID().slice(0, 8);
    const logDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `telegram-serve-${processId}-`));
    const logPath = path.join(logDir, "process.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const child = spawn(argv[0], argv.slice(1), {
      cwd: workspace.path,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const entry = {
      processId,
      chatId: String(chatId),
      workspaceAlias: workspace.alias,
      workspacePath: workspace.path,
      command: argv.join(" "),
      argv: [...argv],
      startedAt: new Date().toISOString(),
      status: "running",
      pid: child.pid ?? null,
      logPath,
      child,
      exitCode: null,
      signal: null,
    };

    this.processes.set(processId, entry);
    const processIds = this.byChat.get(String(chatId)) ?? [];
    processIds.push(processId);
    this.byChat.set(String(chatId), processIds);

    child.stdout.on("data", (chunk) => {
      logStream.write(`[stdout] ${chunk.toString("utf8")}`);
    });
    child.stderr.on("data", (chunk) => {
      logStream.write(`[stderr] ${chunk.toString("utf8")}`);
    });
    child.once("close", async (code, signal) => {
      entry.status = "exited";
      entry.exitCode = code;
      entry.signal = signal;
      await new Promise((resolve) => logStream.end(resolve));
    });
    child.once("error", async (error) => {
      entry.status = "failed";
      entry.signal = null;
      logStream.write(`[spawn-error] ${error.message}\n`);
      await new Promise((resolve) => logStream.end(resolve));
    });

    return entry;
  }

  list(chatId) {
    const processIds = this.byChat.get(String(chatId)) ?? [];
    return processIds
      .map((id) => this.processes.get(id))
      .filter(Boolean)
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  }

  get(chatId, processId) {
    const entry = this.processes.get(processId);
    if (!entry || entry.chatId !== String(chatId)) {
      return null;
    }

    return entry;
  }

  async readLogTail(chatId, processId, maxBytes = 4000) {
    const entry = this.get(chatId, processId);
    if (!entry) {
      return null;
    }

    const file = await fsPromises.open(entry.logPath, "r");
    try {
      const stats = await file.stat();
      const length = Math.min(stats.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, Math.max(0, stats.size - length));
      return buffer.toString("utf8");
    } finally {
      await file.close();
    }
  }

  stop(chatId, processId) {
    const entry = this.processes.get(processId);
    if (!entry || entry.chatId !== String(chatId)) {
      return null;
    }

    if (entry.status !== "running") {
      return entry;
    }

    entry.status = "stopping";
    entry.child.kill("SIGTERM");
    return entry;
  }
}
