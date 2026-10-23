import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory-store.js";

test("MemoryStore persists and reloads workspace memories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-"));
  const statePath = path.join(tempDir, "memories.json");

  const store = new MemoryStore(statePath);
  await store.load();
  const entry = await store.add({
    chatId: "1",
    workspaceAlias: "default",
    text: "사용자는 최종 답변을 짧게 선호한다",
  });

  const reloaded = new MemoryStore(statePath);
  await reloaded.load();

  assert.deepEqual(reloaded.list({ chatId: "1", workspaceAlias: "default" }), [entry]);
});

test("MemoryStore filters and deletes by chat and workspace", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-"));
  const statePath = path.join(tempDir, "memories.json");
  const store = new MemoryStore(statePath);

  const first = await store.add({
    chatId: "1",
    workspaceAlias: "default",
    text: "first",
  });
  await store.add({
    chatId: "1",
    workspaceAlias: "other",
    text: "second",
  });
  await store.add({
    chatId: "2",
    workspaceAlias: "default",
    text: "third",
  });

  assert.deepEqual(store.list({ chatId: "1", workspaceAlias: "default" }), [first]);
  assert.equal((await store.forget({ chatId: "2", id: first.id })), null);
  assert.equal((await store.forget({ chatId: "1", id: first.id }))?.text, "first");
  assert.deepEqual(store.list({ chatId: "1", workspaceAlias: "default" }), []);
});

test("MemoryStore returns existing entries for duplicate memories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-"));
  const statePath = path.join(tempDir, "memories.json");
  const store = new MemoryStore(statePath);

  const first = await store.add({
    chatId: "1",
    workspaceAlias: "default",
    text: "Always answer in Korean",
  });
  const duplicate = await store.add({
    chatId: "1",
    workspaceAlias: "default",
    text: " always   answer in korean ",
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.list({ chatId: "1", workspaceAlias: "default" }).length, 1);
});
