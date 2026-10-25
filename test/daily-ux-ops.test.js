import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScheduleStore } from "../src/schedule-store.js";
import { PersonalOpsStore } from "../src/personal-ops-store.js";
import { createJobSettler, formatUsagePauseNotice } from "../src/job-settle.js";
import { runDueSchedules } from "../src/scheduler.js";
import { applyLatePrefix, formatMorning, inboxAgeLabel, inboxFocusMarkup, pickFocusItem } from "../src/local-briefing.js";
import { runOperationalMonitor, scheduleFailureAlert } from "../src/operational-monitor.js";
import { N8nManager } from "../src/n8n-manager.js";
import { summarizeBriefingHealth } from "../src/briefing-quality.js";
import { checkDashboard, decideWatchdog, watchdogMessage } from "../scripts/watchdog.js";
import { checkUsagePause, exhaustedCodexWindows, resolveUsageReset } from "../src/usage-pause.js";

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daily-ux-ops-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function scheduleStore(t) {
  const store = new ScheduleStore(path.join(await tempDir(t), "schedules.json"));
  return store;
}

async function opsStore(t) {
  return new PersonalOpsStore(path.join(await tempDir(t), "ops.json"));
}

const NO_HEALTH_ISSUES = { services: [], storage: { configured: false }, photoBackup: { configured: false } };

