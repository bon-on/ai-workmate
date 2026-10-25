import test from "node:test";
import assert from "node:assert/strict";
import {
  BOT_COMMANDS, PendingDelegates, buildHelpText, formatScheduleList, handleCallbackQuery, handleMessage,
  notifyJobResult, parseQuickCapture,
} from "../src/router.js";
import { buildAcceptedMessage, buildBusyMessage, buildCompletionMessage, formatJobStatus } from "../src/format.js";

const config = { allowedChatIds: ["100"], allowedUserIds: ["200"], denyMode: "reply" };
const workspace = { alias: "default", path: "/workspace/default" };
const workspaces = { getActiveWorkspace: () => workspace, getWorkspaceByAlias: (alias) => (alias === "default" ? workspace : null) };

function recorder() {
  const sent = [];
  const telegram = {
    async sendMessage(chatId, text, extra = {}) { sent.push({ chatId, text, extra }); return { message_id: 500 + sent.length }; },
    async answerCallbackQuery(id, text) { sent.push({ answer: id, text }); },
    async editMessageReplyMarkup(chatId, messageId) { sent.push({ edit: [chatId, messageId] }); },
  };
  return { sent, telegram };
}

function message(text, extra = {}) {
  return { message_id: 9, chat: { id: 100 }, from: { id: 200 }, text, ...extra };
}

function callback(data, { userId = 200, chatId = 100 } = {}) {
  return { id: "cb-1", data, from: { id: userId }, message: { message_id: 77, chat: { id: chatId } } };
}

// T1
test("result footer replaces the Job/Session/Mode/Workspace header", () => {
  const done = buildCompletionMessage({
    jobId: "abc123", status: "completed", provider: "claude", sessionId: "s", workspaceAlias: "default", summary: "결과",
    startedAt: "2026-10-25T00:00:00Z", finishedAt: "2026-10-25T00:02:10Z",
  });
  assert.equal(done, "결과\n\n✅ Claude · 2분 · /job abc123");
  const failed = buildCompletionMessage({
    jobId: "f1", status: "failed", provider: "codex", workspaceAlias: "lab", summary: "rate limit reached\n세부 로그",
    resumeFromSessionId: "old",
  });
  assert.match(failed, /\n\n⚠️ 실패 · Codex · rate limit reached · 이어서 · lab · \/job f1$/);
  assert.doesNotMatch(`${done}${failed}`, /Job:|Session:|Mode:|Workspace:/);
});

test("accepted, busy and status texts are Korean", () => {
  assert.equal(buildAcceptedMessage({ jobId: "j1", provider: "claude", workspaceAlias: "default" }), "접수했습니다 · Claude · /job j1");
  assert.match(buildAcceptedMessage({ jobId: "j2", provider: "codex", fallbackReason: "한도", workspaceAlias: "x", resumeFromSessionId: "s" }),
    /^접수했습니다 · Codex · 이전 대화 이어서 · x · \/job j2\nCodex로 대체: 한도$/);
  assert.match(buildBusyMessage({ jobId: "j1", status: "running" }), /^이미 작업이 진행 중입니다 \(\/job j1 · 실행 중\)/);
  assert.match(buildBusyMessage(undefined), /^이미 작업이 진행 중입니다\./);
  assert.equal(formatJobStatus(null), "이 채팅에서 진행 중인 작업이 없습니다.");
  const status = formatJobStatus({ jobId: "j1", status: "running", provider: "claude", startedAt: "2026-10-25T00:00:00Z", workspaceAlias: "default" }, new Date("2026-10-25T00:05:00Z"));
  assert.match(status, /작업: j1 · 실행 중\n엔진: Claude\n시작: .+ \(5분 경과\)/);
});

