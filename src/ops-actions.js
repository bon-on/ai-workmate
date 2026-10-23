import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// Operational actions approved from Telegram inline buttons. The action list is
// fixed in code; chat text only selects one of them.

const RESTART_NOTICE_MAX_AGE_MS = 10 * 60 * 1000;

export function listRunningJobs(jobs) {
  return jobs?.listRunningJobs?.() ?? [];
}

export async function requestRestart({ approvals, telegram, message, jobs, config, serviceName = process.env.XPC_SERVICE_NAME }) {
  const chatId = message.chat.id;
  if (!config.launchdLabel) {
    await telegram.sendMessage(chatId, "재시작할 launchd 서비스가 설정되지 않았습니다. AI_WORKMATE_LAUNCHD_LABEL을 설정하세요.");
    return null;
  }
  // launchd sets XPC_SERVICE_NAME to the job label; anything else (npm start, daemon script) cannot be kickstarted.
  if (serviceName !== config.launchdLabel) {
    await telegram.sendMessage(chatId, `이 프로세스는 launchd 서비스 ${config.launchdLabel}로 실행되지 않아 재시작할 수 없습니다.`);
    return null;
  }
  const running = listRunningJobs(jobs);
  const entry = approvals.create({
    chatId,
    userId: message.from?.id ?? "unknown",
    prompt: "restart",
    workspaceAlias: "ops",
    operationMode: "restart",
    kind: "ops",
  });
  await telegram.sendMessage(chatId, [
    "AI Workmate 서비스를 재시작할까요?",
    `서비스: ${config.launchdLabel}`,
    running.length
      ? `⚠️ 실행 중인 작업 ${running.length}개: ${running.slice(0, 3).map((job) => job.jobId).join(", ")} — 끝난 뒤 승인해야 재시작됩니다.`
      : "실행 중인 작업 없음",
    "승인 요청은 15분 후 만료됩니다.",
  ].join("\n"), {
    reply_markup: { inline_keyboard: [[
      { text: "재시작 승인", callback_data: `ops:run:${entry.id}` },
      { text: "취소", callback_data: `ops:cancel:${entry.id}` },
    ]] },
  });
  return entry;
}

export async function handleOpsCallback({
  callbackQuery, action, id, approvals, telegram, jobs, config,
  runRestart = kickstartService, writeNotice = writeRestartNotice,
}) {
  const message = callbackQuery.message;
  const chatId = message.chat.id;
  const answer = (text) => telegram.answerCallbackQuery(callbackQuery.id, text)
    // A query answered after a restart is too old for Telegram; that is not a polling failure.
    .catch((error) => console.error("Ops callback answer failed:", error.message));
  const input = { id, chatId, userId: callbackQuery.from.id, kind: "ops" };
  if (action === "cancel") {
    const cancelled = approvals.cancel(input);
    await answer(cancelled ? "취소했습니다." : "만료된 요청입니다.");
    if (cancelled) await telegram.editMessageReplyMarkup(chatId, message.message_id);
    return { status: cancelled ? "cancelled" : "expired" };
  }
  if (action !== "run") {
    await answer("알 수 없는 작업입니다.");
    return { status: "unknown" };
  }
  if (!approvals.peek(input)) {
    await answer("만료되었거나 권한이 없는 요청입니다.");
    return { status: "expired" };
  }
  // Not consumed while busy, so the user can approve again once the jobs finish.
  const running = listRunningJobs(jobs);
  if (running.length) {
    await answer(`실행 중인 작업 ${running.length}개가 있어 재시작하지 않았습니다.`);
    return { status: "busy", running: running.length };
  }
  approvals.consume(input);
  await answer("재시작합니다.");
  await telegram.editMessageReplyMarkup(chatId, message.message_id);
  await writeNotice(config.restartNoticePath, { chatId: String(chatId), requestedAt: new Date().toISOString(), previousPid: process.pid });
  await telegram.sendMessage(chatId, "🔄 재시작을 시작합니다. 완료되면 다시 알려드립니다.");
  // A job may have started during the Telegram calls above (scheduler tick, dashboard).
  const late = listRunningJobs(jobs);
  if (late.length) {
    await fs.rm(config.restartNoticePath, { force: true });
    await telegram.sendMessage(chatId, `재시작을 취소했습니다. 그사이 작업 ${late.length}개가 시작됐습니다. 끝난 뒤 /restart를 다시 요청하세요.`);
    return { status: "busy", running: late.length };
  }
  runRestart(config.launchdLabel, {
    onFailure: async (reason) => {
      await fs.rm(config.restartNoticePath, { force: true });
      await telegram.sendMessage(chatId, `⚠️ 재시작 실패: ${reason}`);
    },
  });
  return { status: "restarting" };
}

export function kickstartService(label, { spawnImpl = spawn, uid = process.getuid(), onFailure = async () => {} } = {}) {
  // Detached: launchd kills this process while launchctl is still running.
  // On success this process never sees the exit; the handlers only report failures.
  const child = spawnImpl("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], { detached: true, stdio: "ignore" });
  const fail = (reason) => onFailure(reason).catch((error) => console.error("Restart failure notice failed:", error.message));
  child.on?.("error", (error) => fail(error.message));
  child.on?.("exit", (code) => { if (code) fail(`launchctl exit ${code}`); });
  child.unref?.();
  return child;
}

export async function writeRestartNotice(file, notice) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(notice)}\n`, "utf8");
}

// Called once at startup. The notice is removed before sending so a crash loop cannot repeat it.
export async function announceRestart({ config, telegram, now = new Date() }) {
  let notice;
  try { notice = JSON.parse(await fs.readFile(config.restartNoticePath, "utf8")); }
  catch { return false; }
  await fs.rm(config.restartNoticePath, { force: true });
  const requestedAt = Date.parse(notice?.requestedAt);
  if (!notice?.chatId || !Number.isFinite(requestedAt) || now.getTime() - requestedAt > RESTART_NOTICE_MAX_AGE_MS) return false;
  const seconds = Math.max(0, Math.round((now.getTime() - requestedAt) / 1000));
  await telegram.sendMessage(notice.chatId, `✅ 재시작 완료 · PID ${process.pid}${notice.previousPid ? ` (이전 ${notice.previousPid})` : ""} · ${seconds}초 소요`);
  return true;
}
