import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installLogTimestamps, trimRuntimeLogs } from "../src/maintenance.js";

test("runtime log maintenance keeps the newest tail", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "workmate-maintenance-"));
  const filePath = path.join(stateDir, "bridge.log");
  await writeFile(filePath, "abcdefghij", "utf8");
  const trimmed = await trimRuntimeLogs({ stateDir, names: ["bridge.log"], maxBytes: 8, keepBytes: 4 });
  assert.deepEqual(trimmed, ["bridge.log"]);
  assert.equal(await readFile(filePath, "utf8"), "ghij");
});

test("installLogTimestamps prefixes every console level with an ISO time", () => {
  const lines = [];
  const target = Object.fromEntries(["log", "info", "warn", "error"].map((level) => [level, (...args) => lines.push([level, ...args])]));
  installLogTimestamps(target, () => new Date("2026-10-21T07:00:00Z"));
  target.error("Polling error", 1);
  target.log("started");
  assert.deepEqual(lines, [
    ["error", "2026-10-21T07:00:00.000Z", "Polling error", 1],
    ["log", "2026-10-21T07:00:00.000Z", "started"],
  ]);
});