// O1
test("usage pause: 6h for unknown reset, reason kept across restart, clear lifts it", async (t) => {
  const store = await scheduleStore(t);
  const now = new Date("2026-10-25T01:00:00Z");
  assert.equal(store.getUsagePause(now), null);
  assert.equal(await store.pauseForUsageLimit("network failure", now), false);
  assert.equal(store.getUsagePause(now), null);
  assert.equal(await store.pauseForUsageLimit("Error\nYou've hit your usage limit.", now), true);
  const pause = store.getUsagePause(now);
  assert.equal(Date.parse(pause.until) - now.getTime(), 6 * 3600000);
  assert.match(pause.reason, /^AI 사용 한도 도달 \(재설정 시각 불명, 6시간 대기\) · You've hit your usage limit\.$/);
  const reloaded = new ScheduleStore(store.statePath);
  await reloaded.load();
  assert.deepEqual(reloaded.getUsagePause(now), pause);
  await reloaded.clearUsagePause();
  assert.equal(reloaded.getUsagePause(now), null);
  const again = new ScheduleStore(store.statePath);
  await again.load();
  assert.equal(again.isUsagePaused(now), false);
});

function settlerDeps({ schedules, sent }) {
  return {
    config: { scheduleMaxFailures: 3 },
    telegram: { async sendMessage(chatId, text) { sent.push([chatId, text]); return { message_id: 7 }; } },
    jobs: { async startJob() { return { accepted: false }; } },
    workspaces: { getWorkspaceByAlias: (alias) => ({ alias, path: "/tmp" }) },
    schedules,
    personalOps: {
      metrics: [],
      listBriefingHistory: () => [],
      async recordRunMetric(job) { this.metrics.push(job.jobId); },
      async recordBriefing() { return null; },
      async recordTrendTopics() {},
    },
    sessions: { remembered: 0, async rememberBotReply() { this.remembered += 1; } },
  };
}

test("a new usage pause sends one Korean notice; an active pause does not resend", async (t) => {
  const schedules = await scheduleStore(t);
  const sent = [];
  const { settleJob } = createJobSettler(settlerDeps({ schedules, sent }));
  const failed = (id) => ({ jobId: id, chatId: "100", status: "failed", prompt: "x", summary: "usage_limit_reached", deliverToTelegram: false });
  await settleJob(failed("a"));
  await settleJob(failed("b"));
  assert.equal(sent.length, 1);
  const [chatId, text] = sent[0];
  assert.equal(chatId, "100");
  assert.match(text, /사유: AI 사용 한도 도달/);
  assert.match(text, /재개 예정: .+ \(KST\)/);
  assert.match(text, /모닝·이브닝 브리핑과 영어 학습은 계속/);
  assert.match(text, /\/resume/);
  await schedules.clearUsagePause();
  await settleJob(failed("c"));
  assert.equal(sent.length, 2);
});

test("pause notice formats the end time in KST", () => {
  const text = formatUsagePauseNotice({ until: "2026-10-25T03:30:00Z", reason: "AI 사용 한도 도달" });
  assert.match(text, /12:30 \(KST\)/);
});

// O7
test("deliverToTelegram false skips the result message and session but records metrics and schedule result", async () => {
  const sent = [];
  const results = [];
  const schedules = {
    isUsagePaused: () => false, async pauseForUsageLimit() { return false; }, async reserveBriefingAttempt() { return true; },
    async recordSuccess(id) { results.push(["success", id]); }, async recordFailure() { return null; },
  };
  const deps = settlerDeps({ schedules, sent });
  const { settleJob } = createJobSettler(deps);
  await settleJob({ jobId: "dash-1", chatId: "100", status: "completed", prompt: "hello", summary: "done", sessionId: "s1", scheduleId: "sch", deliverToTelegram: false });
  assert.deepEqual(sent, []);
  assert.equal(deps.sessions.remembered, 0);
  assert.deepEqual(deps.personalOps.metrics, ["dash-1"]);
  assert.deepEqual(results, [["success", "sch"]]);
});

// O3
test("runNow makes a daily entry due now and returns to its regular time afterwards", async (t) => {
  const store = await scheduleStore(t);
  const regular = new Date(2026, 9, 23, 8, 0);
  const now = new Date(2026, 9, 22, 15, 0);
  const entry = await store.add({ chatId: "1", userId: "2", workspaceAlias: "default", prompt: "daily report", nextRunAt: regular, intervalMs: 86400000 });
  assert.equal(await store.runNow(entry.id, { chatId: "other", now }), null);
  assert.equal(await store.runNow("missing", { chatId: "1", now }), null);
  const updated = await store.runNow(entry.id, { chatId: "1", now });
  assert.equal(updated.nextRunAt, now.toISOString());
  assert.deepEqual(store.due(now).map((row) => row.id), [entry.id]);
  const reloaded = new ScheduleStore(store.statePath);
  await reloaded.load();
  await reloaded.markStarted(entry.id, now);
  assert.equal(reloaded.list()[0].nextRunAt, regular.toISOString());
});

test("run now re-runs a briefing already attempted today exactly once more", async (t) => {
  const store = await scheduleStore(t);
  const now = new Date("2026-10-25T12:00:01+09:00");
  const entry = await store.add({ chatId: "1", userId: "2", workspaceAlias: "default",
    prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]", nextRunAt: now.toISOString(), intervalMs: 86400000 });
  let started = 0;
  const input = { schedules: store, now, jobs: {
    getActiveJob: () => null,
    startJob: async () => { started++; return { accepted: true, job: { completion: Promise.resolve({}) } }; },
  }, workspaces: { getWorkspaceByAlias: () => ({ alias: "default", path: "/unused" }) },
  telegram: { sendMessage: async () => {} }, onJobSettled: () => {} };
  await runDueSchedules(input);
  assert.equal(started, 1);
  const later = new Date(now.getTime() + 60 * 60 * 1000);
  await store.runNow(entry.id, { chatId: "1", now: later });
  await runDueSchedules({ ...input, now: later });
  assert.equal(started, 2, "the manual run is not swallowed by the daily ledger");
  assert.equal(store.list()[0].manualRun, undefined);
  await store.runNow(entry.id, { chatId: "1", now: later });
  await runDueSchedules({ ...input, now: later });
  assert.equal(started, 2, "only one extra manual attempt per day");
  assert.ok(Date.parse(store.list()[0].nextRunAt) > later.getTime());
});

test("skipNext advances one occurrence and respects weekdaysOnly", async (t) => {
  const store = await scheduleStore(t);
  const friday = new Date(2026, 9, 23, 8, 0);
  const now = new Date(2026, 9, 22, 20, 0);
  const entry = await store.add({ chatId: "1", userId: "2", workspaceAlias: "default", prompt: "weekday", nextRunAt: friday, intervalMs: 86400000, weekdaysOnly: true });
  assert.equal(await store.skipNext(entry.id, { chatId: "2", now }), null);
  const skipped = await store.skipNext(entry.id, { chatId: "1", now });
  assert.equal(skipped.nextRunAt, new Date(2026, 9, 26, 8, 0).toISOString());
  const hourly = await store.add({ chatId: "1", userId: "2", workspaceAlias: "default", prompt: "hourly", nextRunAt: new Date(2026, 9, 22, 21, 0), intervalMs: 3600000 });
  assert.equal((await store.skipNext(hourly.id, { chatId: "1", now })).nextRunAt, new Date(2026, 9, 22, 22, 0).toISOString());
  const once = await store.add({ chatId: "1", userId: "2", workspaceAlias: "default", prompt: "once", nextRunAt: new Date(2026, 9, 23), intervalMs: null });
  assert.equal((await store.skipNext(once.id, { chatId: "1", now })).removed, true);
  assert.equal(store.list().some((row) => row.id === once.id), false);
});

// O4 + O6 scheduler wiring
test("late local briefing gets the delayed prefix, late flag and the focus reply markup", async () => {
  const settled = [];
  let received;
  const entry = { id: "m1", chatId: "100", userId: "200", workspaceAlias: "default",
    prompt: "[AI_WORKMATE_MORNING_BRIEF_V1]", nextRunAt: "2026-10-24T23:00:00.000Z", intervalMs: 86400000 };
  const markup = inboxFocusMarkup("in-abc123");
  await runDueSchedules({
    schedules: {
      due: () => [entry], isUsagePaused: () => true, reserveBriefingAttempt: async () => true,
      markStarted: async () => { entry.nextRunAt = "2026-10-25T23:00:00.000Z"; },
    },
    jobs: { getActiveJob: () => null, startJob: async () => { throw new Error("no AI"); } },
    workspaces: { getWorkspaceByAlias: () => ({ alias: "default", path: "/w" }) },
    memories: { listForPrompt: () => [] },
    telegram: { sendMessage: async () => { throw new Error("no direct send"); } },
    runLocalBriefing: async (_entry, _kind, _now, options) => { received = options; return { summary: "☀️ 모닝 브리핑", replyMarkup: markup }; },
    onJobSettled: async (job) => settled.push(job),
    now: new Date("2026-10-24T23:25:00.000Z"),
  });
  assert.equal(received.scheduledAt, "2026-10-24T23:00:00.000Z");
  assert.equal(settled[0].summary, "⏰ 지연 발송 (원래 08:00)\n☀️ 모닝 브리핑");
  assert.equal(settled[0].late, true);
  assert.deepEqual(settled[0].replyMarkup, markup);
});

test("late prefix applies only beyond 10 minutes", () => {
  const at = "2026-10-24T23:00:00.000Z";
  assert.deepEqual(applyLatePrefix("x", at, new Date("2026-10-24T23:10:00.000Z")), { text: "x", late: false });
  assert.equal(applyLatePrefix("x", at, new Date("2026-10-24T23:10:01.000Z")).late, true);
  assert.equal(applyLatePrefix("x", null, new Date()).late, false);
});

// O6
test("inbox keeps dueAt and the focus picks overdue/due-soon, then the oldest", async (t) => {
  const store = await opsStore(t);
  const now = new Date("2026-10-25T00:00:00Z");
  const old = await store.addInbox({ chatId: "1", type: "task", text: "오래된 일", now: new Date("2026-10-20T00:00:00Z") });
  await store.addInbox({ chatId: "1", type: "task", text: "새 일", now: new Date("2026-10-24T00:00:00Z") });
  assert.equal(pickFocusItem(store.listInbox("1", { now }), now).id, old.id);
  const due = await store.addInbox({ chatId: "1", type: "task", text: "마감 일", dueAt: "2026-10-26T00:00:00Z", now });
  await store.addInbox({ chatId: "1", type: "task", text: "먼 마감", dueAt: "2026-11-30T00:00:00Z", now });
  await assert.rejects(store.addInbox({ chatId: "1", text: "x", dueAt: "nope" }), /Invalid inbox due date/);
  const rows = store.listInbox("1", { now });
  assert.equal(rows.find((row) => row.id === due.id).dueAt, "2026-10-26T00:00:00.000Z");
  assert.equal(pickFocusItem(rows, now).id, due.id);
  const reloaded = new PersonalOpsStore(store.statePath);
  await reloaded.load();
  assert.equal(reloaded.listInbox("1", { now }).find((row) => row.id === due.id).dueAt, "2026-10-26T00:00:00.000Z");
});

test("morning focus shows days waiting and due date; buttons fit the callback limit", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const focus = { id: "in-abc123", type: "task", text: "보고서", status: "open", createdAt: "2026-10-21T01:00:00Z", dueAt: "2026-10-24T00:00:00Z" };
  assert.equal(inboxAgeLabel(focus, now), "5일째 · 마감 지남 10/24");
  const text = formatMorning({ weather: { ok: false }, calendar: { today: [] }, personal: { inbox: [focus] } }, [], now, []);
  assert.match(text, /🎯 오늘의 초점\n• 보고서 \(5일째 · 마감 지남 10\/24\) — 첫 10분/);
  const markup = inboxFocusMarkup(focus.id);
  assert.deepEqual(markup.inline_keyboard[0].map((button) => button.callback_data), ["inbox:done:in-abc123", "inbox:later:in-abc123"]);
  for (const button of markup.inline_keyboard[0]) assert.ok(Buffer.byteLength(button.callback_data) < 64);
});

// O2
test("schedule failure alert is sent once per failure episode of each schedule", async () => {
  const sent = [];
  const keys = new Set();
  const personalOps = { async reserveAlert(key, options) { assert.equal(options.cooldownMs, Infinity); if (keys.has(key)) return false; keys.add(key); return true; } };
  const rows = [{ id: "abc12345", prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]", failureCount: 1, failingSince: "2026-10-24T03:00:00Z", lastError: "\nClaude exited 1\nstack..." }];
  const run = () => runOperationalMonitor({
    config: { operationalMonitoringEnabled: true, defaultTelegramTargetChatId: "1", personalBriefingsEnabled: false },
    buildHealth: async () => NO_HEALTH_ISSUES,
    schedules: { list: () => rows },
    personalOps,
    telegram: { async sendMessage(chatId, text) { sent.push(text); } },
    now: new Date("2026-10-25T00:00:00Z"),
  });
  assert.deepEqual(await run(), ["schedule-failure"]);
  assert.match(sent[0], /• AI 트렌드 \(abc12345\) 실패\n {2}사유: Claude exited 1\n다시 실행: \/runnow abc12345/);
  assert.deepEqual(await run(), []);
  // More failures in the same episode stay quiet.
  rows[0].failureCount = 2;
  assert.deepEqual(await run(), []);
  // Another schedule failing announces only the new one.
  rows.push({ id: "def67890", prompt: "매일 뉴스", failureCount: 1, failingSince: "2026-10-25T00:00:00Z", lastError: "boom" });
  assert.deepEqual(await run(), ["schedule-failure"]);
  assert.doesNotMatch(sent[1], /abc12345/);
  assert.match(sent[1], /def67890/);
  // A new episode after a success is announced again.
  rows.splice(1, 1);
  rows[0].failingSince = "2026-10-26T03:00:00Z";
  assert.deepEqual(await run(), ["schedule-failure"]);
  assert.equal(sent.length, 3);
  assert.equal(await scheduleFailureAlert([], { personalOps }), null);
});

test("failure episode starts on the first failure, survives restart and ends on success", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "schedules.json");
  const store = new ScheduleStore(file);
  const entry = await store.add({ chatId: "1", userId: "2", workspaceAlias: "default", prompt: "매일 뉴스", nextRunAt: new Date("2026-10-25T03:00:00Z"), intervalMs: 86400000 });
  await store.recordFailure(entry.id, "boom");
  const since = store.list()[0].failingSince;
  assert.ok(since);
  await store.recordFailure(entry.id, "boom again");
  assert.equal(store.list()[0].failingSince, since);
  const reloaded = new ScheduleStore(file);
  await reloaded.load();
  assert.equal(reloaded.list()[0].failingSince, since);
  await reloaded.recordSuccess(entry.id);
  assert.equal(reloaded.list()[0].failingSince, undefined);
});

