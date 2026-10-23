import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeLimitState } from "../src/claude-runner.js";
import { JobManager } from "../src/job-manager.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { createJobSettler } from "../src/job-settle.js";
import { runDueSchedules } from "../src/scheduler.js";
import { handleMessage } from "../src/router.js";
import { buildCompletionMessage } from "../src/format.js";
import { loadConfig } from "../src/config.js";

const RESET_SECONDS = 4_102_444_800; // 2100-01-01
const MORNING = "[AI_WORKMATE_MORNING_BRIEF_V1]\n오늘 브리핑";
const LIMIT_TEXT = "You've hit your usage limit. try again at Jan 1st, 2100 1:00 AM";

async function makeFakes(dir) {
  const claudePath = path.join(dir, "fake-claude.mjs");
  const codexPath = path.join(dir, "fake-codex.mjs");
  const lines = [
    { type: "system", subtype: "init", session_id: "s" },
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: RESET_SECONDS, rateLimitType: "five_hour", utilization: 1 }, session_id: "s" },
    { type: "result", subtype: "success", is_error: true, result: LIMIT_TEXT, session_id: "s" },
  ];
  await fs.writeFile(claudePath, `#!/usr/bin/env node
import fs from "node:fs";
fs.readFileSync(0, "utf8");
for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + "\\n");
process.exit(1);
`);
  await fs.writeFile(codexPath, `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(argv[argv.indexOf("-o") + 1], "codex answer");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }) + "\\n");
`);
  await fs.chmod(claudePath, 0o755);
  await fs.chmod(codexPath, 0o755);
  return { claudePath, codexPath };
}

function settlerDeps(overrides = {}) {
  const sent = [];
  const deps = {
    config: { scheduleMaxFailures: 3 },
    telegram: { async sendMessage(chatId, text) { sent.push(text); return { message_id: 7 }; } },
    jobs: { async startJob() { return { accepted: false }; } },
    workspaces: { getWorkspaceByAlias: (alias) => ({ alias, path: "/tmp" }) },
    schedules: {
      isUsagePaused: () => false,
      async pauseForUsageLimit() { return false; },
      async reserveBriefingAttempt() { return true; },
      async recordSuccess() {},
      async recordFailure() { return null; },
    },
    personalOps: {
      listBriefingHistory: () => [],
      async recordRunMetric() {},
      async recordBriefing() { return null; },
      async recordTrendTopics() {},
    },
    sessions: { async rememberBotReply() {} },
    ...overrides,
  };
  return { deps, sent };
}

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("scheduler starts scheduled AI briefings in brief mode on the scheduled tier", async () => {
  const started = [];
  const entry = { id: "s1", chatId: "1", userId: "2", workspaceAlias: "default", prompt: "[AI_WORKMATE_WEEKLY_REVIEW_V1]\nx" };
  const schedules = {
    due: () => [entry],
    isUsagePaused: () => false,
    async reserveBriefingAttempt() { return true; },
    async markStarted() {},
  };
  const jobs = {
    getActiveJob: () => null,
    async startJob(input) { started.push(input); return { accepted: true, job: { completion: new Promise(() => {}) } }; },
  };
  await runDueSchedules({
    schedules, jobs, memories: null, telegram: { async sendMessage() {} }, onJobSettled: async () => {},
    workspaces: { getWorkspaceByAlias: (alias) => ({ alias, path: "/tmp" }) },
  });
  assert.equal(started.length, 1);
  assert.equal(started[0].operationMode, "brief");
  assert.equal(started[0].modelTier, "scheduled");
});

test("quality retry of a scheduled briefing keeps brief mode and the scheduled tier", async () => {
  const startCalls = [];
  const { deps, sent } = settlerDeps({
    jobs: {
      async startJob(input) {
        startCalls.push(input);
        return { accepted: true, job: { completion: Promise.resolve({ status: "failed", summary: "stop", prompt: input.prompt, chatId: "1" }) } };
      },
    },
  });
  const { settleJob } = createJobSettler(deps);
  const job = {
    jobId: "j1", chatId: "1", userId: "2", prompt: MORNING, status: "completed", scheduleId: "s1",
    summary: "# 마크다운 제목\n제목 누락", workspaceAlias: "default", memories: [],
    operationMode: "brief", modelTier: "scheduled", replyToMessageId: null,
  };
  await settleJob(job);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].operationMode, "brief");
  assert.equal(startCalls[0].modelTier, "scheduled");
  assert.equal(startCalls[0].scheduleId, "s1");
  assert.match(startCalls[0].prompt, /품질 검사에서 다음 문제로 반려/);
  // The invalid draft is not delivered; only one retry is allowed.
  assert.ok(!sent.some((text) => text.includes("제목 누락")), "the rejected draft must not be sent");
  assert.equal(job.briefingRetryCount, undefined);
  startCalls.length = 0;
  await settleJob({ ...job, briefingRetryCount: 1 });
  assert.equal(startCalls.length, 0);
});

