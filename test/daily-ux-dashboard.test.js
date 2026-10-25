import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildDashboardSnapshot } from "../src/dashboard.js";
import {
  compactRepoChecksWithAge, createJobResultStore, executeDashboardCommand, findJobResult, handleBriefingResend,
  isTailnetUserAllowed, renderDashboardHtml, startDashboardServer, startRepoRecheck,
} from "../src/dashboard-server.js";

const config = { allowedChatIds: ["100"], allowedUserIds: ["200"] };
const workspaces = { getActiveWorkspace: () => ({ alias: "default", path: "/tmp" }), getWorkspaceByAlias: () => ({ alias: "default", path: "/tmp" }) };
const script = renderDashboardHtml(config).match(/<script>([\s\S]*?)<\/script>/)[1];
const escapeSource = script.match(/    function escapeText\(value\) \{[\s\S]*?\n    \}\n/)[0];
const pick = (start, end) => {
  const from = script.indexOf(start);
  const to = script.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} .. ${end}`);
  return script.slice(from, to);
};
const statusSource = pick("    function badge(", "    function escapeText(") + pick("    function statusLabel(", "    function updateJobOutput(");

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "daily-ux-dashboard-"));
}

function postJson(port, target, body, { host = `127.0.0.1:${port}`, origin = `http://${host}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: target,
      headers: { host, origin, "content-type": "application/json", ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function getJson(port, target) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: target, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }).on("error", reject);
  });
}

async function withServer(deps, fn) {
  const dir = await tempDir();
  const server = startDashboardServer({
    jobs: {}, telegram: {}, workspaces,
    jobResults: createJobResultStore(path.join(dir, "results.json")),
    ...deps,
    config: { ...config, dashboardEnabled: true, dashboardPort: 0, dashboardHost: "127.0.0.1", ...deps.config },
  });
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await fn(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("D1: a dashboard request settles through the bridge settler, honors the Telegram opt-out and keeps the full result", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "results.json");
  const jobResults = createJobResultStore(file);
  const settled = [];
  const longSummary = `결과 ${"가".repeat(900)} 끝`;
  const job = { jobId: "job-d1", chatId: "100", status: "completed", summary: longSummary, prompt: "긴 조사", kind: "chat", provider: "claude", finishedAt: "2026-10-25T01:00:00Z" };
  let finish;
  const completion = new Promise((resolve) => { finish = resolve; });
  const jobs = { getActiveJob: () => null, async startJob() { return { accepted: true, job: { ...job, completion } }; } };
  const result = await executeDashboardCommand({
    command: "/ask 긴 조사를 해줘", config, telegram: { async sendMessage() { return {}; } }, jobs, workspaces,
    deliverToTelegram: false, jobResults,
    onJobSettled: async (settledJob) => { settled.push({ id: settledJob.jobId, deliver: settledJob.deliverToTelegram }); },
  });
  assert.equal(result.ok, true);
  finish(job);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(settled, [{ id: "job-d1", deliver: false }]);

  // A fresh store simulates a bridge restart: the full, untruncated result is still there.
  const reloaded = createJobResultStore(file);
  await reloaded.load();
  assert.equal(reloaded.get("job-d1").summary, longSummary);
  assert.equal(findJobResult("job-d1", { config, jobs: {}, jobResults: reloaded }).summary, longSummary);
  assert.equal(findJobResult("../etc", { config, jobs: {}, jobResults: reloaded }), null);
  assert.equal(findJobResult("job-d1", { config: { allowedChatIds: ["999"] }, jobs: {}, jobResults: reloaded }), null);

  const snapshot = buildDashboardSnapshot({
    chatId: "100", jobs: { listJobs: () => [], getActiveJob: () => null }, processes: { list: () => [] }, schedules: { list: () => [] }, workspaces,
    personalOps: { listRecentRuns: () => [{ id: "job-d1", kind: "chat", status: "completed", finishedAt: job.finishedAt, source: "claude" }] },
    jobResults: reloaded,
  });
  assert.equal(snapshot.recentJobs[0].hasResult, true);
  assert.equal(snapshot.recentJobs[0].summaryTruncated, true);
  assert.equal(snapshot.recentJobs[0].summary.length, 500);
});

