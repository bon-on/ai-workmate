import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMessage, isAuthorized, parseNaturalPreference } from "../src/router.js";

test("lab implementation follow-up links to the source and schedules only the selected task", async () => {
  let child, scheduled;
  await handleMessage({
    message: { chat: { id: 100 }, from: { id: 200 }, text: "/lab implement lab-parent 선택한 기능 구현" },
    config: { allowedChatIds: ["100"], allowedUserIds: ["200"] },
    telegram: { async sendMessage() {} },
    workspaces: { getWorkspaceByAlias: alias => ({ alias, path: "/tmp" }) },
    personalOps: {
      listExperiments: () => [{ id: "lab-parent", workspaceAlias: "original", topic: "원본", result: "참고 보고서", status: "completed" }],
      async addExperiment(input) { child = input; return { id: "lab-child", ...input }; },
      async linkExperimentSchedule() {},
    },
    schedules: { async add(input) { scheduled = input; return { id: "schedule-child" }; } },
  });
  assert.equal(child.parentId, "lab-parent");
  assert.equal(child.followupKind, "implement");
  assert.equal(scheduled.workspaceAlias, "original");
  assert.match(scheduled.prompt, /선택한 기능 구현/);
  assert.match(scheduled.prompt, /참고 보고서/);
  assert.match(scheduled.prompt, /서비스 재시작, 외부 변경은 하지 마세요/);
});

test("authorization requires matching chat and user when both are configured", () => {
  const config = {
    allowedChatIds: ["100"],
    allowedUserIds: ["200"],
  };

  assert.equal(
    isAuthorized(
      {
        chat: { id: 100 },
        from: { id: 200 },
      },
      config,
    ),
    true,
  );

  assert.equal(
    isAuthorized(
      {
        chat: { id: 999 },
        from: { id: 200 },
      },
      config,
    ),
    false,
  );
});

test("natural recommendation feedback is classified conservatively", () => {
  assert.deepEqual(parseNaturalPreference("평일 장거리 외출 추천은 앞으로 하지 마"), { type: "avoid", text: "평일 장거리 외출 추천은 앞으로 하지 마" });
  assert.deepEqual(parseNaturalPreference("어제 개발 도구 추천은 좋았어"), { type: "like", text: "어제 개발 도구 추천은 좋았어" });
  assert.equal(parseNaturalPreference("오늘은 뭘 추천해줄래?"), null);
  assert.equal(parseNaturalPreference("좋아하는 영화 추천해줘"), null);
  assert.equal(parseNaturalPreference("볼만한 거 추천해줘 별로인 건 빼고"), null);
  assert.equal(parseNaturalPreference("주말 나들이 추천 별로였어").type, "avoid");
  assert.equal(parseNaturalPreference("그 산책 추천 마음에 들었어").type, "like");
});

test("handleMessage routes personal inbox commands", async () => {
  const sent = [];
  const captured = [];
  await handleMessage({
    message: { message_id: 1, chat: { id: 100 }, from: { id: 200 }, text: "/inbox add task 외장 SSD 백업 확인" },
    config: { allowedChatIds: ["100"], allowedUserIds: ["200"], denyMode: "reply" },
    telegram: { async sendMessage(_chatId, text) { sent.push(text); } },
    jobs: {}, processes: {}, sessions: {}, schedules: {},
    workspaces: { getActiveWorkspace() { return { alias: "default", path: "/workspace" }; } },
    personalOps: {
      async addInbox(input) { captured.push(input); return { id: "in-123", ...input }; },
      listInbox() { return []; },
    },
    onJobSettled() {},
  });
  assert.equal(captured[0].type, "task");
  assert.equal(captured[0].text, "외장 SSD 백업 확인");
  assert.match(sent[0], /Captured in-123/);
});

test("standalone Telegram URLs are captured without starting Codex", async () => {
  const captured = [];
  let started = false;
  const sent = [];
  await handleMessage({
    message: { message_id: 2, chat: { id: 100 }, from: { id: 200 }, text: "https://example.com/article" },
    config: { allowedChatIds: ["100"], allowedUserIds: ["200"], denyMode: "reply" },
    telegram: { async sendMessage(_chatId, text) { sent.push(text); } },
    jobs: { async startJob() { started = true; } }, processes: {}, sessions: {}, schedules: {}, workspaces: {},
    personalOps: { async addInbox(input) { captured.push(input); return { id: "in-url", ...input }; } },
    onJobSettled() {},
  });
  assert.equal(started, false);
  assert.equal(captured[0].type, "read");
  assert.equal(captured[0].source, "telegram-share");
  assert.match(sent[0], /읽기 목록/);
});