test("a Claude limit followed by a successful Codex fallback does not pause schedules", async () => {
  const dir = await tempDir("claude-gaps-");
  const fakes = await makeFakes(dir);
  const limits = new ClaudeLimitState(path.join(dir, "limits.json"));
  const manager = new JobManager({
    aiProvider: "claude", claudeExecutable: fakes.claudePath, codexExecutable: fakes.codexPath,
    scheduledClaudeModel: "sonnet", scheduledClaudeEffort: "low",
    scheduledCodexModel: "gpt-5.6-luna", scheduledCodexReasoningEffort: "none",
    jobTimeoutMs: 20_000, maxLogBytes: 20_000,
  }, { claudeLimits: limits });
  const schedules = new ScheduleStore(path.join(dir, "schedules.json"));
  await schedules.load();
  const { deps } = settlerDeps({ schedules: Object.assign(schedules, {
    async recordSuccess() {}, async recordFailure() { return null; },
  }) });
  const { settleJob } = createJobSettler(deps);

  const { job } = await manager.startJob({ chatId: 1, userId: 2, prompt: "x", workspace: { alias: "default", path: dir }, modelTier: "scheduled" });
  await job.completion;
  assert.equal(job.status, "completed");
  assert.equal(job.provider, "codex");
  assert.equal(job.fallbackFrom, "claude");
  // The Claude limit text survives in the job output, so only the final status protects the schedules.
  job.lastOutputSnippet = `${job.lastOutputSnippet || ""}\n${LIMIT_TEXT}`;
  await settleJob(job);
  assert.equal(schedules.isUsagePaused(), false);

  // Control: a final failing attempt with the same limit text pauses schedules.
  await settleJob({ ...job, status: "failed", summary: LIMIT_TEXT, provider: "codex" });
  assert.equal(schedules.isUsagePaused(), true);
});

// Regression: handleMessage used to omit readCodexLimits, so /status threw ReferenceError.
test("/status shows Claude limits next to Codex limits", async () => {
  const dir = await tempDir("claude-gaps-");
  const limits = new ClaudeLimitState(path.join(dir, "limits.json"));
  await limits.record({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: RESET_SECONDS }, seven_day: { utilization: 0.1, resetsAt: RESET_SECONDS } } });
  const sent = [];
  await handleMessage({
    message: { chat: { id: 100 }, from: { id: 200 }, text: "/status" },
    config: { allowedChatIds: ["100"], allowedUserIds: ["200"], aiProvider: "claude" },
    telegram: { async sendMessage(_chat, text) { sent.push(text); } },
    jobs: { getActiveJob: () => null, claudeLimits: limits },
    workspaces: { getActiveWorkspace: () => ({ alias: "default", path: "/tmp" }) },
    readCodexLimits: async () => ({ status: "available", fiveHour: { remainingPercent: 70 }, weekly: { remainingPercent: 80 } }),
  });
  const lines = sent[0].split("\n");
  const codexIdx = lines.findIndex((l) => l === "Codex limits: 5h 70% remaining | 7d 80% remaining");
  assert.ok(codexIdx >= 0, sent[0]);
  assert.equal(lines[codexIdx + 1], "Claude limits: 5h 60% remaining | 7d 90% remaining");

  // Unobserved Claude state is reported, not omitted.
  sent.length = 0;
  await handleMessage({
    message: { chat: { id: 100 }, from: { id: 200 }, text: "/status" },
    config: { allowedChatIds: ["100"], allowedUserIds: ["200"], aiProvider: "claude" },
    telegram: { async sendMessage(_chat, text) { sent.push(text); } },
    jobs: { getActiveJob: () => null, claudeLimits: new ClaudeLimitState(path.join(dir, "none.json")) },
    workspaces: { getActiveWorkspace: () => ({ alias: "default", path: "/tmp" }) },
  });
  assert.match(sent[0], /Claude limits: not observed yet/);
});