test("D1: Telegram delivery stays on by default and the result endpoint serves it", async () => {
  const settled = [];
  const job = { jobId: "job-on", chatId: "100", status: "completed", summary: "짧은 결과", prompt: "p", kind: "chat" };
  const jobs = {
    getActiveJob: () => null,
    getJob: (chatId, id) => (chatId === "100" && id === "job-on" ? job : null),
    async startJob() { return { accepted: true, job: { ...job, completion: Promise.resolve(job) } }; },
  };
  await withServer({ jobs, onJobSettled: async (settledJob) => settled.push(settledJob.deliverToTelegram) }, async (port) => {
    const response = await postJson(port, "/api/command", { command: "/ask 짧게 답해줘" });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(settled, [undefined]);
    const result = await getJson(port, "/api/job-result?id=job-on");
    assert.equal(result.status, 200);
    assert.equal(result.body.job.summary, "짧은 결과");
    assert.equal((await getJson(port, "/api/job-result?id=missing")).status, 404);
  });
});

test("D1: emitted ask form sends the Telegram checkbox and long results open a full view", async () => {
  const html = renderDashboardHtml(config);
  assert.match(html, /<input id="askTelegram" type="checkbox" checked> 텔레그램으로도 받기/);
  const block = pick('    document.getElementById("askForm").addEventListener', '    document.getElementById("newResearch")');
  const nodes = { askInput: { value: "질문" }, askSubmit: { disabled: false }, askResearch: { checked: false }, askTelegram: { checked: false }, askOutput: {}, askForm: { addEventListener: (event, fn) => { nodes.submit = fn; } } };
  const calls = [];
  const context = vm.createContext({ document: { getElementById: (id) => nodes[id] }, runDashboardCommand: async (...args) => calls.push(args), loadDashboard: async () => {} });
  vm.runInContext(block, context);
  await nodes.submit({ preventDefault() {} });
  assert.equal(calls[0][0], "/ask 질문");
  assert.deepEqual({ ...calls[0][2] }, { deliverToTelegram: false });

  const fn = pick("    async function runDashboardCommand(", "    async function postAction(");
  const bodies = [];
  const runContext = vm.createContext({ fetch: async (url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, messages: [], jobId: "j" }) }; } });
  vm.runInContext(fn, runContext);
  await runContext.runDashboardCommand("/ask x", { dataset: {} }, { deliverToTelegram: false });
  await runContext.runDashboardCommand("/status", { dataset: {} });
  assert.deepEqual(bodies, [{ command: "/ask x", deliverToTelegram: false }, { command: "/status" }]);

  const update = vm.createContext({ renderDocumentLinks: () => "", documentsForText: () => [] });
  vm.runInContext(pick("    function updateJobOutput(", "    function renderServices(") + statusSource + escapeSource, update);
  const output = { dataset: { jobId: "j" }, html: "", insertAdjacentHTML(_where, value) { this.html += value; } };
  update.updateJobOutput(output, { activeJob: null, runningDelegates: [], recentJobs: [{ jobId: "j", status: "completed", summary: "s...", summaryTruncated: true }] });
  assert.match(output.textContent, /^j · 완료/);
  assert.match(output.html, /data-job-result="j">전체 결과 보기/);
});

test("D2: Today status line shows the usage pause and failing schedules with actions", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const schedules = {
    list: () => [
      { id: "s1", prompt: "[AI_WORKMATE_MORNING_BRIEF_V1] ...", intervalMs: 86400000, nextRunAt: "2026-10-25T22:00:00Z", failureCount: 2, lastError: "Claude 사용 한도 도달\n상세 로그", weekdaysOnly: true },
      { id: "s2", prompt: "[CUSTOM] 확인", intervalMs: 0, nextRunAt: "2026-10-26T00:00:00Z" },
    ],
    getUsagePause: () => ({ until: "2026-10-25T06:00:00Z", reason: "한도 초과" }),
  };
  const snapshot = buildDashboardSnapshot({ chatId: "100", now, jobs: { listJobs: () => [], getActiveJob: () => null }, processes: { list: () => [] }, schedules, workspaces, personalOps: null });
  assert.equal(snapshot.usagePause.reason, "한도 초과");
  assert.match(snapshot.usagePause.untilLabel, /15:00/);
  assert.equal(snapshot.pool.schedules.usagePaused, true);
  assert.deepEqual(snapshot.failingSchedules.map((row) => [row.id, row.name, row.failureCount]), [["s1", "모닝 브리핑", 2]]);
  assert.equal(snapshot.failingSchedules[0].lastError, "Claude 사용 한도 도달 상세 로그");

  const context = vm.createContext({ formatTime: String });
  vm.runInContext(pick("    function renderStatusLine(", "    function renderSecurityNotice(") + escapeSource, context);
  const html = context.renderStatusLine(snapshot);
  assert.match(html, /AI 예약 작업 일시 중지/);
  assert.match(html, /한도 초과/);
  assert.match(html, /data-usage-pause="clear">해제/);
  assert.match(html, /data-schedule-id="s1"[\s\S]*모닝 브리핑 실패 2회[\s\S]*data-schedule-action="run">지금 실행/);
  assert.equal(context.renderStatusLine({ failingSchedules: [] }), "");
});