test("/jobs, /job and /cancel reply in Korean", async () => {
  const { sent, telegram } = recorder();
  const job = { jobId: "j1", kind: "scheduled", status: "completed", provider: "claude", workspaceAlias: "default",
    startedAt: "2026-10-25T00:00:00Z", finishedAt: "2026-10-25T00:01:00Z", prompt: "[AI_WORKMATE_MORNING_BRIEF_V1]\n작성" };
  const jobs = { listJobs: () => [job], getJob: () => job, cancelJob: async () => null, getActiveJob: () => null };
  for (const text of ["/jobs", "/job j1", "/cancel"]) await handleMessage({ message: message(text), config, telegram, jobs, workspaces });
  assert.match(sent[0].text, /j1 · 완료 · 예약 · .+ · 모닝 브리핑/);
  assert.match(sent[1].text, /^작업: j1 · 완료\n종류: 예약 · 엔진: Claude/);
  assert.match(sent[1].text, /\(1분\)/);
  assert.equal(sent[2].text, "중단할 작업이 없습니다.");
});

// T2
test("/schedules lists names, repeat labels, KST next run and cancel commands", async () => {
  const entries = [
    { id: "sch-m", prompt: "[AI_WORKMATE_MORNING_BRIEF_V1]\n아주 긴 원문 프롬프트", intervalMs: 86400000, weekdaysOnly: true, nextRunAt: "2026-10-26T22:30:00Z", workspaceAlias: "default" },
    { id: "sch-r", prompt: "[AI_WORKMATE_REMINDER] 약 먹기", intervalMs: null, nextRunAt: "2026-10-27T03:00:00Z", failureCount: 2, lastError: "Claude 사용 한도\n상세" },
  ];
  const { sent, telegram } = recorder();
  await handleMessage({
    message: message("/schedules"), config, telegram, workspaces, jobs: {},
    schedules: { list: () => entries, getUsagePause: () => ({ until: "2026-10-25T06:00:00Z", reason: "사용 한도" }) },
  });
  const text = sent[0].text;
  assert.match(text, /^예약 2개 \(시각은 KST\)\n⏸ AI 예약 멈춤 · .+까지 · 사용 한도 · 다시 시작: \/resume/);
  assert.match(text, /• 모닝 브리핑 · 평일 07:30\n  다음 10\. 27\. \(화\) 07:30 · 취소 \/unschedule sch-m/);
  assert.match(text, /• 개인 알림 · 약 먹기 · 한 번\n  다음 10\. 27\. \(화\) 12:00 · 취소 \/unschedule sch-r\n  ⚠️ 연속 실패 2회 \(Claude 사용 한도\) · 지금 실행 \/runnow sch-r/);
  assert.doesNotMatch(text, /아주 긴 원문|AI_WORKMATE|T\d\d:\d\d:\d\dZ/);
  assert.doesNotMatch(formatScheduleList(entries.slice(0, 1)), /멈춤/);
});

// T3
test("/help is a short categorized overview and /help <topic> has details", async () => {
  const overview = buildHelpText();
  assert.ok(overview.split("\n").length <= 12, overview);
  assert.match(overview, /→ \/help schedule/);
  assert.match(buildHelpText("schedule"), /\/runnow <id>/);
  assert.equal(buildHelpText("예약"), buildHelpText("schedule"));
  assert.match(buildHelpText("nope"), /'nope' 도움말이 없습니다/);
  const { sent, telegram } = recorder();
  await handleMessage({ message: message("/help inbox"), config, telegram, workspaces, jobs: {} });
  assert.match(sent[0].text, /^도움말 · 인박스·브리핑/);
  await handleMessage({ message: message("/unknowncmd"), config, telegram, workspaces, jobs: {} });
  assert.match(sent[1].text, /^알 수 없는 명령입니다: \/unknowncmd/);
});

test("every routed command is documented in some help topic", () => {
  const all = ["ai", "schedule", "inbox", "ops", "workspace"].map((topic) => buildHelpText(topic)).join("\n");
  const commands = ["/help", "/capabilities", "/admin", "/dashboard", "/ai-workmate:dashboard", "/status", "/jobs", "/job", "/job-logs",
    "/cancel", "/new", "/reset", "/remember", "/preference", "/memories", "/forget", "/schedule", "/schedules", "/unschedule",
    "/runnow", "/skip", "/resume", "/delegate", "/delegates", "/delegate-cancel", "/tools", "/health", "/repos", "/publish-check",
    "/ai-usage", "/english", "/restart", "/inbox", "/done", "/snooze", "/archive", "/watch", "/watches", "/unwatch", "/lab",
    "/creative", "/tr", "/n8n", "/brief", "/morning", "/evening", "/weekly-review", "/ai-trends", "/discover", "/research",
    "/incident", "/file", "/workspaces", "/workspace", "/serve", "/ps", "/logs", "/stop"];
  for (const command of commands) assert.ok(new RegExp(`${command.replace(/[-:]/g, "\\$&")}(?![\\w-])`).test(all) || command === "/help", command);
});

