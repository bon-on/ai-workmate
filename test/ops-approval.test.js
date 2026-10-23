import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalStore, requiresExplicitApproval } from "../src/approval-store.js";
import { announceRestart, handleOpsCallback, kickstartService, requestRestart } from "../src/ops-actions.js";
import { handleCallbackQuery, handleMessage } from "../src/router.js";
import { executeDashboardCommand } from "../src/dashboard-server.js";

function recorder() {
  const calls = [];
  return {
    calls,
    telegram: {
      async sendMessage(chatId, text, extra = {}) { calls.push(["send", String(chatId), text, extra]); return { message_id: 9 }; },
      async answerCallbackQuery(id, text) { calls.push(["answer", text]); },
      async editMessageReplyMarkup(chatId, messageId) { calls.push(["edit", String(chatId), messageId]); },
    },
  };
}

async function noticePath() {
  return path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ops-test-")), "notice.json");
}

const message = { chat: { id: 1 }, from: { id: 2 }, message_id: 5 };
const callback = (data, userId = 2) => ({ id: "cb", from: { id: userId }, message, data });

test("/restart asks for approval with the active job count and ops-scoped buttons", async () => {
  const { calls, telegram } = recorder();
  const approvals = new ApprovalStore();
  const jobs = { listRunningJobs: () => [{ jobId: "job-a" }] };
  const config = { allowedChatIds: ["1"], allowedUserIds: ["2"], launchdLabel: "com.example.bridge" };
  const previous = process.env.XPC_SERVICE_NAME;
  process.env.XPC_SERVICE_NAME = "com.example.bridge";
  try { await handleMessage({ message: { ...message, text: "/restart" }, config, telegram, jobs, approvals }); }
  finally { if (previous === undefined) delete process.env.XPC_SERVICE_NAME; else process.env.XPC_SERVICE_NAME = previous; }
  const [, , text, extra] = calls[0];
  assert.match(text, /com\.example\.bridge/);
  assert.match(text, /실행 중인 작업 1개: job-a/);
  const [run, cancel] = extra.reply_markup.inline_keyboard[0];
  assert.match(run.callback_data, /^ops:run:/);
  assert.match(cancel.callback_data, /^ops:cancel:/);
});

test("approval re-checks running jobs, rejects other users, and restarts only once when idle", async () => {
  const { calls, telegram } = recorder();
  const approvals = new ApprovalStore();
  let running = [{ jobId: "job-a" }];
  const jobs = { listRunningJobs: () => running };
  const config = { allowedChatIds: ["1"], allowedUserIds: [], launchdLabel: "com.example.bridge", restartNoticePath: await noticePath() };
  const entry = await requestRestart({ approvals, telegram, message, jobs, config, serviceName: config.launchdLabel });
  const restarts = [];
  const runRestart = (label) => { restarts.push(label); calls.push(["restart"]); };

  let result = await handleOpsCallback({ callbackQuery: callback(`ops:run:${entry.id}`), action: "run", id: entry.id, approvals, telegram, jobs, config, runRestart });
  assert.equal(result.status, "busy");
  assert.deepEqual(restarts, []);

  running = [];
  result = await handleOpsCallback({ callbackQuery: callback(`ops:run:${entry.id}`, 3), action: "run", id: entry.id, approvals, telegram, jobs, config, runRestart });
  assert.equal(result.status, "expired", "another user cannot approve");

  result = await handleOpsCallback({ callbackQuery: callback(`ops:run:${entry.id}`), action: "run", id: entry.id, approvals, telegram, jobs, config, runRestart });
  assert.equal(result.status, "restarting");
  assert.deepEqual(restarts, ["com.example.bridge"]);
  assert.deepEqual(calls.slice(-4).map((row) => row[0]), ["answer", "edit", "send", "restart"], "user is told before launchd stops this process");
  const notice = JSON.parse(await fs.readFile(config.restartNoticePath, "utf8"));
  assert.equal(notice.chatId, "1");

  result = await handleOpsCallback({ callbackQuery: callback(`ops:run:${entry.id}`), action: "run", id: entry.id, approvals, telegram, jobs, config, runRestart });
  assert.equal(result.status, "expired");
  assert.deepEqual(restarts, ["com.example.bridge"]);
});

test("an AI-job approval button cannot consume an ops approval", async () => {
  const { telegram } = recorder();
  const approvals = new ApprovalStore();
  const config = { allowedChatIds: ["1"], allowedUserIds: [], launchdLabel: "x", restartNoticePath: await noticePath() };
  const entry = await requestRestart({ approvals, telegram, message, jobs: { listRunningJobs: () => [] }, config, serviceName: config.launchdLabel });
  let started = false;
  await handleCallbackQuery({
    callbackQuery: callback(`approval:run:${entry.id}`), config, telegram, approvals,
    jobs: { startJob: async () => { started = true; return { accepted: false }; } },
    workspaces: { getWorkspaceByAlias: () => null, getActiveWorkspace: () => ({ alias: "default" }) },
  });
  assert.equal(started, false);
  assert.ok(approvals.consume({ id: entry.id, chatId: 1, userId: 2, kind: "ops" }), "ops entry is still pending");
});