// O5
test("n8n failures produce one daily summary with names and counts", async () => {
  const sent = [];
  const reserved = new Map();
  let since;
  const n8n = { async recentFailures(options) { since = options.since; return [{ name: "뉴스 수집", count: 3 }, { name: "백업", count: 1 }]; } };
  const run = (now) => runOperationalMonitor({
    config: { operationalMonitoringEnabled: true, defaultTelegramTargetChatId: "1", personalBriefingsEnabled: false },
    buildHealth: async () => NO_HEALTH_ISSUES,
    schedules: { list: () => [] }, n8n,
    personalOps: { async reserveAlert(key, { now: at, cooldownMs }) {
      const last = reserved.get(key);
      if (last && at - last < cooldownMs) return false;
      reserved.set(key, at); return true;
    } },
    telegram: { async sendMessage(_chatId, text) { sent.push(text); } },
    now,
  });
  const now = new Date("2026-10-25T00:00:00Z");
  assert.deepEqual(await run(now), ["n8n-failures"]);
  assert.equal(since.toISOString(), "2026-10-24T00:00:00.000Z");
  assert.match(sent[0], /n8n 실행 실패 4건\n• 뉴스 수집: 3회\n• 백업: 1회/);
  assert.deepEqual(await run(new Date("2026-10-25T10:00:00Z")), []);
  assert.deepEqual(await run(new Date("2026-10-26T00:00:01Z")), ["n8n-failures"]);
});