test("BOT_COMMANDS is a valid Telegram command menu mapped to documented commands", async () => {
  assert.ok(BOT_COMMANDS.length > 0 && BOT_COMMANDS.length <= 100);
  const all = ["ai", "schedule", "inbox", "ops", "workspace"].map((topic) => buildHelpText(topic)).join("\n");
  for (const { command, description } of BOT_COMMANDS) {
    assert.match(command, /^[a-z0-9_]{1,32}$/);
    assert.ok(description.length >= 1 && description.length <= 256);
    if (command !== "help") assert.ok(all.includes(`/${command.replace(/_/g, "-")}`), command);
  }
  // Underscore menu names route to the hyphenated commands.
  const { sent, telegram } = recorder();
  await handleMessage({ message: message("/job_logs j1"), config, telegram, workspaces, jobs: { readJobLogTail: async () => "log line" } });
  assert.equal(sent[0].text, "log line");
});

// T4
test("parseQuickCapture maps prefixes to inbox types and trailing dates to dueAt (23:59 KST)", () => {
  const now = new Date("2026-10-25T03:00:00Z"); // 10/25 12:00 KST
  assert.deepEqual(parseQuickCapture("할일: 우유 사기 내일", now), { type: "task", label: "할 일", text: "우유 사기", dueAt: "2026-10-26T14:59:00.000Z" });
  assert.equal(parseQuickCapture("할 일: 보고서 오늘까지", now).dueAt, "2026-10-25T14:59:00.000Z");
  assert.equal(parseQuickCapture("메모: 회의 10/31", now).dueAt, "2026-10-31T14:59:00.000Z");
  assert.equal(parseQuickCapture("아이디어：앱 11월 3일", now).dueAt, "2026-11-03T14:59:00.000Z");
  assert.equal(parseQuickCapture("읽기: 논문 1/5", now).dueAt, "2027-01-05T14:59:00.000Z");
  assert.deepEqual(parseQuickCapture("메모: 2/30", now), { type: "idea", label: "메모", text: "2/30", dueAt: null });
  assert.deepEqual(parseQuickCapture("읽기: https://example.com", now), { type: "read", label: "읽기", text: "https://example.com", dueAt: null });
  assert.equal(parseQuickCapture("오늘 할일: 정리", now), null);
  assert.equal(parseQuickCapture("메모 없이 보내는 요청", now), null);
  // 15:30 UTC is already the next day in KST.
  assert.equal(parseQuickCapture("할일: 운동 오늘", new Date("2026-10-25T15:30:00Z")).dueAt, "2026-10-26T14:59:00.000Z");
});

test("quick capture saves to the inbox without AI, even when it looks like a schedule", async () => {
  const { sent, telegram } = recorder();
  const captured = [];
  const deps = {
    config, telegram, workspaces,
    jobs: { async startJob() { throw new Error("AI must not start"); } },
    schedules: { async add() { throw new Error("must not schedule"); } },
    personalOps: { async addInbox(input) { captured.push(input); return { id: "in-abc123", ...input }; } },
  };
  await handleMessage({ ...deps, message: message("할일: 내일 오후 3시에 전화하라고 알려줘 10월 30일") });
  assert.equal(captured[0].type, "task");
  assert.equal(captured[0].text, "내일 오후 3시에 전화하라고 알려줘");
  assert.match(captured[0].dueAt, /^20\d\d-10-30T14:59:00\.000Z$/);
  assert.equal(captured[0].source, "telegram-quick");
  assert.match(sent[0].text, /^📥 할 일 저장 · in-abc123\n내일 오후 3시에 전화하라고 알려줘\n마감: 10월 30일\n완료: \/done in-abc123/);
  await handleMessage({ ...deps, message: message("메모:") });
  assert.equal(captured.length, 1);
  assert.match(sent[1].text, /^사용법: 메모:/);
});

