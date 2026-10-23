import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PersonalOpsStore } from "../src/personal-ops-store.js";
import { runDueWatches, validatePublicUrl } from "../src/watch-runner.js";

test("validatePublicUrl rejects local and private destinations", async () => {
  await assert.rejects(() => validatePublicUrl("http://localhost:3000"), /로컬 주소/);
  await assert.rejects(() => validatePublicUrl("http://example.test", { lookup: async () => [{ address: "192.168.1.10" }] }), /사설망/);
  const url = await validatePublicUrl("https://example.test/page", { lookup: async () => [{ address: "93.184.216.34" }] });
  assert.equal(url.hostname, "example.test");
});

test("runDueWatches establishes a baseline then reports a change", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "watch-runner-"));
  const store = new PersonalOpsStore(path.join(directory, "state.json"));
  const now = new Date("2026-08-19T00:00:00Z");
  const watch = await store.addWatch({ chatId: 100, userId: 200, workspaceAlias: "default", url: "https://example.test/", label: "Example", now });
  const messages = [];
  const telegram = { async sendMessage(...args) { messages.push(args); } };
  const lookup = async () => [{ address: "93.184.216.34" }];
  let body = "<html><body>first</body></html>";
  const fetchImpl = async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  await runDueWatches({ store, telegram, now, fetchImpl, lookup });
  assert.equal(messages.length, 0);
  body = "<html><body>second</body></html>";
  await runDueWatches({ store, telegram, now: new Date(now.getTime() + 60 * 60 * 1000), fetchImpl, lookup });
  assert.equal(messages.length, 1);
  assert.match(messages[0][1], /웹 변경 감지/);
});