test("N8nManager.recentFailures counts failed executions of active workflows only (mocked fetch)", async () => {
  const requests = [];
  const manager = new N8nManager({
    port: 1,
    readApiKey: async () => "key",
    fetchImpl: async (url, options) => {
      requests.push([url, options.headers["X-N8N-API-KEY"]]);
      const body = url.includes("/workflows")
        ? { data: [{ id: "w1", name: "뉴스", active: true }, { id: "w2", name: "꺼짐", active: false }] }
        : { data: [
          { workflowId: "w1", startedAt: "2026-10-24T12:00:00Z" },
          { workflowId: "w1", startedAt: "2026-10-24T13:00:00Z" },
          { workflowId: "w1", startedAt: "2026-10-20T13:00:00Z" },
          { workflowId: "w2", startedAt: "2026-10-24T13:00:00Z" },
        ] };
      return { ok: true, async json() { return body; } };
    },
  });
  assert.deepEqual(await manager.recentFailures({ since: new Date("2026-10-24T00:00:00Z") }), [{ name: "뉴스", count: 2 }]);
  assert.ok(requests.every(([url, key]) => url.startsWith("http://127.0.0.1:1/api/v1/") && key === "key"));
  assert.ok(requests.some(([url]) => url.includes("status=error")));
});

// O8
test("briefing health counts late deliveries, feedback and local build failures over 14 days", async (t) => {
  const store = await opsStore(t);
  const now = new Date("2026-10-25T00:00:00Z");
  const a = await store.recordBriefing({ chatId: "1", kind: "morning", text: "⏰ 지연 발송 (원래 08:00)\n☀️", recommendations: ["x"], now: new Date("2026-10-24T00:00:00Z") });
  await store.recordBriefing({ chatId: "1", kind: "evening", text: "🌙", late: true, now: new Date("2026-10-23T12:00:00Z") });
  await store.recordBriefing({ chatId: "1", kind: "morning", text: "☀️", now: new Date("2026-10-22T00:00:00Z") });
  await store.recordBriefing({ chatId: "1", kind: "morning", text: "⏰ 지연 발송 old", now: new Date("2026-10-01T00:00:00Z") });
  await store.setBriefingFeedback({ chatId: "1", id: a.id, feedback: "interest" });
  await store.recordRunMetric({ jobId: "local-morning-2026-10-24", chatId: "1", kind: "scheduled-local", status: "failed", startedAt: "2026-10-24T00:00:00Z", finishedAt: "2026-10-24T00:00:00Z" });
  await store.recordRunMetric({ jobId: "local-evening-2026-10-24", chatId: "1", kind: "scheduled-local", status: "completed", late: true, startedAt: "2026-10-24T12:00:00Z", finishedAt: "2026-10-24T12:00:00Z" });
  await store.recordRunMetric({ jobId: "c1", chatId: "1", provider: "claude", status: "failed", startedAt: "2026-10-24T12:00:00Z", finishedAt: "2026-10-24T12:00:00Z" });
  assert.equal(store.listRunMetrics("1", { days: 14, now }).find((row) => row.id === "local-evening-2026-10-24").late, true);
  assert.deepEqual(summarizeBriefingHealth({ personalOps: store, chatId: "1", now }), {
    days: 14, briefings: 3, lateDeliveries: 2, feedbackCount: 1, feedbackRate: 0.33, localFailures: 1,
  });
  assert.deepEqual(summarizeBriefingHealth({ personalOps: null, chatId: "1", now }), {
    days: 14, briefings: 0, lateDeliveries: 0, feedbackCount: 0, feedbackRate: 0, localFailures: 0,
  });
});

