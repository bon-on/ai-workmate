import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScheduleStore, parseNaturalScheduleRequest, parseScheduleRequest } from "../src/schedule-store.js";

async function briefingStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "briefing-budget-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ScheduleStore(path.join(dir, "state.json"));
  const now = new Date("2026-09-24T12:00:01+09:00");
  const entry = await store.add({ chatId: "1", userId: "2", workspaceAlias: "default",
    prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]", nextRunAt: now.toISOString(), intervalMs: 86400000 });
  return { store, now, entry };
}

test("briefing budget survives restart: one original plus one correction, across schedule IDs", async (t) => {
  const { store, entry, now } = await briefingStore(t);
  assert.equal(await store.reserveBriefingAttempt(entry, { now, retry: true }), false);
  assert.equal(await store.reserveBriefingAttempt(entry, { now }), true);
  const reloaded = new ScheduleStore(store.statePath);
  await reloaded.load();
  assert.equal(await reloaded.reserveBriefingAttempt({ ...entry, id: "different" }, { now }), false);
  assert.equal(await reloaded.reserveBriefingAttempt(entry, { now, retry: true }), true);
  assert.equal(await reloaded.reserveBriefingAttempt(entry, { now, retry: true }), false);
  assert.equal(await reloaded.reserveBriefingAttempt(entry, { now: new Date("2026-09-25T00:00:01+09:00") }), true);
});

test("concurrent reservations permit only one original", async (t) => {
  const { store, entry, now } = await briefingStore(t);
  assert.deepEqual(await Promise.all([store.reserveBriefingAttempt(entry, { now }), store.reserveBriefingAttempt(entry, { now })]), [true, false]);
});

test("failed briefings retain next normal run instead of frequent retry or deletion", async (t) => {
  const { store, entry, now } = await briefingStore(t);
  await store.markStarted(entry.id, now);
  const next = entry.nextRunAt;
  for (let i = 0; i < 4; i++) await store.recordFailure(entry.id, "failure");
  assert.equal(store.list()[0].nextRunAt, next);
});

test("usage limit pauses all scheduled work across restart until reset", async (t) => {
  const { store, now } = await briefingStore(t);
  assert.equal(await store.pauseForUsageLimit("network failure", now), false);
  assert.equal(await store.pauseForUsageLimit("You've hit your usage limit. try again at Sep 27th, 2026 8:00 AM.", now), true);
  const reloaded = new ScheduleStore(store.statePath); await reloaded.load();
  assert.equal(reloaded.isUsagePaused(now), true);
  assert.deepEqual(reloaded.due(now), []);
  const until = Date.parse(reloaded.usagePausedUntil);
  assert.equal(until, new Date(2026, 8, 27, 8, 1).getTime());
  assert.equal(reloaded.isUsagePaused(new Date(until)), false);
});

test("unknown usage reset uses conservative 24-hour cooldown", async (t) => {
  const { store, now } = await briefingStore(t);
  await store.pauseForUsageLimit("usage_limit_reached", now);
  assert.equal(Date.parse(store.usagePausedUntil) - now.getTime(), 86400000);
});

test("parseScheduleRequest parses one-time and recurring schedules", () => {
  const now = new Date("2026-06-19T00:00:00.000Z");

  assert.deepEqual(parseScheduleRequest("in 10m summarize status", now), {
    intervalMs: null,
    nextRunAt: "2026-06-19T00:10:00.000Z",
    weekdaysOnly: false,
    prompt: "summarize status",
  });

  assert.deepEqual(parseScheduleRequest("every 2h run report", now), {
    intervalMs: 7200000,
    nextRunAt: "2026-06-19T02:00:00.000Z",
    weekdaysOnly: false,
    prompt: "run report",
  });
});

test("parseScheduleRequest parses daily and weekday Korean schedules", () => {
  const fridayMorning = new Date(2026, 5, 19, 8, 0, 0);
  const fridayLate = new Date(2026, 5, 19, 10, 0, 0);
  const fridayNine = new Date(2026, 5, 19, 9, 0, 0).toISOString();
  const mondayNine = new Date(2026, 5, 22, 9, 0, 0).toISOString();

  assert.deepEqual(parseScheduleRequest("매일 9시 상태 요약", fridayMorning), {
    intervalMs: 86400000,
    nextRunAt: fridayNine,
    weekdaysOnly: false,
    prompt: "상태 요약",
  });

  assert.deepEqual(parseScheduleRequest("평일 9시 상태 요약", fridayLate), {
    intervalMs: 86400000,
    nextRunAt: mondayNine,
    weekdaysOnly: true,
    prompt: "상태 요약",
  });
});

