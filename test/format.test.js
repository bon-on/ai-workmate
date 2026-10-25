import test from "node:test";
import assert from "node:assert/strict";
import { buildCompletionMessage, splitTelegramMessage } from "../src/format.js";

test("buildCompletionMessage uses cancelled status header", () => {
  const message = buildCompletionMessage({
    status: "cancelled",
    jobId: "abc123",
    sessionId: "sess-1",
    workspaceAlias: "default",
    summary: "Cancelled by Telegram command.",
  });

  assert.equal(message, "Cancelled by Telegram command.\n\n⏹ 취소됨 · Codex · /job abc123");
  assert.doesNotMatch(message, /Job:|Session:|Mode:|Workspace:/);
});

test("buildCompletionMessage omits job metadata for completed personal briefings", () => {
  const message = buildCompletionMessage({
    status: "completed",
    jobId: "abc123",
    sessionId: "sess-1",
    workspaceAlias: "default",
    prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]\nbrief",
    summary: "🤖 AI 트렌드 · 8월 20일",
  });

  assert.equal(message, "🤖 AI 트렌드 · 8월 20일");
  assert.doesNotMatch(message, /Codex job completed|Job:|Session:|Workspace:/);
});

test("splitTelegramMessage splits long text into numbered chunks", () => {
  const text = `Header\n\n${"a".repeat(3600)}`;
  const parts = splitTelegramMessage(text, 1000);

  assert.equal(parts.length > 1, true);
  assert.match(parts[0], /^\[1\/\d+\]\n/);
  assert.match(parts[1], /^\[2\/\d+\]\n/);
});