test("natural Korean scheduling creates a recurring AI schedule", async () => {
  const added = [];
  const sent = [];
  await handleMessage({
    message: { message_id: 4, chat: { id: 100 }, from: { id: 200 }, text: "매일 오후 2시에 AI 뉴스 스크랩해서 알려줘" },
    config: { allowedChatIds: ["100"], allowedUserIds: ["200"], denyMode: "reply" },
    telegram: { async sendMessage(_chatId, text) { sent.push(text); } },
    jobs: {}, processes: {}, sessions: {},
    workspaces: { getActiveWorkspace() { return { alias: "default", path: "/workspace" }; } },
    schedules: { async add(input) { added.push(input); return { id: "natural-1", ...input }; } },
    onJobSettled() {},
  });
  assert.equal(added[0].intervalMs, 86400000);
  assert.match(added[0].prompt, /AI_WORKMATE_NATURAL_SCHEDULE/);
  assert.match(sent[0], /AI 작업/);
  assert.match(sent[0], /취소: \/unschedule natural-1/);
});

for (const action of ["now", "tonight"]) test(`lab ${action} creates a persistent experiment linked to its schedule`, async () => {
  const calls = [];
  const before = Date.now();
  await handleMessage({
    message: { message_id: 3, chat: { id: 100 }, from: { id: 200 }, text: `/lab ${action} MCP 평가 예제` },
    config: { allowedChatIds: ["100"], allowedUserIds: ["200"], denyMode: "reply" },
    telegram: { async sendMessage(_chatId, text) { calls.push(["send", text]); } },
    jobs: {}, processes: {}, sessions: {},
    workspaces: { getActiveWorkspace() { return { alias: "default", path: "/workspace" }; } },
    schedules: { async add(input) { calls.push(["schedule", input]); return { id: "sc-1", nextRunAt: input.nextRunAt }; } },
    personalOps: {
      async addExperiment(input) { calls.push(["experiment", input]); return { id: "lab-abc123", ...input }; },
      async linkExperimentSchedule(input) { calls.push(["link", input]); },
    },
    onJobSettled() {},
  });
  assert.equal(calls[0][0], "experiment");
  assert.equal(calls[1][1].intervalMs, null);
  const due = new Date(calls[1][1].nextRunAt);
  if (action === "now") {
    assert.ok(due.getTime() >= before && due.getTime() <= Date.now());
    assert.match(calls[3][1], /바로 시작/);
  } else assert.equal(due.getHours(), 23);
  assert.match(calls[1][1].prompt, /\[AI_WORKMATE_LAB:lab-abc123\]/);
  assert.deepEqual(calls[2], ["link", { chatId: 100, id: "lab-abc123", scheduleId: "sc-1" }]);
});

test("handleMessage starts a new session for plain text messages", async () => {
  const started = [];
  const sent = [];

  await handleMessage({
    message: {
      message_id: 50,
      chat: { id: 100 },
      from: { id: 200 },
      text: "fix the bug",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
        return { message_id: 999 };
      },
    },
    jobs: {
      async startJob(input) {
        started.push(input);
        return {
          accepted: true,
          job: {
            jobId: "abc123",
            sessionId: null,
            resumeFromSessionId: null,
            workspaceAlias: input.workspace.alias,
            status: "queued",
            completion: Promise.resolve({}),
          },
        };
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
      getWorkspaceByAlias() {
        return null;
      },
    },
    processes: {},
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat() {},
    },
    onJobSettled() {},
  });

  assert.equal(started.length, 1);
  assert.equal(started[0].resumeSession, null);
  assert.equal(started[0].workspace.alias, "default");
  assert.equal(started[0].unrestricted, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /Mode: new/);
});

test("dashboard requests keep bridge safety restrictions", async () => {
  const started = [];
  const sent = [];

  await handleMessage({
    requestSource: "dashboard",
    message: {
      message_id: 52,
      chat: { id: 100 },
      from: { id: 200 },
      text: "sudo reboot",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
      },
    },
    jobs: {
      async startJob(input) {
        started.push(input);
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
    },
    sessions: { resolveReply() { return null; } },
  });

  assert.equal(started.length, 0);
  assert.match(sent[0][1], /Blocked for safety/);
});