// O9
test("watchdog notifies after two consecutive failures and once on recovery", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  let step = decideWatchdog({}, false, now);
  assert.equal(step.notify, null);
  step = decideWatchdog(step.state, false, now);
  assert.equal(step.notify, "down");
  assert.equal(step.state.alerted, true);
  step = decideWatchdog(step.state, false, now);
  assert.equal(step.notify, null);
  assert.equal(step.state.consecutiveFailures, 3);
  assert.match(watchdogMessage("down", step.state, "ECONNREFUSED"), /3회 연속 실패[\s\S]*ECONNREFUSED/);
  step = decideWatchdog(step.state, true, now);
  assert.equal(step.notify, "recovered");
  step = decideWatchdog(step.state, true, now);
  assert.equal(step.notify, null);
  // A single blip never alerts, so it never produces a recovery notice either.
  step = decideWatchdog(decideWatchdog(step.state, false, now).state, true, now);
  assert.equal(step.notify, null);
});

test("watchdog dashboard check uses the local API and treats errors as failures (mocked fetch)", async () => {
  let requested;
  assert.deepEqual(await checkDashboard({ port: 8766, fetchImpl: async (url) => { requested = url; return { ok: true }; } }), { ok: true });
  assert.equal(requested, "http://127.0.0.1:8766/api/dashboard");
  assert.deepEqual(await checkDashboard({ port: 1, fetchImpl: async () => ({ ok: false, status: 500 }) }), { ok: false, error: "HTTP 500" });
  assert.equal((await checkDashboard({ port: 1, fetchImpl: async () => { throw new Error("refused"); } })).ok, false);
});