// T5
function busyJobs(started) {
  return {
    async startJob(input) {
      started.push(input);
      if (input.jobKind === "delegate") return { accepted: true, job: { jobId: "del-9", completion: Promise.resolve({}) } };
      return { accepted: false, job: { jobId: "fg-1", status: "running" } };
    },
  };
}

test("a busy reply offers a background-delegate button that only the same chat and user can use", async () => {
  const { sent, telegram } = recorder();
  const started = [];
  const delegateOffers = new PendingDelegates();
  const deps = { config, telegram, workspaces, jobs: busyJobs(started), sessions: { resolveReply: () => null }, delegateOffers, onJobSettled() {} };
  await handleMessage({ ...deps, message: message("새 기능 설계해줘") });
  assert.match(sent[0].text, /^이미 작업이 진행 중입니다 \(\/job fg-1 · 실행 중\)/);
  const data = sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(data, /^bg:run:[a-f0-9]{10}$/);
  assert.ok(Buffer.byteLength(data) < 64);

  await handleCallbackQuery({ ...deps, callbackQuery: callback(data, { userId: 201 }) });
  assert.equal(sent.at(-1).text, "허용되지 않은 사용자입니다.");
  await handleCallbackQuery({ ...deps, config: { ...config, allowedUserIds: [] }, callbackQuery: callback(data, { userId: 201 }) });
  assert.equal(sent.at(-1).text, "만료되었거나 권한이 없는 요청입니다.");
  assert.equal(started.length, 1);

  await handleCallbackQuery({ ...deps, callbackQuery: callback(data) });
  assert.equal(started[1].prompt, "새 기능 설계해줘");
  assert.equal(started[1].jobKind, "delegate");
  assert.equal(started[1].allowConcurrent, true);
  assert.equal(started[1].unrestricted, false);
  assert.ok(sent.some((row) => row.edit));
  assert.match(sent.at(-1).text, /백그라운드 작업을 시작했습니다 · \/job del-9/);

  await handleCallbackQuery({ ...deps, callbackQuery: callback(data) });
  assert.equal(sent.at(-1).text, "만료되었거나 권한이 없는 요청입니다.");
  assert.equal(started.length, 2);
});

test("dashboard busy replies carry no delegate button", async () => {
  const { sent, telegram } = recorder();
  await handleMessage({
    config, telegram, workspaces, jobs: busyJobs([]), sessions: { resolveReply: () => null }, requestSource: "dashboard",
    message: message("요약해줘"), onJobSettled() {},
  });
  assert.equal(sent[0].extra.reply_markup, undefined);
});

test("PendingDelegates expires entries and stays bounded", () => {
  let now = 0;
  const store = new PendingDelegates({ ttlMs: 1000, max: 2, now: () => now });
  const first = store.add({ chatId: 1, userId: 2, text: "a" });
  now = 1001;
  assert.equal(store.take({ key: first, chatId: 1, userId: 2 }), null);
  const keys = ["a", "b", "c"].map((text) => store.add({ chatId: 1, userId: 2, text }));
  assert.equal(store.entries.size, 2);
  assert.equal(store.take({ key: keys[0], chatId: 1, userId: 2 }), null);
  assert.equal(store.take({ key: keys[1], chatId: 9, userId: 2 }), null);
  assert.equal(store.take({ key: keys[1], chatId: 1, userId: 2 }).text, "b");
});