test("parseNaturalScheduleRequest distinguishes reminders from recurring AI work", () => {
  const now = new Date(2026, 9, 4, 13, 0, 0);
  const reminder = parseNaturalScheduleRequest("10분후에 알려줘", now);
  assert.equal(reminder.kind, "reminder");
  assert.equal(Date.parse(reminder.nextRunAt) - now.getTime(), 10 * 60 * 1000);
  assert.match(reminder.prompt, /^\[AI_WORKMATE_REMINDER\]/);

  const news = parseNaturalScheduleRequest("매일 오후 2시에 AI 뉴스 스크랩해서 알려줘", now);
  assert.equal(news.kind, "ai");
  assert.equal(news.intervalMs, 86400000);
  assert.equal(new Date(news.nextRunAt).getHours(), 14);
  assert.match(news.prompt, /AI_WORKMATE_NATURAL_SCHEDULE/);
  assert.equal(parseNaturalScheduleRequest("평일 오전 9시에 일정 확인하라고 알려줘", now).weekdaysOnly, true);
  assert.equal(parseNaturalScheduleRequest("내일 오후 3시에 부모님께 전화하라고 알려줘", now).intervalMs, null);
  assert.equal(parseNaturalScheduleRequest("매주 월요일 오전 8시에 이번 주 목표 알려줘", now).intervalMs, 7 * 86400000);
  assert.equal(parseNaturalScheduleRequest("AI 뉴스 알려줘", now), null);
});

test("ScheduleStore persists, lists, and removes schedules", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "schedule-store-"));
  const statePath = path.join(tempDir, "schedules.json");

  const store = new ScheduleStore(statePath);
  const entry = await store.add({
    chatId: "1",
    userId: "2",
    workspaceAlias: "default",
    prompt: "run report",
    nextRunAt: "2026-06-19T00:10:00.000Z",
    intervalMs: null,
  });

  const reloaded = new ScheduleStore(statePath);
  await reloaded.load();
  assert.equal(reloaded.list("1")[0].id, entry.id);
  assert.equal(reloaded.due(new Date("2026-06-19T00:10:01.000Z"))[0].id, entry.id);
  assert.equal((await reloaded.remove({ chatId: "1", id: entry.id }))?.prompt, "run report");
  assert.deepEqual(reloaded.list("1"), []);
});

test("ScheduleStore advances recurring schedules and removes one-time schedules when started", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "schedule-store-"));
  const statePath = path.join(tempDir, "schedules.json");
  const store = new ScheduleStore(statePath);

  const once = await store.add({
    chatId: "1",
    userId: "2",
    workspaceAlias: "default",
    prompt: "once",
    nextRunAt: "2026-06-19T00:00:00.000Z",
  });
  const recurring = await store.add({
    chatId: "1",
    userId: "2",
    workspaceAlias: "default",
    prompt: "again",
    nextRunAt: "2026-06-19T00:00:00.000Z",
    intervalMs: 60000,
  });

  assert.equal(await store.markStarted(once.id, new Date("2026-06-19T00:00:00.000Z")), null);
  assert.equal(
    (await store.markStarted(recurring.id, new Date("2026-06-19T00:00:00.000Z"))).nextRunAt,
    "2026-06-19T00:01:00.000Z",
  );
  assert.equal(store.list("1").length, 1);
});

test("ScheduleStore records recurring failures and disables after the limit", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "schedule-store-"));
  const statePath = path.join(tempDir, "schedules.json");
  const store = new ScheduleStore(statePath);
  const entry = await store.add({
    chatId: "1",
    userId: "2",
    workspaceAlias: "default",
    prompt: "again",
    nextRunAt: "2026-06-19T00:00:00.000Z",
    intervalMs: 60000,
  });

  const first = await store.recordFailure(entry.id, "failed", {
    maxFailures: 2,
    retryDelayMs: 60000,
  });
  assert.equal(first.failureCount, 1);
  assert.equal(first.lastError, "failed");

  const second = await store.recordFailure(entry.id, "failed again", {
    maxFailures: 2,
    retryDelayMs: 60000,
  });
  assert.equal(second.disabled, true);
  assert.equal(store.list("1").length, 0);
});
