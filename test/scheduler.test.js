import test from "node:test";
import assert from "node:assert/strict";
import { runDueSchedules } from "../src/scheduler.js";
import { ScheduleStore } from "../src/schedule-store.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("runDueSchedules starts due jobs and advances schedule state", async () => {
  const calls = [];
  const entry = {
    id: "sch-1",
    chatId: "100",
    userId: "200",
    workspaceAlias: "default",
    prompt: "run report",
    nextRunAt: "2026-06-19T00:00:00.000Z",
    intervalMs: null,
  };

  const started = await runDueSchedules({
    schedules: {
      due() {
        return [entry];
      },
      async markStarted(id) {
        calls.push(["markStarted", id]);
      },
      async delay() {
        throw new Error("should not delay");
      },
    },
    jobs: {
      getActiveJob() {
        return null;
      },
      async startJob(input) {
        calls.push(["startJob", input]);
        return {
          accepted: true,
          job: {
            jobId: "job-1",
            completion: Promise.resolve({ jobId: "job-1" }),
          },
        };
      },
    },
    workspaces: {
      getWorkspaceByAlias(alias) {
        return { alias, path: "/workspace/default" };
      },
    },
    memories: {
      listForPrompt() {
        return [{ id: "mem-1", text: "memory" }];
      },
    },
    telegram: {
      async sendMessage(chatId, text) {
        calls.push(["sendMessage", chatId, text]);
      },
    },
    onJobSettled(job) {
      calls.push(["settled", job.jobId]);
    },
    now: new Date("2026-06-19T00:00:00.000Z"),
  });

  await Promise.resolve();

  assert.equal(started.length, 1);
  assert.equal(calls[0][0], "startJob");
  assert.equal(calls[0][1].prompt, "run report");
  assert.equal(calls[0][1].operationMode, "default");
  assert.deepEqual(calls[0][1].memories, [{ id: "mem-1", text: "memory" }]);
  assert.deepEqual(calls[1], ["markStarted", "sch-1"]);
  assert.equal(calls.some(([name]) => name === "sendMessage"), false);
  assert.equal(calls.some(([name]) => name === "settled"), true);
});

test("runDueSchedules handles morning briefings locally without starting Codex", async () => {
  const calls = [];
  const entry = {
    id: "morning-1", chatId: "100", userId: "200", workspaceAlias: "default",
    prompt: "[AI_WORKMATE_MORNING_BRIEF_V1]\n작성", nextRunAt: "2026-09-28T23:00:00.000Z", intervalMs: 86400000,
  };
  await runDueSchedules({
    schedules: {
      due: () => [entry], isUsagePaused: () => false,
      reserveBriefingAttempt: async () => true,
      markStarted: async id => calls.push(["marked", id]),
    },
    jobs: { getActiveJob: () => null, startJob: async () => { throw new Error("Codex must not start"); } },
    workspaces: { getWorkspaceByAlias: () => ({ alias: "default", path: "/workspace" }) },
    memories: { listForPrompt: () => [] },
    telegram: { sendMessage: async () => {} },
    runLocalBriefing: async () => "☀️ 모닝 브리핑 · 테스트",
    onJobSettled: async job => calls.push(["settled", job.kind, job.summary]),
    now: new Date("2026-09-28T23:00:01.000Z"),
  });
  assert.deepEqual(calls[0], ["marked", "morning-1"]);
  assert.deepEqual(calls[1], ["settled", "scheduled-local", "☀️ 모닝 브리핑 · 테스트"]);
});