// O10
const codexLimits = (fiveUsed, fiveReset, weekUsed = 30, weekReset = "2026-10-31T01:00:00Z") => ({
  status: "available",
  fiveHour: { usedPercent: fiveUsed, remainingPercent: 100 - fiveUsed, resetsAt: fiveReset },
  weekly: { usedPercent: weekUsed, remainingPercent: 100 - weekUsed, resetsAt: weekReset },
});

test("exhausted Codex windows give the latest reset; failed reads give null", () => {
  const now = new Date("2026-10-25T01:00:00Z");
  assert.deepEqual(exhaustedCodexWindows(codexLimits(100, "2026-10-25T03:00:00Z"), now), { exhausted: true, resetAt: "2026-10-25T03:00:00.000Z" });
  assert.deepEqual(exhaustedCodexWindows(codexLimits(100, "2026-10-25T03:00:00Z", 100, "2026-10-27T00:00:00Z"), now), { exhausted: true, resetAt: "2026-10-27T00:00:00.000Z" });
  assert.deepEqual(exhaustedCodexWindows(codexLimits(40, "2026-10-25T03:00:00Z"), now), { exhausted: false, resetAt: null });
  assert.equal(exhaustedCodexWindows({ status: "unavailable", fiveHour: null, weekly: null }, now), null);
  assert.equal(exhaustedCodexWindows(null, now), null);
});

test("resolveUsageReset uses Codex limits or the Claude rate-limit event", async () => {
  const now = new Date("2026-10-25T01:00:00Z");
  const codex = await resolveUsageReset({ provider: "codex" }, { readCodexLimits: async () => codexLimits(100, "2026-10-25T03:00:00Z"), now });
  assert.deepEqual(codex, { provider: "codex", resetAt: "2026-10-25T03:00:00.000Z", canReleaseEarly: true });
  // Limits that do not show the exhaustion cannot be trusted to end the pause early.
  const blind = await resolveUsageReset({ provider: "codex" }, { readCodexLimits: async () => codexLimits(10, "2026-10-25T03:00:00Z"), now });
  assert.deepEqual(blind, { provider: "codex", resetAt: null, canReleaseEarly: false });
  const failing = await resolveUsageReset({ provider: "codex" }, { readCodexLimits: async () => { throw new Error("x"); }, now });
  assert.equal(failing.canReleaseEarly, false);
  const claude = await resolveUsageReset({ provider: "claude", claudeRateLimit: { resetsAt: Date.parse("2026-10-25T05:00:00Z") / 1000 } }, { now });
  assert.deepEqual(claude, { provider: "claude", resetAt: "2026-10-25T05:00:00.000Z", canReleaseEarly: false });
});

