import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { ProcessManager } from "../src/process-manager.js";

test("ProcessManager starts and lists a process", async () => {
  const manager = new ProcessManager();
  const entry = await manager.start({
    chatId: "1",
    workspace: { alias: "main", path: process.cwd() },
    argv: ["node", "-e", "setTimeout(()=>{},2000)"],
  });

  assert.equal(entry.workspaceAlias, "main");
  assert.equal(manager.list("1")[0].processId, entry.processId);
  await waitForFile(entry.logPath);
  manager.stop("1", entry.processId);
  await fs.access(entry.logPath);
});

test("ProcessManager reads recent process log tail", async () => {
  const manager = new ProcessManager();
  const entry = await manager.start({
    chatId: "1",
    workspace: { alias: "main", path: process.cwd() },
    argv: ["node", "-e", "console.log('hello from process')"],
  });
  await waitForFile(entry.logPath);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const log = await manager.readLogTail("1", entry.processId);
    if (log?.includes("hello from process")) {
      assert.match(log, /hello from process/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for process log");
});

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`Timed out waiting for file ${filePath}`);
}