test("local reminders are delivered without Codex even while scheduled AI is paused", async () => {
  const calls = [];
  const entry = { id: "rem-1", chatId: "100", prompt: "[AI_WORKMATE_REMINDER]\n물 마시기", intervalMs: null };
  await runDueSchedules({
    schedules: {
      due: (_now, options) => { calls.push(["due", options]); return [entry]; },
      isUsagePaused: () => true,
      async markStarted(id) { calls.push(["mark", id]); },
    },
    jobs: { startJob: async () => { throw new Error("Codex must not start"); } },
    workspaces: {}, memories: {},
    telegram: { async sendMessage(chatId, text) { calls.push(["send", chatId, text]); } },
    onJobSettled() {}, now: new Date(),
  });
  assert.deepEqual(calls[0], ["due", { includeWhileUsagePaused: true }]);
  assert.deepEqual(calls[1], ["mark", "rem-1"]);
  assert.deepEqual(calls[2], ["send", "100", "⏰ 알림\n물 마시기"]);
});

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-budget-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const schedules = new ScheduleStore(path.join(dir, "state.json"));
  const now = new Date("2026-09-24T12:00:01+09:00");
  const entry = await schedules.add({ chatId: "1", userId: "2", workspaceAlias: "default",
    prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]", nextRunAt: now.toISOString(), intervalMs: 86400000 });
  let calls = 0;
  const input = { schedules, now, jobs: {
    getActiveJob: () => null,
    startJob: async (job) => { calls++; assert.equal(job.operationMode, "brief"); return { accepted: true, job: { completion: Promise.resolve({}) } }; },
  }, workspaces: { getWorkspaceByAlias: () => ({ path: "/unused" }) },
    telegram: { sendMessage: async () => {} }, onJobSettled: () => {} };
  return { schedules, entry, input, calls: () => calls };
}

test("slow context cannot overlap ticks or rewind tomorrow's reservation", async (t) => {
  const { schedules, entry, input, calls } = await setup(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  input.decoratePrompt = async prompt => { entered(); await new Promise(resolve => { release = resolve; }); return prompt; };
  const first = runDueSchedules(input);
  await ready;
  const reserved = schedules.list()[0].nextRunAt;
  assert.ok(Date.parse(reserved) > input.now.getTime());
  assert.deepEqual(await runDueSchedules(input), []);
  release(); await first;
  assert.equal(calls(), 1);
  assert.equal(schedules.list()[0].nextRunAt, reserved);
  assert.deepEqual(await runDueSchedules(input), []);
  assert.equal(entry.failureCount, 0);
});

test("busy jobs leave due time intact and do not consume budget", async (t) => {
  const { schedules, entry, input, calls } = await setup(t);
  input.jobs.getActiveJob = () => ({ jobId: "busy" });
  await runDueSchedules(input);
  assert.equal(entry.nextRunAt, input.now.toISOString());
  assert.equal(calls(), 0);
  assert.deepEqual(schedules.briefingAttempts, {});
});

test("preparation error releases tick lock but does not replay the briefing", async (t) => {
  const { input, calls } = await setup(t);
  input.decoratePrompt = async () => { throw new Error("context failed"); };
  await assert.rejects(runDueSchedules(input), /context failed/);
  assert.deepEqual(await runDueSchedules(input), []);
  assert.equal(calls(), 0);
});

test("duplicate schedule IDs for the same briefing spend only one original attempt", async (t) => {
  const { schedules, entry, input, calls } = await setup(t);
  await schedules.add({ ...entry });
  await runDueSchedules(input);
  assert.equal(calls(), 1);
});

test("usage pause prevents even context preparation", async (t) => {
  const { schedules, input, calls } = await setup(t);
  await schedules.pauseForUsageLimit("You've hit your usage limit", input.now);
  input.decoratePrompt = async () => { throw new Error("must not collect"); };
  assert.deepEqual(await runDueSchedules(input), []);
  assert.equal(calls(), 0);
});

test("an AI usage pause still delivers the locally built evening briefing", async (t) => {
  const { schedules, input, calls } = await setup(t);
  await schedules.add({ chatId: "1", userId: "2", workspaceAlias: "default",
    prompt: "[AI_WORKMATE_EVENING_BRIEF_V1]", nextRunAt: input.now.toISOString(), intervalMs: 86400000 });
  await schedules.pauseForUsageLimit("You've hit your usage limit", input.now);
  const settled = [];
  input.runLocalBriefing = async (_entry, kind) => `${kind} brief`;
  input.onJobSettled = async (job) => settled.push([job.kind, job.status, job.summary]);
  await runDueSchedules(input);
  assert.deepEqual(settled, [["scheduled-local", "completed", "evening brief"]]);
  assert.equal(calls(), 0, "the AI trend brief stays paused");
  assert.ok(schedules.list().find((entry) => entry.prompt.startsWith("[AI_WORKMATE_EVENING")).nextRunAt > input.now.toISOString());
  await runDueSchedules(input);
  assert.equal(settled.length, 1, "once per day");
});
