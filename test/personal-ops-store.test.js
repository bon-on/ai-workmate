import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PersonalOpsStore, parseInboxType } from "../src/personal-ops-store.js";

test("PersonalOpsStore captures, snoozes, persists, and completes inbox items", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-ops-"));
  const statePath = path.join(directory, "state.json");
  const store = new PersonalOpsStore(statePath);
  const entry = await store.addInbox({ chatId: 100, type: "task", text: "보증서 정리" });
  assert.equal(store.listInbox(100).length, 1);
  await store.updateInbox({ chatId: 100, id: entry.id, status: "open", snoozedUntil: "2099-01-01T00:00:00.000Z" });
  assert.equal(store.listInbox(100).length, 0);

  const loaded = new PersonalOpsStore(statePath);
  await loaded.load();
  assert.equal(loaded.listInbox(100, { now: new Date("2100-01-01") }).length, 1);
  await loaded.updateInbox({ chatId: 100, id: entry.id, status: "done" });
  assert.equal(loaded.listInbox(100).length, 0);
});

test("PersonalOpsStore tracks watches and Korean inbox aliases", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-ops-"));
  const store = new PersonalOpsStore(path.join(directory, "state.json"));
  const watch = await store.addWatch({ chatId: 100, userId: 200, workspaceAlias: "default", url: "https://example.com/", label: "Example" });
  assert.equal(store.dueWatches().length, 1);
  await store.updateWatch(watch.id, { lastHash: "abc", failureCount: 0 });
  assert.equal(store.summary(100).watches, 1);
  assert.equal(parseInboxType("할일"), "task");
  assert.equal(parseInboxType("unknown"), null);
});

test("PersonalOpsStore persists briefing history and feedback", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-ops-"));
  const statePath = path.join(directory, "state.json");
  const store = new PersonalOpsStore(statePath);
  const briefing = await store.recordBriefing({
    chatId: 100,
    kind: "morning",
    text: "brief",
    recommendations: ["새 도구 시험하기"],
    now: new Date("2026-09-17T08:00:00+09:00"),
  });
  await store.setBriefingFeedback({ chatId: 100, id: briefing.id, feedback: "interest", recommendationIndex: 0 });

  const loaded = new PersonalOpsStore(statePath);
  await loaded.load();
  const [entry] = loaded.listBriefingHistory(100, { now: new Date("2026-09-18T08:00:00+09:00") });
  assert.equal(entry.recommendationFeedback[0], "interest");
  assert.deepEqual(entry.recommendations, ["새 도구 시험하기"]);
});

test("PersonalOpsStore summarizes recent completed and open activity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-ops-activity-"));
  const store = new PersonalOpsStore(path.join(directory, "state.json"));
  const now = new Date("2026-09-28T10:00:00Z");
  const done = await store.addInbox({ chatId: 1, type: "task", text: "완료 작업", now });
  await store.updateInbox({ chatId: 1, id: done.id, status: "done", now });
  await store.addInbox({ chatId: 1, type: "idea", text: "열린 아이디어", now });
  const summary = store.activitySummary(1, { now });
  assert.equal(summary.completed, 1);
  assert.equal(summary.stillOpen, 1);
  assert.equal(summary.completedItems[0].text, "완료 작업");
});

test("PersonalOpsStore persists briefing preferences", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-ops-preference-"));
  const statePath = path.join(directory, "state.json");
  const store = new PersonalOpsStore(statePath);
  const preference = await store.addPreference({ chatId: 1, type: "avoid", text: "평일 장거리 외출" });
  const restored = new PersonalOpsStore(statePath);
  await restored.load();
  assert.equal(restored.listPreferences(1)[0].text, "평일 장거리 외출");
  assert.equal((await restored.removePreference({ chatId: 1, id: preference.id })).id, preference.id);
});

test("PersonalOpsStore persists run metrics and alert cooldowns", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-ops-metrics-"));
  const store = new PersonalOpsStore(path.join(directory, "state.json"));
  await store.recordRunMetric({ jobId: "j1", chatId: 1, kind: "chat", status: "completed", startedAt: "2026-09-28T00:00:00Z", finishedAt: "2026-09-28T00:01:00Z", usage: { inputTokens: 100, outputTokens: 10 } });
  const summary = store.usageSummary(1, { now: new Date("2026-09-28T01:00:00Z") });
  assert.equal(summary.codexJobs, 1);
  assert.equal(summary.inputTokens, 100);
  assert.equal(await store.reserveAlert("disk", { now: new Date("2026-09-28T01:00:00Z") }), true);
  assert.equal(await store.reserveAlert("disk", { now: new Date("2026-09-28T02:00:00Z") }), false);
});

test("PersonalOpsStore keeps AI lab experiments and their results", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-ops-lab-"));
  const statePath = path.join(directory, "state.json");
  const store = new PersonalOpsStore(statePath);
  const experiment = await store.addExperiment({ chatId: 1, topic: "MCP 평가 예제", workspaceAlias: "default" });
  await store.linkExperimentSchedule({ chatId: 1, id: experiment.id, scheduleId: "schedule-1" });
  await store.recordExperimentResult({ chatId: 1, id: experiment.id, job: { jobId: "job-1", status: "completed", summary: "검증 완료", artifacts: [{ path: "/tmp/report.md" }] } });

  const restored = new PersonalOpsStore(statePath);
  await restored.load();
  const [row] = restored.listExperiments(1);
  assert.equal(row.status, "completed");
  assert.equal(row.result, "검증 완료");
  assert.deepEqual(row.artifacts, ["/tmp/report.md"]);
  assert.equal(restored.summary(1).readyExperiments, 1);
  await restored.markExperimentRead({ chatId: 1, id: row.id });
  assert.equal(restored.summary(1).readyExperiments, 0);
  assert.equal(restored.listExperiments(1).length, 1);
  const child = await restored.addExperiment({ chatId: 1, topic: "실습", workspaceAlias: "default", parentId: row.id, followupKind: "practice" });
  assert.equal(child.parentId, row.id);
  assert.equal(await restored.markExperimentRead({ chatId: 2, id: row.id }), null);
  await restored.setExperimentStatus({ chatId: 1, id: row.id, status: "archived" });
  assert.equal(restored.listExperiments(1).length, 1);
  assert.equal(restored.listExperiments(1, { includeArchived: true }).length, 2);
});
