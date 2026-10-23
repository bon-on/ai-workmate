import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAiUsageReport, formatAiUsageReport } from "../src/ai-usage-report.js";
import { PersonalOpsStore } from "../src/personal-ops-store.js";
import { createJobSettler } from "../src/job-settle.js";
import { handleMessage } from "../src/router.js";

const WEEKLY = "[AI_WORKMATE_WEEKLY_REVIEW_V1]\n주간 리뷰";
const now = new Date("2026-10-22T03:00:00Z");

async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-usage-test-"));
  const personalOps = new PersonalOpsStore(path.join(dir, "state.json"));
  await personalOps.load();
  return personalOps;
}

function metricJob(id, overrides = {}) {
  return {
    jobId: id, chatId: "1", kind: "chat", status: "completed", provider: "claude", prompt: `작업 ${id}`,
    usage: { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100 },
    startedAt: "2026-10-21T00:00:00Z", finishedAt: "2026-10-21T00:01:00Z", ...overrides,
  };
}

test("report counts engines, fallbacks with reasons, failures, retries and heavy jobs within the window", async () => {
  const personalOps = await store();
  await personalOps.recordRunMetric(metricJob("a"));
  await personalOps.recordRunMetric(metricJob("b", { provider: "codex", fallbackReason: "Claude 사용 한도 도달", usage: { inputTokens: 50_000, outputTokens: 2000 } }));
  await personalOps.recordRunMetric(metricJob("c", { provider: "codex", fallbackReason: "Claude 실행 실패 (spawn claude ENOENT)", status: "failed" }));
  await personalOps.recordRunMetric(metricJob("d", { kind: "scheduled-local", usage: null }));
  await personalOps.recordRunMetric(metricJob("e"), { qualityRejected: true });
  await personalOps.recordRunMetric(metricJob("old", { finishedAt: "2026-10-01T00:00:00Z" }));

  const report = buildAiUsageReport({
    personalOps, chatId: "1", days: 7, now,
    claudeLimits: { snapshot: () => ({ fiveHour: { usedPercent: 12 }, weekly: { usedPercent: 28 } }) },
  });
  assert.equal(report.jobs, 5);
  assert.deepEqual(report.bySource, { claude: 2, codex: 2, local: 1 });
  assert.equal(report.fallbacks, 2);
  assert.deepEqual(report.fallbackReasons, { "Claude 사용 한도 도달": 1, "Claude 실행 실패": 1 });
  assert.equal(report.failures, 1);
  assert.equal(report.qualityRetries, 1);
  assert.equal(report.heaviest[0].title, "작업 b");

  const text = formatAiUsageReport(report);
  assert.match(text, /전체 5건: Claude 2 · Codex 2 \(폴백 2\) · 로컬 1 · 실패 1/);
  assert.match(text, /폴백 이유: /);
  assert.match(text, /브리핑 품질 재시도 1건/);
  assert.match(text, /Claude 한도 사용: 5시간 12% · 7일 28%/);
  assert.match(text, /결과 품질 평가는 아닙니다/);
  assert.ok(text.split("\n").length <= 12);
  assert.match(formatAiUsageReport(buildAiUsageReport({ personalOps, chatId: "9", now })), /기록된 작업 없음/);
});

test("metrics without the new fields still load and count as zero", async () => {
  const personalOps = await store();
  personalOps.runMetrics.set("legacy", { id: "legacy", chatId: "1", source: "claude", status: "completed", finishedAt: "2026-10-21T00:00:00Z" });
  const report = buildAiUsageReport({ personalOps, chatId: "1", now });
  assert.equal(report.jobs, 1);
  assert.equal(report.qualityRetries, 0);
  assert.equal(report.tokens.input, 0);
  assert.equal(personalOps.usageSummary("1", { now }).fallbacks, 0);
});

function settlerDeps(personalOps, startJob) {
  const sent = [];
  return {
    sent,
    deps: {
      config: {},
      telegram: { async sendMessage(chatId, text) { sent.push(text); return { message_id: 1 }; } },
      jobs: { startJob, claudeLimits: null },
      workspaces: { getWorkspaceByAlias: (alias) => ({ alias, path: "/tmp" }) },
      schedules: {
        async pauseForUsageLimit() {}, async reserveBriefingAttempt() { return true; }, isUsagePaused: () => false,
        async recordSuccess() {}, async recordFailure() { return null; },
      },
      personalOps,
      sessions: { async rememberBotReply() {} },
    },
  };
}

test("a quality-rejected draft is recorded as a retry before the corrected job runs", async () => {
  const personalOps = await store();
  const { deps } = settlerDeps(personalOps, async () => ({ accepted: true, job: { completion: new Promise(() => {}) } }));
  const { settleJob } = createJobSettler(deps);
  await settleJob(metricJob("draft", { prompt: WEEKLY, summary: "# 형식 위반", workspaceAlias: "default", finishedAt: new Date().toISOString() }));
  const rows = personalOps.listRunMetrics("1", { days: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qualityRejected, true);
});

test("the weekly review gets the usage report and repo status appended by code", async () => {
  const personalOps = await store();
  await personalOps.recordRunMetric(metricJob("a", { finishedAt: new Date().toISOString() }));
  await personalOps.setRepoChecks({ checkedAt: new Date().toISOString(), repos: [{ name: "app", publish: { blockers: [{ rule: "env-file", file: ".env" }], warnings: [], missing: [] } }] });
  const { deps, sent } = settlerDeps(personalOps, async () => { throw new Error("no retry expected"); });
  const { settleJob } = createJobSettler(deps);
  const review = ["🗓 주간 리뷰 · 10월 25일", "", "🏁 이번 주", "• 완료한 일 정리", "", "🎯 다음 주 핵심", "• 목표 하나"].join("\n");
  await settleJob(metricJob("weekly", { prompt: WEEKLY, summary: review, workspaceAlias: "default", finishedAt: new Date().toISOString() }));
  const text = sent.join("\n");
  assert.match(text, /🗓 주간 리뷰[\s\S]*🤖 AI 작업 · 최근 7일\n• 전체 1건: Claude 1/);
  assert.match(text, /🧰 저장소 점검\n• app · 공개 차단 1건 \(env-file\)/);
});

test("/ai-usage replies with the report for the requested number of days", async () => {
  const personalOps = await store();
  await personalOps.recordRunMetric(metricJob("a", { finishedAt: new Date().toISOString() }));
  const sent = [];
  await handleMessage({
    message: { chat: { id: 1 }, from: { id: 2 }, text: "/ai-usage 30" },
    config: { allowedChatIds: ["1"], allowedUserIds: ["2"] },
    telegram: { async sendMessage(chatId, text) { sent.push(text); } },
    jobs: { claudeLimits: null }, personalOps,
  });
  assert.match(sent[0], /🤖 AI 작업 · 최근 30일\n• 전체 1건/);
});