test("pause ends at the provider reset and the notice names the schedule", async (t) => {
  const schedules = await scheduleStore(t);
  const sent = [];
  const deps = settlerDeps({ schedules, sent });
  deps.readCodexLimits = async () => codexLimits(100, new Date(Date.now() + 2 * 3600000).toISOString());
  const { settleJob } = createJobSettler(deps);
  await settleJob({ jobId: "a", chatId: "100", status: "failed", provider: "codex", scheduleId: "6e958e07", prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]", summary: "You've hit your usage limit. try again...", deliverToTelegram: false });
  const pause = schedules.getUsagePause();
  assert.ok(Math.abs(Date.parse(pause.until) - (Date.now() + 2 * 3600000 + 60000)) < 5000);
  assert.equal(pause.canReleaseEarly, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /영향: AI 트렌드/);
  assert.match(sent[0][1], /한도가 먼저 갱신되면 바로 재개/);
  assert.doesNotMatch(sent[0][1], /재설정 시각 불명/);
});

test("checkUsagePause releases early once limits recover and announces the resume once", async (t) => {
  const schedules = await scheduleStore(t);
  const sent = [];
  const telegram = { async sendMessage(chatId, text) { sent.push([chatId, text]); } };
  const start = new Date("2026-10-25T01:00:00Z");
  await schedules.pauseForUsageLimit("usage_limit_reached", start, { resetAt: "2026-10-25T03:00:00Z", provider: "codex", chatId: "100", canReleaseEarly: true });
  let limits = codexLimits(100, "2026-10-25T04:00:00Z");
  const check = (now) => checkUsagePause({ schedules, readCodexLimits: async () => limits, telegram, now });
  // Still exhausted: a later reset extends the pause.
  assert.equal(await check(new Date("2026-10-25T01:20:00Z")), null);
  assert.equal(schedules.getUsagePause(new Date("2026-10-25T01:20:00Z")).until, "2026-10-25T04:01:00.000Z");
  // Rechecks are rate limited to every 15 minutes.
  limits = codexLimits(0, "2026-10-25T06:00:00Z");
  assert.equal(await check(new Date("2026-10-25T01:25:00Z")), null);
  assert.equal(await check(new Date("2026-10-25T01:40:00Z")), "released");
  assert.equal(schedules.isUsagePaused(new Date("2026-10-25T01:40:00Z")), false);
  assert.deepEqual(sent, [["100", "▶️ AI 사용 한도가 갱신되어 예약 작업을 다시 시작합니다."]]);
  assert.equal(await check(new Date("2026-10-25T02:00:00Z")), null);
  assert.equal(sent.length, 1);
  // A pause hit again soon after an early release waits for its end time.
  await schedules.pauseForUsageLimit("usage_limit_reached", new Date("2026-10-25T02:00:00Z"), { resetAt: "2026-10-25T03:00:00Z", provider: "codex", chatId: "100", canReleaseEarly: true });
  assert.equal(schedules.peekUsagePause().canReleaseEarly, false);
  assert.equal(await check(new Date("2026-10-25T02:30:00Z")), null);
  assert.equal(schedules.isUsagePaused(new Date("2026-10-25T02:30:00Z")), true);
});

test("checkUsagePause announces a pause that reached its end time once, and ignores manual resume", async (t) => {
  const schedules = await scheduleStore(t);
  const sent = [];
  const telegram = { async sendMessage(chatId, text) { sent.push([chatId, text]); } };
  // A legacy pause without metadata uses the fallback chat.
  await schedules.pauseForUsageLimit("usage_limit_reached", new Date("2026-10-25T01:00:00Z"));
  const check = (now) => checkUsagePause({ schedules, telegram, fallbackChatId: "9", now });
  assert.equal(await check(new Date("2026-10-25T02:00:00Z")), null);
  assert.equal(await check(new Date("2026-10-25T07:00:01Z")), "expired");
  assert.equal(await check(new Date("2026-10-25T07:01:00Z")), null);
  assert.deepEqual(sent, [["9", "▶️ AI 사용 한도 재설정 시각이 지나 예약 작업을 다시 시작합니다."]]);
  await schedules.pauseForUsageLimit("usage_limit_reached", new Date("2026-10-25T08:00:00Z"), { chatId: "100" });
  await schedules.clearUsagePause();
  assert.equal(await check(new Date("2026-10-25T20:00:00Z")), null);
  assert.equal(sent.length, 1);
});

// O11
test("a usage-limit failure does not count as a schedule failure", async (t) => {
  const store = await scheduleStore(t);
  const entry = await store.add({ chatId: "100", userId: "2", workspaceAlias: "default", prompt: "매일 뉴스", nextRunAt: new Date(Date.now() + 3600000), intervalMs: 86400000 });
  const sent = [];
  const { settleJob } = createJobSettler(settlerDeps({ schedules: store, sent }));
  await settleJob({ jobId: "a", chatId: "100", status: "failed", provider: "codex", scheduleId: entry.id, prompt: "매일 뉴스", summary: "You've hit your usage limit.", deliverToTelegram: false });
  assert.equal(store.list()[0].failureCount, 0);
  assert.equal(store.list()[0].failingSince, undefined);
  await store.clearUsagePause();
  await settleJob({ jobId: "b", chatId: "100", status: "failed", provider: "codex", scheduleId: entry.id, prompt: "매일 뉴스", summary: "Claude exited 1", deliverToTelegram: false });
  assert.equal(store.list()[0].failureCount, 1);
});

test("a usage-limited scheduled run sends only the pause notice; a manual run keeps its result", async (t) => {
  const store = await scheduleStore(t);
  const entry = await store.add({ chatId: "100", userId: "2", workspaceAlias: "default", prompt: "매일 뉴스", nextRunAt: new Date(Date.now() + 3600000), intervalMs: 86400000 });
  const sent = [];
  const { settleJob } = createJobSettler(settlerDeps({ schedules: store, sent }));
  await settleJob({ jobId: "a", chatId: "100", status: "failed", provider: "codex", scheduleId: entry.id, prompt: "매일 뉴스", summary: "You've hit your usage limit." });
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /^⏸ AI 예약 작업을 잠시 멈췄습니다/);
  await settleJob({ jobId: "b", chatId: "100", status: "failed", provider: "codex", prompt: "질문", summary: "You've hit your usage limit." });
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[1][1], /^⏸/);
});

