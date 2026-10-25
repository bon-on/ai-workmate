import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PersonalOpsStore } from "../src/personal-ops-store.js";
import { changeExcerpt, contentSnapshot, runDueWatches, validatePublicUrl } from "../src/watch-runner.js";

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

test("watch alerts include a bounded excerpt of added and removed lines", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "watch-excerpt-"));
  const store = new PersonalOpsStore(path.join(directory, "state.json"));
  const now = new Date("2026-08-19T00:00:00Z");
  const watch = await store.addWatch({ chatId: 100, userId: 200, workspaceAlias: "default", url: "https://example.test/", label: "공지", now });
  const messages = [];
  const telegram = { async sendMessage(...args) { messages.push(args); } };
  const lookup = async () => [{ address: "93.184.216.34" }];
  let body = "<ul><li>공지 A</li><li>공지 B</li></ul><script>var x=1</script>";
  const fetchImpl = async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  await runDueWatches({ store, telegram, now, fetchImpl, lookup });
  body = `<ul><li>공지 A</li><li>신규 공지 C ${"긴".repeat(300)}</li></ul>`;
  await runDueWatches({ store, telegram, now: new Date(now.getTime() + 60 * 60 * 1000), fetchImpl, lookup });
  assert.equal(messages.length, 1);
  assert.match(messages[0][1], /변경 내용:\n\+ 신규 공지 C/);
  assert.match(messages[0][1], /\n- 공지 B/);
  assert.ok(messages[0][1].length < 600, "excerpt stays short");
  const stored = store.listWatches("100").find((row) => row.id === watch.id);
  assert.match(stored.lastExcerpt, /신규 공지 C/);
  assert.ok(stored.lastSnapshot.length <= 20_000);
});

test("changeExcerpt is null without a previous snapshot and caps the line count", () => {
  assert.equal(changeExcerpt(undefined, "a"), null);
  const before = contentSnapshot("<p>x</p>");
  const after = contentSnapshot(Array.from({ length: 10 }, (_, i) => `<p>line ${i}</p>`).join(""));
  const excerpt = changeExcerpt(before, after);
  assert.equal(excerpt.split("\n").filter((line) => /^[+-] /.test(line)).length, 4);
  assert.match(excerpt, /… 외 7줄/);
  assert.ok(contentSnapshot("<p>" + "y".repeat(30_000) + "</p><p>z</p>").length <= 20_000);
});