test("D3: schedule rows carry Korean labels and actions; the action endpoints use only the configured chat", async () => {
  const snapshot = buildDashboardSnapshot({
    chatId: "100", jobs: { listJobs: () => [], getActiveJob: () => null }, processes: { list: () => [] }, workspaces, personalOps: null,
    schedules: { list: () => [{ id: "s1", prompt: "[AI_WORKMATE_EVENING_BRIEF_V1]", intervalMs: 86400000, nextRunAt: "2026-10-25T12:00:00Z", weekdaysOnly: true }] },
  });
  assert.equal(snapshot.schedules[0].name, "이브닝 브리핑");
  assert.equal(snapshot.schedules[0].repeatLabel, "평일 21:00");

  const context = vm.createContext({ formatTime: String });
  vm.runInContext(pick("    function renderSchedules(", "    function badge(") + escapeSource, context);
  const rows = context.renderSchedules(snapshot.schedules, true);
  assert.match(rows, /이브닝 브리핑[\s\S]*평일 21:00/);
  assert.match(rows, /data-schedule-action="run">지금 실행[\s\S]*data-schedule-action="skip">한 번 건너뛰기[\s\S]*data-schedule-action="remove">삭제/);
  assert.doesNotMatch(context.renderSchedules(snapshot.schedules, false), /data-schedule-action/);
  assert.match(context.renderSchedules([]), /예약 작업이 없습니다/);
  assert.doesNotMatch(script, /No scheduled jobs/);

  const calls = [];
  const schedules = {
    async runNow(id, options) { calls.push(["run", id, options.chatId]); return id === "s1" ? { id } : null; },
    async skipNext(id, options) { calls.push(["skip", id, options.chatId]); return { id }; },
    async remove(input) { calls.push(["remove", input.id, input.chatId]); return true; },
    async clearUsagePause() { calls.push(["clear"]); },
  };
  await withServer({ schedules }, async (port) => {
    assert.equal((await postJson(port, "/api/schedule-action", { id: "s1", action: "run" })).status, 200);
    assert.equal((await postJson(port, "/api/schedule-action", { id: "s1", action: "skip" })).status, 200);
    assert.equal((await postJson(port, "/api/schedule-action", { id: "s1", action: "remove" })).status, 200);
    assert.equal((await postJson(port, "/api/schedule-action", { id: "other", action: "run" })).status, 404);
    assert.equal((await postJson(port, "/api/schedule-action", { id: "s1", action: "constructor" })).status, 400);
    assert.equal((await postJson(port, "/api/usage-pause", { action: "clear" })).status, 200);
    assert.equal((await postJson(port, "/api/usage-pause", { action: "set" })).status, 400);
    assert.equal((await postJson(port, "/api/schedule-action", { id: "s1", action: "run" }, { origin: "http://evil.example" })).status, 403);
  });
  assert.deepEqual(calls, [["run", "s1", "100"], ["skip", "s1", "100"], ["remove", "s1", "100"], ["run", "other", "100"], ["clear"]]);
});

