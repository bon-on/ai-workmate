import test from "node:test";
import assert from "node:assert/strict";
import { notifyJobResult } from "../src/router.js";

test("notifyJobResult sends text summary and image artifacts", async () => {
  const calls = [];
  const telegram = {
    async sendMessage(chatId, text, extra = {}) {
      calls.push(["message", chatId, text, extra]);
      return { message_id: 42 };
    },
    async sendPhoto(chatId, filePath, caption) {
      calls.push(["photo", chatId, filePath, caption]);
    },
    async sendDocument(chatId, filePath, caption) {
      calls.push(["document", chatId, filePath, caption]);
    },
  };

  await notifyJobResult(telegram, {
    chatId: "1",
    jobId: "abc123",
    status: "completed",
    sessionId: "sess-1",
    workspaceAlias: "default",
    summary: "done",
    replyToMessageId: 10,
    artifacts: [
      { path: "/tmp/lion.png", mode: "photo" },
      { path: "/tmp/lion.svg", mode: "document" },
    ],
  });

  assert.equal(calls[0][0], "message");
  assert.deepEqual(calls[0][3], { reply_parameters: { message_id: 10 } });
  assert.deepEqual(calls[1], ["photo", "1", "/tmp/lion.png", "Generated file: lion.png"]);
  assert.deepEqual(calls[2], ["document", "1", "/tmp/lion.svg", "Generated file: lion.svg"]);
});

test("notifyJobResult skips non-image artifacts such as codex.log", async () => {
  const calls = [];
  const telegram = {
    async sendMessage(chatId, text, extra = {}) {
      calls.push(["message", chatId, text, extra]);
      return { message_id: 77 };
    },
    async sendPhoto(chatId, filePath, caption) {
      calls.push(["photo", chatId, filePath, caption]);
    },
    async sendDocument(chatId, filePath, caption) {
      calls.push(["document", chatId, filePath, caption]);
    },
  };

  await notifyJobResult(telegram, {
    chatId: "1",
    jobId: "abc123",
    status: "completed",
    sessionId: "sess-1",
    workspaceAlias: "default",
    summary: "done",
    artifacts: [
      { path: "/tmp/codex.log", mode: "document" },
      { path: "/tmp/lion.png", mode: "photo" },
    ],
  });

  assert.deepEqual(calls, [
    [
      "message",
      "1",
      "done\n\n✅ Codex · /job abc123",
      {},
    ],
    ["photo", "1", "/tmp/lion.png", "Generated file: lion.png"],
  ]);
});

test("notifyJobResult records personal briefing without feedback buttons", async () => {
  const calls = [];
  const records = [];
  const telegram = {
    async sendMessage(chatId, text, extra = {}) {
      calls.push([chatId, text, extra]);
      return { message_id: 88 };
    },
  };
  const personalOps = {
    async recordBriefing(input) {
      records.push(input);
      return { id: "br-123", recommendations: input.recommendations };
    },
  };
  await notifyJobResult(telegram, {
    chatId: "1",
    status: "completed",
    prompt: "[AI_WORKMATE_MORNING_BRIEF_V1]\n작성",
    summary: "☀️ 모닝 브리핑 · 9월 17일\n\n💡 오늘의 추천\n• 새 도구 시험하기",
    finishedAt: "2026-09-17T08:00:00+09:00",
    artifacts: [],
  }, { personalOps });

  assert.deepEqual(records[0].recommendations, ["새 도구 시험하기"]);
  assert.equal(calls[0][2].reply_markup, undefined);
});