// T6
test("/resume, /runnow and /skip call the schedule store", async () => {
  const { sent, telegram } = recorder();
  const calls = [];
  let pause = { until: "2026-10-25T06:00:00Z", reason: "사용 한도 초과" };
  const schedules = {
    getUsagePause: () => pause,
    async clearUsagePause() { calls.push("clear"); pause = null; },
    async runNow(id, options) { calls.push(["run", id, options.chatId]); return id === "sch-1" ? { id, prompt: "[AI_WORKMATE_EVENING_BRIEF_V1]" } : null; },
    async skipNext(id, options) { calls.push(["skip", id, options.chatId]); return { id, prompt: "x", nextRunAt: "2026-10-27T00:00:00Z" }; },
  };
  for (const text of ["/resume", "/resume", "/runnow sch-1", "/runnow nope", "/skip sch-2", "/skip"]) {
    await handleMessage({ message: message(text), config, telegram, workspaces, jobs: {}, schedules });
  }
  assert.deepEqual(calls, ["clear", ["run", "sch-1", 100], ["run", "nope", 100], ["skip", "sch-2", 100]]);
  assert.match(sent[0].text, /AI 예약을 다시 시작했습니다\.\n멈춘 이유: 사용 한도 초과/);
  assert.equal(sent[1].text, "AI 예약은 멈춰 있지 않습니다.");
  assert.match(sent[2].text, /^이브닝 브리핑 예약을 곧 실행합니다/);
  assert.equal(sent[3].text, "해당 예약을 찾지 못했습니다: nope");
  assert.match(sent[4].text, /한 번 건너뜁니다\.\n다음 실행: 10\. 27\. \(화\) 09:00/);
  assert.match(sent[5].text, /^사용법: \/skip/);
});

test("inbox callbacks complete or snooze the item and answer the callback", async () => {
  const { sent, telegram } = recorder();
  const updates = [];
  const personalOps = { async updateInbox(input) { updates.push(input); return input.id === "in-gone" ? null : { id: input.id }; } };
  const before = Date.now();
  await handleCallbackQuery({ callbackQuery: callback("inbox:done:in-1"), config, telegram, personalOps });
  await handleCallbackQuery({ callbackQuery: callback("inbox:later:in-2"), config, telegram, personalOps });
  await handleCallbackQuery({ callbackQuery: callback("inbox:done:in-gone"), config, telegram, personalOps });
  await handleCallbackQuery({ callbackQuery: callback("inbox:done:in-1", { chatId: 999 }), config, telegram, personalOps });
  assert.deepEqual(updates[0], { chatId: 100, id: "in-1", status: "done", snoozedUntil: null });
  assert.equal(updates[1].status, "open");
  const snooze = Date.parse(updates[1].snoozedUntil) - before;
  assert.ok(snooze >= 24 * 3600 * 1000 && snooze < 24 * 3600 * 1000 + 5000);
  assert.equal(updates.length, 3, "unauthorized chat does not reach the store");
  assert.deepEqual(sent.filter((row) => row.answer).map((row) => row.text),
    ["완료 처리했습니다.", "24시간 뒤에 다시 보여드릴게요.", "이미 처리했거나 찾을 수 없는 항목입니다.", "허용되지 않은 사용자입니다."]);
  assert.equal(sent.filter((row) => row.edit).length, 2);
});

test("a stale briefing button never reopens an item finished elsewhere", async () => {
  const { sent, telegram } = recorder();
  const updates = [];
  const personalOps = {
    listInbox: () => [{ id: "in-1", status: "done" }],
    async updateInbox(input) { updates.push(input); return { id: input.id }; },
  };
  await handleCallbackQuery({ callbackQuery: callback("inbox:later:in-1"), config, telegram, personalOps });
  assert.equal(updates.length, 0);
  assert.deepEqual(sent.filter((row) => row.answer).map((row) => row.text), ["이미 처리한 항목입니다."]);
});

// T7
test("notifyJobResult puts job.replyMarkup on the last chunk only", async () => {
  const sent = [];
  const telegram = { async sendMessage(chatId, text, extra) { sent.push({ text, extra }); return { message_id: sent.length }; } };
  const replyMarkup = { inline_keyboard: [[{ text: "완료", callback_data: "inbox:done:in-1" }]] };
  const id = await notifyJobResult(telegram, {
    chatId: "100", jobId: "local-1", status: "completed", kind: "scheduled-local", prompt: "[AI_WORKMATE_MORNING_BRIEF_V1]",
    summary: `${"가".repeat(3000)}\n\n${"나".repeat(3000)}`, replyToMessageId: 5, replyMarkup, artifacts: [],
  });
  assert.equal(id, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].extra, { reply_parameters: { message_id: 5 } });
  assert.deepEqual(sent[1].extra, { reply_markup: replyMarkup });
  sent.length = 0;
  await notifyJobResult(telegram, { chatId: "100", jobId: "j", status: "completed", summary: "짧음", replyMarkup, artifacts: [] });
  assert.deepEqual(sent[0].extra, { reply_markup: replyMarkup });
});