test("handleMessage resumes the saved session for reply messages", async () => {
  const started = [];

  await handleMessage({
    message: {
      message_id: 51,
      chat: { id: 100 },
      from: { id: 200 },
      text: "keep going",
      reply_to_message: {
        message_id: 700,
      },
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage() {
        return { message_id: 998 };
      },
    },
    jobs: {
      async startJob(input) {
        started.push(input);
        return {
          accepted: true,
          job: {
            jobId: "abc124",
            sessionId: "sess-1",
            resumeFromSessionId: "sess-1",
            workspaceAlias: input.workspace.alias,
            status: "queued",
            completion: Promise.resolve({}),
          },
        };
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
      getWorkspaceByAlias(alias) {
        return { alias, path: `/workspace/${alias}` };
      },
    },
    processes: {},
    sessions: {
      resolveReply(chatId, messageId) {
        assert.equal(chatId, 100);
        assert.equal(messageId, 700);
        return {
          sessionId: "sess-1",
          workspaceAlias: "saved",
          jobId: "abc000",
          createdAt: "2026-04-16T00:00:00.000Z",
        };
      },
      async clearChat() {},
    },
    onJobSettled() {},
  });

  assert.equal(started.length, 1);
  assert.equal(started[0].resumeSession.sessionId, "sess-1");
  assert.equal(started[0].workspace.alias, "saved");
  assert.equal(started[0].replyToMessageId, 51);
});

test("handleMessage clears saved sessions on /new", async () => {
  const calls = [];

  await handleMessage({
    message: {
      message_id: 52,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/new",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        calls.push([chatId, text]);
        return { message_id: 997 };
      },
    },
    jobs: {
      async startJob() {
        throw new Error("should not start a job");
      },
      async cancelJob() {
        return null;
      },
      getActiveJob() {
        return null;
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
      listWorkspaces() {
        return [];
      },
      setActiveWorkspace() {
        return null;
      },
    },
    processes: {
      list() {
        return [];
      },
      stop() {
        return null;
      },
    },
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat(chatId) {
        calls.push(["clear", chatId]);
      },
    },
    onJobSettled() {},
  });

  assert.deepEqual(calls[0], ["clear", 100]);
  assert.match(calls[1][1], /starts a new session/i);
});

test("handleMessage saves and lists workspace memories", async () => {
  const sent = [];
  const stored = [];

  const base = {
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
        return { message_id: 996 };
      },
    },
    jobs: {
      async startJob() {
        throw new Error("should not start a job");
      },
      async cancelJob() {
        return null;
      },
      getActiveJob() {
        return null;
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
      listWorkspaces() {
        return [];
      },
      setActiveWorkspace() {
        return null;
      },
    },
    processes: {
      list() {
        return [];
      },
      stop() {
        return null;
      },
    },
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat() {},
    },
    memories: {
      async add(input) {
        stored.push(input);
        return { id: "mem-1", ...input, createdAt: "2026-06-19T00:00:00.000Z" };
      },
      list() {
        return [{ id: "mem-1", text: "항상 한국어로 짧게 답변" }];
      },
    },
    onJobSettled() {},
  };

  await handleMessage({
    ...base,
    message: {
      message_id: 53,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/remember 항상 한국어로 짧게 답변",
    },
  });

  await handleMessage({
    ...base,
    message: {
      message_id: 54,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/memories",
    },
  });

  assert.equal(stored[0].workspaceAlias, "default");
  assert.equal(stored[0].text, "항상 한국어로 짧게 답변");
  assert.match(sent[0][1], /Remembered mem-1/);
  assert.match(sent[1][1], /mem-1 \| 항상 한국어로 짧게 답변/);
});

test("handleMessage injects workspace memories into jobs", async () => {
  const started = [];

  await handleMessage({
    message: {
      message_id: 55,
      chat: { id: 100 },
      from: { id: 200 },
      text: "작업 이어서 해줘",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage() {
        return { message_id: 995 };
      },
    },
    jobs: {
      async startJob(input) {
        started.push(input);
        return {
          accepted: true,
          job: {
            jobId: "abc125",
            sessionId: null,
            resumeFromSessionId: null,
            workspaceAlias: input.workspace.alias,
            status: "queued",
            completion: Promise.resolve({}),
          },
        };
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
      getWorkspaceByAlias() {
        return null;
      },
    },
    processes: {},
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat() {},
    },
    memories: {
      listForPrompt(input) {
        assert.equal(input.workspaceAlias, "default");
        return [{ id: "mem-1", text: "프로젝트는 Telegram-first agent다" }];
      },
    },
    onJobSettled() {},
  });

  assert.deepEqual(started[0].memories, [
    { id: "mem-1", text: "프로젝트는 Telegram-first agent다" },
  ]);
});