test("/restart without a label does nothing, and is refused from the dashboard", async () => {
  const { calls, telegram } = recorder();
  const approvals = new ApprovalStore();
  await requestRestart({ approvals, telegram, message, jobs: {}, config: { launchdLabel: "" } });
  assert.match(calls[0][2], /AI_WORKMATE_LAUNCHD_LABEL/);
  assert.equal(approvals.entries.size, 0);
  await assert.rejects(() => executeDashboardCommand({ command: "/restart", config: { allowedChatIds: ["1"] } }), /not available from the dashboard/);
});

test("kickstart runs detached launchctl for the configured label", () => {
  const spawned = [];
  kickstartService("com.example.bridge", { uid: 501, spawnImpl: (file, args, options) => { spawned.push([file, args, options]); return { unref() {} }; } });
  assert.deepEqual(spawned[0][0], "launchctl");
  assert.deepEqual(spawned[0][1], ["kickstart", "-k", "gui/501/com.example.bridge"]);
  assert.equal(spawned[0][2].detached, true);
});

test("the restarted process announces completion once and ignores stale notices", async () => {
  const { calls, telegram } = recorder();
  const config = { restartNoticePath: await noticePath() };
  const now = new Date("2026-10-22T01:00:30Z");
  await fs.writeFile(config.restartNoticePath, JSON.stringify({ chatId: "1", requestedAt: "2026-10-22T01:00:00Z", previousPid: 111 }));
  assert.equal(await announceRestart({ config, telegram, now }), true);
  assert.match(calls[0][2], /재시작 완료 · PID \d+ \(이전 111\) · 30초 소요/);
  assert.equal(await announceRestart({ config, telegram, now }), false, "notice is consumed");
  await fs.writeFile(config.restartNoticePath, JSON.stringify({ chatId: "1", requestedAt: "2026-10-21T00:00:00Z" }));
  assert.equal(await announceRestart({ config, telegram, now }), false);
  assert.equal(calls.length, 1);
});

test("push requests to a remote require explicit approval", () => {
  assert.equal(requiresExplicitApproval("git push origin main 해줘"), true);
  assert.equal(requiresExplicitApproval("변경사항 커밋하고 GitHub에 푸시해줘"), true);
  assert.equal(requiresExplicitApproval("원격 저장소에 올려줘"), true);
  for (const prompt of ["push this branch to GitHub", "push to origin", "GitHub에 업로드해줘", "upload the repo to github", "원격 저장소에 반영해줘", "gh repo create foo --public --push"]) {
    assert.equal(requiresExplicitApproval(prompt), true, prompt);
  }
  assert.equal(requiresExplicitApproval("git status 보여줘"), false);
});

test("restart is refused when not running under the launchd label, when a job starts mid-approval, and reports launchctl failure", async () => {
  const { calls, telegram } = recorder();
  const approvals = new ApprovalStore();
  assert.equal(await requestRestart({ approvals, telegram, message, jobs: {}, config: { launchdLabel: "com.example.bridge" }, serviceName: undefined }), null);
  assert.match(calls.at(-1)[2], /launchd 서비스 com\.example\.bridge로 실행되지 않아/);

  const config = { launchdLabel: "com.example.bridge", restartNoticePath: await noticePath() };
  let running = [];
  const jobs = { listRunningJobs: () => running };
  const entry = await requestRestart({ approvals, telegram, message, jobs, config, serviceName: "com.example.bridge" });
  const slowTelegram = { ...telegram, async sendMessage(...args) { running = [{ jobId: "late" }]; return telegram.sendMessage(...args); } };
  const restarts = [];
  const result = await handleOpsCallback({ callbackQuery: callback(`ops:run:${entry.id}`), action: "run", id: entry.id, approvals, telegram: slowTelegram, jobs, config, runRestart: (label) => restarts.push(label) });
  assert.equal(result.status, "busy");
  assert.deepEqual(restarts, []);
  assert.match(calls.at(-1)[2], /재시작을 취소했습니다/);
  await assert.rejects(fs.access(config.restartNoticePath), "notice removed so a later restart does not claim success");

  const listeners = {};
  const failures = [];
  kickstartService("com.example.bridge", { uid: 501, onFailure: async (reason) => failures.push(reason), spawnImpl: () => ({ on(event, fn) { listeners[event] = fn; }, unref() {} }) });
  listeners.exit(113);
  listeners.error(new Error("spawn launchctl ENOENT"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, ["launchctl exit 113", "spawn launchctl ENOENT"]);
});

test("busy approval is not consumed and an unknown id reports expiry, not the job count", async () => {
  const { calls, telegram } = recorder();
  const approvals = new ApprovalStore();
  const jobs = { listRunningJobs: () => [{ jobId: "a" }] };
  const config = { launchdLabel: "x", restartNoticePath: await noticePath() };
  const entry = await requestRestart({ approvals, telegram, message, jobs, config, serviceName: "x" });
  await handleOpsCallback({ callbackQuery: callback("ops:run:nope"), action: "run", id: "nope", approvals, telegram, jobs, config, runRestart: () => {} });
  assert.match(calls.at(-1)[1], /만료되었거나/);
  await handleOpsCallback({ callbackQuery: callback(`ops:run:${entry.id}`), action: "run", id: entry.id, approvals, telegram, jobs, config, runRestart: () => {} });
  assert.ok(approvals.peek({ id: entry.id, chatId: 1, userId: 2, kind: "ops" }));
});