test("job header shows the Codex fallback line only for Codex fallbacks", () => {
  const base = { jobId: "j", status: "completed", workspaceAlias: "default", summary: "ok", sessionId: "s" };
  const fallback = buildCompletionMessage({ ...base, provider: "codex", fallbackFrom: "claude", fallbackReason: "Claude 사용 한도 도달" });
  assert.match(fallback, /^Codex job completed\./);
  assert.match(fallback, /\nFallback: Codex \(Claude 사용 한도 도달\)\n/);
  assert.doesNotMatch(buildCompletionMessage({ ...base, provider: "claude", fallbackReason: null }), /Fallback:/);
  assert.doesNotMatch(buildCompletionMessage({ ...base, provider: "claude", fallbackReason: "x" }), /Fallback:/);
});

test("config defaults: Claude fallback threshold 0.95 and scheduled Claude effort mapping", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", ALLOWED_CHAT_IDS: "1", ALLOWED_USER_IDS: "2", CODEX_WORKSPACE: os.tmpdir() };
  const config = loadConfig(env);
  assert.equal(config.claudeFallbackUtilization, 0.95);
  assert.equal(loadConfig({ ...env, CLAUDE_FALLBACK_UTILIZATION: "0.8" }).claudeFallbackUtilization, 0.8);

  // The default threshold reaches ClaudeLimitState and routes a 95% window to Codex.
  const dir = await tempDir("claude-gaps-");
  const state = new ClaudeLimitState(path.join(dir, "l.json"), { threshold: config.claudeFallbackUtilization });
  await state.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.94, resetsAt: RESET_SECONDS });
  assert.equal(state.shouldFallback().fallback, false);
  await state.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: RESET_SECONDS });
  assert.equal(state.shouldFallback().fallback, true);
  // ClaudeLimitState itself defaults to 0.95 when no threshold is supplied.
  const defaulted = new ClaudeLimitState(path.join(dir, "d.json"));
  await defaulted.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.94, resetsAt: RESET_SECONDS });
  assert.equal(defaulted.shouldFallback().fallback, false);
  await defaulted.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: RESET_SECONDS });
  assert.equal(defaulted.shouldFallback().fallback, true);

  // Job-level mapping: scheduled tier passes SCHEDULED_CLAUDE_EFFORT / MODEL to the Claude CLI.
  const fakeClaude = path.join(dir, "claude.mjs");
  await fs.writeFile(fakeClaude, `#!/usr/bin/env node
import fs from "node:fs";
fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" }) + "\\n");
`);
  await fs.chmod(fakeClaude, 0o755);
  const manager = new JobManager(
    loadConfig({ ...env, SCHEDULED_CLAUDE_EFFORT: "medium", SCHEDULED_CLAUDE_MODEL: "haiku", CLAUDE_EXECUTABLE: fakeClaude }),
    { claudeLimits: null },
  );
  manager.config.claudeExecutable = fakeClaude;
  const { job } = await manager.startJob({ chatId: 1, userId: 2, prompt: "x", workspace: { alias: "default", path: dir }, modelTier: "scheduled" });
  await job.completion;
  const argv = JSON.parse(await fs.readFile(path.join(dir, "argv.json"), "utf8"));
  assert.equal(argv[argv.indexOf("--effort") + 1], "medium");
  assert.equal(argv[argv.indexOf("--model") + 1], "haiku");
});

test("a completed AI lab job always records a Markdown report the dashboard can open", async () => {
  const dir = await tempDir("lab-settle-");
  const recorded = [];
  const { deps } = settlerDeps({
    personalOps: {
      experiments: new Map([["lab-abc123", { id: "lab-abc123", topic: "평가 방법" }]]),
      async recordExperimentResult(input) { recorded.push(input); },
      async recordRunMetric() {},
      async recordBriefing() { return null; },
    },
  });
  const { settleJob } = createJobSettler(deps);
  await settleJob({
    jobId: "j9", chatId: "1", userId: "2", prompt: "[AI_WORKMATE_LAB:lab-abc123]\n조사", status: "completed",
    summary: "핵심 결론만 답했습니다.", workspaceAlias: "default", workspacePath: dir, memories: [], artifacts: [],
  });
  const report = recorded[0].job.artifacts.at(-1);
  assert.match(report, /^documents\/reports\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}-lab-abc123\.md$/);
  assert.match(await fs.readFile(path.join(dir, report), "utf8"), /핵심 결론만 답했습니다/);
});