test("handleMessage creates and lists scheduled jobs", async () => {
  const sent = [];
  const added = [];

  const base = {
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
        return { message_id: 994 };
      },
    },
    jobs: {
      async startJob() {
        throw new Error("should not start a job");
      },
      async cancelJob() {
        return null;
      },
      getActiveJob() {
        return null;
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
      listWorkspaces() {
        return [];
      },
      setActiveWorkspace() {
        return null;
      },
    },
    processes: {
      list() {
        return [];
      },
      stop() {
        return null;
      },
    },
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat() {},
    },
    memories: {},
    schedules: {
      async add(input) {
        added.push(input);
        return {
          id: "sch-1",
          ...input,
          nextRunAt: input.nextRunAt,
          createdAt: "2026-06-19T00:00:00.000Z",
        };
      },
      list() {
        return [
          {
            id: "sch-1",
            workspaceAlias: "default",
            nextRunAt: "2026-06-19T00:10:00.000Z",
            intervalMs: null,
            prompt: "상태 요약",
          },
        ];
      },
    },
    onJobSettled() {},
  };

  await handleMessage({
    ...base,
    message: {
      message_id: 56,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/schedule in 10m 상태 요약",
    },
  });

  await handleMessage({
    ...base,
    message: {
      message_id: 57,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/schedules",
    },
  });

  assert.equal(added[0].workspaceAlias, "default");
  assert.equal(added[0].prompt, "상태 요약");
  assert.match(sent[0][1], /Scheduled sch-1/);
  assert.match(sent[1][1], /sch-1 \| default/);
});

test("handleMessage shows tools and process logs", async () => {
  const sent = [];

  const base = {
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
        return { message_id: 993 };
      },
    },
    jobs: {
      async startJob() {
        throw new Error("should not start a job");
      },
      async cancelJob() {
        return null;
      },
      getActiveJob() {
        return null;
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
      listWorkspaces() {
        return [];
      },
      setActiveWorkspace() {
        return null;
      },
    },
    processes: {
      list() {
        return [];
      },
      stop() {
        return null;
      },
      async readLogTail(chatId, processId) {
        assert.equal(chatId, 100);
        assert.equal(processId, "proc-1");
        return "[stdout] ready";
      },
    },
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat() {},
    },
    memories: {},
    schedules: {},
    onJobSettled() {},
  };

  await handleMessage({
    ...base,
    message: {
      message_id: 58,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/tools",
    },
  });

  await handleMessage({
    ...base,
    message: {
      message_id: 59,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/logs proc-1",
    },
  });

  assert.match(sent[0][1], /schedule \| Scheduled jobs/);
  assert.match(sent[0][1], /delegate \| Delegated jobs/);
  assert.equal(sent[1][1], "[stdout] ready");
});

test("handleMessage shows dashboard with pool and current work", async () => {
  const sent = [];

  await handleMessage({
    message: {
      message_id: 63,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/ai-workmate:dashboard",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
        return { message_id: 989 };
      },
    },
    jobs: {
      config: {
        maxDelegateJobsTotal: 3,
        maxDelegateJobsPerChat: 2,
      },
      getActiveJob() {
        return {
          jobId: "job-1",
          kind: "chat",
          status: "running",
          workspaceAlias: "default",
          startedAt: "2026-07-08T01:00:00.000Z",
          prompt: "대시보드 구현",
        };
      },
      listJobs() {
        return [
          {
            jobId: "job-1",
            kind: "chat",
            status: "running",
            workspaceAlias: "default",
            startedAt: "2026-07-08T01:00:00.000Z",
            prompt: "대시보드 구현",
          },
          {
            jobId: "del-1",
            kind: "delegate",
            status: "queued",
            workspaceAlias: "default",
            startedAt: "2026-07-08T01:01:00.000Z",
            prompt: "pool 상태 확인",
          },
        ];
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
    },
    processes: {
      list() {
        return [
          {
            processId: "proc-1",
            status: "running",
            workspaceAlias: "default",
            pid: 123,
            startedAt: "2026-07-08T01:02:00.000Z",
            command: "npm run dev",
          },
        ];
      },
    },
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat() {},
    },
    memories: {},
    schedules: {
      list() {
        return [
          {
            id: "sch-1",
            workspaceAlias: "default",
            nextRunAt: "2026-07-08T02:00:00.000Z",
            intervalMs: 3600000,
            prompt: "상태 점검",
          },
        ];
      },
    },
    onJobSettled() {},
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /AI Workmate Dashboard/);
  assert.match(sent[0][1], /Foreground slot: busy \(job-1, running\)/);
  assert.match(sent[0][1], /Delegate pool: 1 running, total limit 3, chat limit 2/);
  assert.match(sent[0][1], /proc-1 \| running/);
  assert.match(sent[0][1], /sch-1 \| default/);
});