test("an unknown reset does not stretch an active pause; a known later reset does", async (t) => {
  const store = await scheduleStore(t);
  const now = new Date("2026-10-25T01:00:00Z");
  await store.pauseForUsageLimit("usage_limit_reached", now, { resetAt: "2026-10-25T02:00:00Z", provider: "codex" });
  assert.equal(await store.pauseForUsageLimit("You've hit your usage limit.", new Date("2026-10-25T01:30:00Z")), true);
  assert.equal(store.peekUsagePause().until, "2026-10-25T02:01:00.000Z");
  await store.pauseForUsageLimit("usage_limit_reached", new Date("2026-10-25T01:30:00Z"), { resetAt: "2026-10-25T05:00:00Z" });
  assert.equal(store.peekUsagePause().until, "2026-10-25T05:01:00.000Z");
});

test("a resume during the limit read is not announced twice and leaves no early-release mark", async (t) => {
  const schedules = await scheduleStore(t);
  const sent = [];
  await schedules.pauseForUsageLimit("usage_limit_reached", new Date("2026-10-25T01:00:00Z"), { resetAt: "2026-10-25T03:00:00Z", provider: "codex", chatId: "100", canReleaseEarly: true });
  const readCodexLimits = async () => { await schedules.clearUsagePause(); return codexLimits(0, "2026-10-25T06:00:00Z"); };
  const result = await checkUsagePause({ schedules, readCodexLimits, telegram: { async sendMessage(c, text) { sent.push(text); } }, now: new Date("2026-10-25T01:30:00Z") });
  assert.equal(result, null);
  assert.deepEqual(sent, []);
  assert.equal(schedules.lastEarlyReleaseAt, null);
});

test("an entry failing before episodes existed gets a stable failingSince on load", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "schedules.json");
  const legacy = { id: "6e958e07", chatId: "1", userId: "2", workspaceAlias: "default", prompt: "매일 뉴스", nextRunAt: "2026-10-25T03:00:00.000Z", intervalMs: 86400000, weekdaysOnly: false, failureCount: 1, lastError: "x", createdAt: "2026-09-26T03:58:30.174Z" };
  await fs.writeFile(file, JSON.stringify({ version: 1, entries: [legacy] }));
  const store = new ScheduleStore(file);
  await store.load();
  assert.equal(store.list()[0].failingSince, "2026-09-26T03:58:30.174Z");
  await store.recordFailure("6e958e07", "again");
  assert.equal(store.list()[0].failingSince, "2026-09-26T03:58:30.174Z");
});

// O12
test("run issues keep last week's failures after the streak resets", async (t) => {
  const ops = await opsStore(t);
  const now = new Date();
  const ago = (hours) => new Date(now.getTime() - hours * 3600000).toISOString();
  await ops.recordRunMetric({ jobId: "f1", chatId: "1", status: "failed", provider: "codex", scheduleId: "6e958e07", prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]\nx", summary: "\nYou've hit your usage limit.\nmore", startedAt: ago(30), finishedAt: ago(30) });
  await ops.recordRunMetric({ jobId: "ok", chatId: "1", status: "completed", provider: "codex", scheduleId: "6e958e07", prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]\nx", summary: "fine", startedAt: ago(2), finishedAt: ago(2) });
  await ops.recordRunMetric({ jobId: "late", chatId: "1", kind: "scheduled-local", status: "completed", late: true, prompt: "[AI_WORKMATE_EVENING_BRIEF_V1]", summary: "x", startedAt: ago(20), finishedAt: ago(20) });
  await ops.recordRunMetric({ jobId: "old", chatId: "1", status: "failed", provider: "codex", prompt: "x", summary: "old", startedAt: ago(200), finishedAt: ago(200) });
  const issues = ops.listRunIssues("1", { days: 7, now });
  assert.deepEqual(issues.map((row) => [row.status, row.late, row.error]), [["completed", true, null], ["failed", false, "You've hit your usage limit."]]);
  assert.equal(ops.runMetrics.get("f1").scheduleId, "6e958e07");
});