test("D4: briefing cards expand, store 👍/👎 feedback and resend the stored text to Telegram", async () => {
  const context = vm.createContext({ formatTime: String });
  vm.runInContext(pick("    function renderBriefings(", "    function renderInbox(") + escapeSource, context);
  const html = context.renderBriefings([{ id: "b1", kind: "morning", sentAt: "t", text: "☀️ 모닝\n• 맑음\n전체 <본문>", feedback: "interest" }]);
  assert.match(html, /data-briefing-id="b1"><details>/);
  assert.match(html, /briefing-full">☀️ 모닝\n• 맑음\n전체 &lt;본문&gt;/);
  assert.match(html, /data-briefing-action="up"[^>]*aria-pressed="true">👍/);
  assert.match(html, /data-briefing-action="down"[^>]*aria-pressed="false">👎/);
  assert.match(html, /data-briefing-action="resend">다시 보내기/);

  const feedback = [];
  const sent = [];
  const personalOps = {
    async setBriefingFeedback(input) { feedback.push(input); return input.id === "b1" ? { id: "b1" } : null; },
    listBriefingHistory: (chatId) => (chatId === "100" ? [{ id: "b1", text: "브리핑 본문" }] : []),
  };
  const telegram = { async sendMessage(chatId, text) { sent.push([chatId, text]); return { message_id: 1 }; } };
  await withServer({ personalOps, telegram }, async (port) => {
    assert.equal((await postJson(port, "/api/briefing-feedback", { id: "b1", feedback: "up" })).status, 200);
    assert.equal((await postJson(port, "/api/briefing-feedback", { id: "b1", feedback: "down" })).status, 200);
    assert.equal((await postJson(port, "/api/briefing-feedback", { id: "zz", feedback: "up" })).status, 404);
    assert.equal((await postJson(port, "/api/briefing-feedback", { id: "b1", feedback: "love" })).status, 400);
    assert.equal((await postJson(port, "/api/briefing-resend", { id: "b1" })).status, 200);
    assert.equal((await postJson(port, "/api/briefing-resend", { id: "zz" })).status, 404);
  });
  assert.deepEqual(feedback.map((row) => [row.chatId, row.id, row.feedback]), [["100", "b1", "interest"], ["100", "b1", "skip"], ["100", "zz", "interest"]]);
  assert.deepEqual(sent, [["100", "브리핑 본문"]]);
  const noChat = await handleBriefingResend({ id: "b1" }, { config: { allowedChatIds: [] }, telegram, personalOps });
  assert.equal(noChat.status, 400);
});

test("D4: expanded briefings stay open across the 5-second refresh", () => {
  const context = vm.createContext({});
  vm.runInContext(pick("    function setHtmlKeepingOpen(", "    function renderStatusLine("), context);
  const details = { open: true };
  const rowA = { getAttribute: () => "b1", querySelector: () => details };
  const fresh = { open: false };
  const container = {
    rows: [rowA],
    querySelectorAll() { return this.rows; },
    set innerHTML(value) { this.html = value; this.rows = [{ getAttribute: () => "b1", querySelector: () => fresh }]; },
  };
  context.setHtmlKeepingOpen(container, "<new>", "data-briefing-id");
  assert.equal(container.html, "<new>");
  assert.equal(fresh.open, true);
});

test("D5: inbox rows show days waiting, due date and a 24h snooze action", () => {
  const now = new Date("2026-10-25T03:00:00Z");
  const snapshot = buildDashboardSnapshot({
    chatId: "100", now, jobs: { listJobs: () => [], getActiveJob: () => null }, processes: { list: () => [] }, schedules: { list: () => [] }, workspaces,
    personalOps: { listInbox: () => [
      { id: "in-1", type: "task", text: "보고서", createdAt: "2026-10-22T01:00:00Z", dueAt: "2026-10-24T15:00:00Z" },
      { id: "in-2", type: "read", text: "글", createdAt: "2026-10-25T02:00:00Z" },
    ] },
  });
  assert.deepEqual(snapshot.inbox.map((row) => [row.daysWaiting, row.dueLabel, row.overdue]), [[3, "10/25", true], [0, null, false]]);
  const context = vm.createContext({ formatTime: String });
  vm.runInContext(pick("    function renderInbox(", "    function setHtmlKeepingOpen(") + escapeSource, context);
  const html = context.renderInbox(snapshot.inbox);
  assert.match(html, /할 일 · 3일째 · <span class="overdue">마감 10\/25 \(지남\)/);
  assert.match(html, /읽기 · 오늘 추가/);
  assert.match(html, /data-inbox-action="snooze"[^>]*>미루기/);
  // The existing inbox click handler turns the action into "/snooze <id>", which defaults to 24 hours.
  assert.match(script, /runDashboardCommand\("\/" \+ button\.dataset\.inboxAction \+ " " \+ id/);
});

test("D6: Korean labels, hidden unconfigured checks and stale repository checks with a background recheck", async () => {
  const badges = vm.createContext({});
  vm.runInContext(statusSource + escapeSource, badges);
  assert.match(badges.badge("completed"), /pill completed">완료/);
  assert.match(badges.badge("failed"), /실패/);
  assert.match(badges.badge("custom"), />custom</);
  assert.doesNotMatch(script, />Job<\/th>|>Kind<\/th>|>Status<\/th>|>Process<\/th>|"Unpublish"|>Retry</);

  const storage = vm.createContext({ formatTime: String, formatBytes: () => "1.0 GB" });
  vm.runInContext(pick("    function renderStorage(", "    function renderRepoChecks(") + escapeSource, storage);
  const photosHidden = storage.renderStorage({ storage: { configured: true, ok: true, path: "/Volumes/SSD", availableBytes: 1 }, photoBackup: { configured: false, ok: false } });
  assert.match(photosHidden, /외장 SSD/);
  assert.doesNotMatch(photosHidden, /사진 원본 백업|설정 안 됨/);
  assert.match(storage.renderStorage({ storage: { configured: false }, photoBackup: { configured: false } }), /설정된 저장소 점검이 없습니다/);

  const repos = vm.createContext({ formatTime: String });
  vm.runInContext(pick("    function renderRepoChecks(", "    let availableDocuments") + escapeSource, repos);
  const fresh = new Date().toISOString();
  const html = repos.renderRepoChecks({ checkedAt: "2026-01-01T00:00:00Z", repos: [
    { name: "old", issues: [], checkedAt: "2026-01-01T00:00:00Z" },
    { name: "new", issues: [], checkedAt: fresh },
    { name: "busy", issues: [], checkedAt: "2026-01-01T00:00:00Z", rechecking: true },
  ] });
  assert.match(html, /data-repo-name="old"[\s\S]*오래됨[\s\S]*data-repo-recheck="old">재점검/);
  assert.doesNotMatch(html.slice(html.indexOf('data-repo-name="new"'), html.indexOf('data-repo-name="busy"')), /오래됨|재점검/);
  assert.match(html.slice(html.indexOf('data-repo-name="busy"')), /재점검 중…/);

  let stored = { checkedAt: "2026-01-01T00:00:00Z", repos: [{ name: "old", harness: false, git: true, publish: { blockers: [{ rule: "env-file" }] } }, { name: "other", harness: false, git: true }] };
  const personalOps = { getRepoChecks: () => stored, async setRepoChecks(value) { stored = value; } };
  const rechecking = new Set();
  const ran = [];
  const runner = async (name, options) => { ran.push([name, Boolean(options.config)]); return { name, harness: false, git: true, publish: { blockers: [] } }; };
  const started = startRepoRecheck({ name: "old" }, { config: {}, personalOps, rechecking, repoCheckRunner: runner, now: () => new Date("2026-10-25T00:00:00Z") });
  assert.equal(started.status, 202);
  assert.equal(compactRepoChecksWithAge(stored, rechecking).repos[0].rechecking, true);
  assert.equal(startRepoRecheck({ name: "old" }, { config: {}, personalOps, rechecking, repoCheckRunner: runner }).running, true);
  await started.done;
  assert.deepEqual(ran, [["old", true]]);
  assert.equal(rechecking.size, 0);
  const compact = compactRepoChecksWithAge(stored, rechecking);
  assert.deepEqual(compact.repos.map((row) => [row.name, row.checkedAt, row.issues.length]), [["old", "2026-10-25T00:00:00.000Z", 0], ["other", "2026-01-01T00:00:00Z", 0]]);
  assert.equal(startRepoRecheck({ name: "missing" }, { config: {}, personalOps, rechecking, repoCheckRunner: runner }).status, 404);
});

test("D6: the recheck endpoint answers before the check finishes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let stored = { checkedAt: "2026-01-01T00:00:00Z", repos: [{ name: "app", harness: false, git: true }] };
  const personalOps = { getRepoChecks: () => stored, async setRepoChecks(value) { stored = value; } };
  await withServer({ personalOps, repoCheckRunner: async (name) => { await gate; return { name, harness: false, git: true }; } }, async (port) => {
    const response = await postJson(port, "/api/repo-check", { name: "app" });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { ok: true, started: true });
    assert.equal(stored.repos[0].checkedAt, undefined);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(stored.repos[0].checkedAt);
  });
});

test("D7: tailnet POSTs need a listed Tailscale login when DASHBOARD_TAILNET_USERS is set", async () => {
  const req = (host, login) => ({ headers: { host, ...(login ? { "tailscale-user-login": login } : {}) } });
  const restricted = { dashboardTailnetUsers: ["me@example.com"] };
  assert.equal(isTailnetUserAllowed(req("mac.tail1.ts.net", "Me@Example.com"), restricted), true);
  assert.equal(isTailnetUserAllowed(req("mac.tail1.ts.net", "other@example.com"), restricted), false);
  assert.equal(isTailnetUserAllowed(req("mac.tail1.ts.net"), restricted), false);
  assert.equal(isTailnetUserAllowed(req("127.0.0.1:8766"), restricted), true);
  assert.equal(isTailnetUserAllowed(req("mac.tail1.ts.net"), {}), true);
  // The Host is client-controlled: proxy headers or an unlisted login still require a listed login.
  assert.equal(isTailnetUserAllowed(req("localhost:8766", "intruder@example.com"), restricted), false);
  assert.equal(isTailnetUserAllowed({ headers: { host: "localhost:8766", "x-forwarded-for": "100.64.0.9" } }, restricted), false);
  assert.equal(isTailnetUserAllowed({ headers: { host: "localhost:8766", "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "me@example.com" } }, restricted), true);

  const calls = [];
  const schedules = { async clearUsagePause() { calls.push("clear"); } };
  await withServer({ schedules, config: restricted }, async (port) => {
    const host = "mac.tail1.ts.net";
    const denied = await postJson(port, "/api/usage-pause", { action: "clear" }, { host, origin: `https://${host}` });
    assert.equal(denied.status, 403);
    const wrong = await postJson(port, "/api/command", { command: "/status" }, { host, origin: `https://${host}`, headers: { "tailscale-user-login": "intruder@example.com" } });
    assert.equal(wrong.status, 403);
    const allowed = await postJson(port, "/api/usage-pause", { action: "clear" }, { host, origin: `https://${host}`, headers: { "tailscale-user-login": "me@example.com" } });
    assert.equal(allowed.status, 200);
    assert.equal((await postJson(port, "/api/usage-pause", { action: "clear" })).status, 200, "loopback is unaffected");
    const forged = await postJson(port, "/api/usage-pause", { action: "clear" }, { host: `localhost:${port}`, origin: `http://localhost:${port}`, headers: { "tailscale-user-login": "intruder@example.com" } });
    assert.equal(forged.status, 403, "a forged loopback Host does not skip the login check");
    const read = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/job-result?id=abc", headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    assert.equal(read, 403, "reads through the tailnet are restricted too");
  });
  assert.deepEqual(calls, ["clear", "clear"]);

  const context = vm.createContext({});
  vm.runInContext(pick("    function renderSecurityNotice(", "    function updateExperiments("), context);
  assert.match(context.renderSecurityNotice({ tailnetUsersConfigured: false }), /모든 기기가 이 대시보드에서 명령을 실행할 수 있습니다/);
  assert.match(context.renderSecurityNotice({ tailnetUsersConfigured: true }), /등록된 계정만/);
  assert.match(renderDashboardHtml(config), /data-panel="settings" hidden><section[^>]*><h2>접근 보안<\/h2><div id="securityNotice"/);
});

test("O8 rendering: briefing health replaces the format score when available", () => {
  const context = vm.createContext({ metric: (label, value) => `${label}=${value};` });
  vm.runInContext(pick("    function renderBriefingHealth(", "    let tradingDetailKey"), context);
  assert.equal(
    context.renderBriefingHealth({ briefingHealth: { days: 14, briefings: 20, lateDeliveries: 2, feedbackCount: 5, feedbackRate: 0.25, localFailures: 1 } }),
    "브리핑 · 최근 14일=20건 · 지연 2건;추천 피드백=5건 · 25%;로컬 브리핑 실패=1건;",
  );
  assert.match(context.renderBriefingHealth({ briefingQuality: { averageScore: 90 } }), /브리핑 형식 검사 · 사실 정확성 미평가=90\/100/);
});