test("handleMessage starts and lists delegated jobs", async () => {
  const sent = [];
  const started = [];

  const completion = Promise.resolve({ jobId: "del-1" });
  await handleMessage({
    message: {
      message_id: 60,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/delegate 프로젝트 상태 요약",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
        return { message_id: 992 };
      },
    },
    jobs: {
      async startJob(input) {
        started.push(input);
        return {
          accepted: true,
          job: {
            jobId: "del-1",
            workspaceAlias: input.workspace.alias,
            status: "queued",
            completion,
          },
        };
      },
      listJobs() {
        return [
          {
            jobId: "del-1",
            status: "running",
            workspaceAlias: "default",
            startedAt: "2026-06-19T00:00:00.000Z",
            prompt: "프로젝트 상태 요약",
          },
        ];
      },
      async cancelJobById() {
        return null;
      },
      getActiveJob() {
        return null;
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "default", path: "/workspace/default" };
      },
      getWorkspaceByAlias() {
        return null;
      },
    },
    processes: {},
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat() {},
    },
    memories: {
      listForPrompt() {
        return [{ id: "mem-1", text: "memory" }];
      },
    },
    schedules: {},
    onJobSettled() {},
  });

  assert.equal(started[0].allowConcurrent, true);
  assert.equal(started[0].jobKind, "delegate");
  assert.deepEqual(started[0].memories, [{ id: "mem-1", text: "memory" }]);
  assert.match(sent[0][1], /Delegated job started/);

  await handleMessage({
    message: {
      message_id: 61,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/delegates",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
        return { message_id: 991 };
      },
    },
    jobs: {
      listJobs() {
        return [
          {
            jobId: "del-1",
            status: "running",
            workspaceAlias: "default",
            startedAt: "2026-06-19T00:00:00.000Z",
            prompt: "프로젝트 상태 요약",
          },
        ];
      },
      getActiveJob() {
        return null;
      },
    },
    workspaces: {},
    processes: {},
    sessions: {},
    memories: {},
    schedules: {},
    onJobSettled() {},
  });

  assert.match(sent[1][1], /del-1 \| running \| default/);
});

test("handleMessage cancels delegated jobs by id", async () => {
  const calls = [];

  await handleMessage({
    message: {
      message_id: 62,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/delegate-cancel del-1",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
    },
    telegram: {
      async sendMessage(chatId, text) {
        calls.push(["send", chatId, text]);
        return { message_id: 990 };
      },
    },
    jobs: {
      async cancelJobById(chatId, jobId, options) {
        calls.push(["cancel", chatId, jobId, options]);
        return { jobId };
      },
      getActiveJob() {
        return null;
      },
    },
    workspaces: {},
    processes: {},
    sessions: {},
    memories: {},
    schedules: {},
    onJobSettled() {},
  });

  assert.deepEqual(calls[0], ["cancel", 100, "del-1", { kind: "delegate" }]);
  assert.match(calls[1][2], /Cancellation requested/);
});


test("handleMessage executes trading shortcut commands", async (t) => {
  // Use a fake trading CLI: the real one reads live config, credentials and the ledger.
  const tradingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trading-fixture-"));
  t.after(() => fs.rm(tradingRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tradingRoot, ".venv/bin"), { recursive: true });
  await fs.writeFile(path.join(tradingRoot, ".venv/bin/trading"), '#!/bin/sh\necho "보유 종목 없음 (args: $*)"\n', { mode: 0o755 });
  const sent = [];

  await handleMessage({
    message: {
      message_id: 88,
      chat: { id: 100 },
      from: { id: 200 },
      text: "/tr 보유",
    },
    config: {
      allowedChatIds: ["100"],
      allowedUserIds: ["200"],
      denyMode: "reply",
      tradingWorkspacePath: tradingRoot,
    },
    telegram: {
      async sendMessage(chatId, text) {
        sent.push([chatId, text]);
        return { message_id: 999 };
      },
    },
    jobs: {
      async startJob() {
        throw new Error("should not start codex job");
      },
    },
    workspaces: {
      getActiveWorkspace() {
        return { alias: "trading", path: tradingRoot };
      },
    },
    processes: {},
    sessions: {
      resolveReply() {
        return null;
      },
      async clearChat() {},
    },
    onJobSettled() {},
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], "보유 종목 없음 (args: telegram 보유)");
});
