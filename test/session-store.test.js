import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TelegramSessionStore } from "../src/session-store.js";

test("TelegramSessionStore persists and reloads reply mappings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-session-store-"));
  const statePath = path.join(tempDir, "sessions.json");

  const store = new TelegramSessionStore(statePath);
  await store.load();
  await store.rememberBotReply({
    chatId: "1",
    messageId: 200,
    sessionId: "sess-1",
    workspaceAlias: "default",
    jobId: "job-1",
    createdAt: "2026-04-16T00:00:00.000Z",
  });

  const reloaded = new TelegramSessionStore(statePath);
  await reloaded.load();

  assert.deepEqual(reloaded.resolveReply("1", 200), {
    chatId: "1",
    messageId: 200,
    sessionId: "sess-1",
    workspaceAlias: "default",
    jobId: "job-1",
    createdAt: "2026-04-16T00:00:00.000Z",
    provider: "codex",
  });
});

test("TelegramSessionStore keeps the provider that created a session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-session-store-"));
  const statePath = path.join(tempDir, "sessions.json");
  const store = new TelegramSessionStore(statePath);
  await store.rememberBotReply({
    chatId: "1", messageId: 300, sessionId: "claude-sess", workspaceAlias: "default", jobId: "job-2", provider: "claude",
  });

  const reloaded = new TelegramSessionStore(statePath);
  await reloaded.load();
  assert.equal(reloaded.resolveReply("1", 300).provider, "claude");
});

test("TelegramSessionStore clears sessions by chat", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-session-store-"));
  const statePath = path.join(tempDir, "sessions.json");

  const store = new TelegramSessionStore(statePath);
  await store.rememberBotReply({
    chatId: "1",
    messageId: 200,
    sessionId: "sess-1",
    workspaceAlias: "default",
    jobId: "job-1",
    createdAt: "2026-04-16T00:00:00.000Z",
  });
  await store.rememberBotReply({
    chatId: "2",
    messageId: 201,
    sessionId: "sess-2",
    workspaceAlias: "default",
    jobId: "job-2",
    createdAt: "2026-04-16T00:01:00.000Z",
  });

  await store.clearChat("1");

  assert.equal(store.resolveReply("1", 200), null);
  assert.equal(store.resolveReply("2", 201)?.sessionId, "sess-2");
});

test("a corrupt session file is moved aside instead of stopping startup, and saves are atomic and bounded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-corrupt-"));
  const file = path.join(dir, "sessions.json");
  await fs.writeFile(file, "{ not json");
  const store = new TelegramSessionStore(file);
  const originalError = console.error;
  console.error = () => {};
  try { await store.load(); } finally { console.error = originalError; }
  assert.equal(store.entries.size, 0);
  assert.ok((await fs.readdir(dir)).some((name) => name.startsWith("sessions.json.corrupt-")));
  await Promise.all(Array.from({ length: 520 }, (_, index) => store.rememberBotReply({
    chatId: "1", messageId: index + 1, sessionId: `s${index}`, workspaceAlias: "default", jobId: `j${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  })));
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.entries.length, 500);
  assert.equal(saved.entries[0].messageId, 21);
  assert.equal(store.resolveReply("1", 1), null);
  assert.ok(store.resolveReply("1", 520));
});
