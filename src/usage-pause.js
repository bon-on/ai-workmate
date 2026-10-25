import { formatKst } from "./schedule-names.js";

// Usage pause that follows the provider's limit reset (daily-ux O10).
const RECHECK_MS = 15 * 60 * 1000;
const lastChecks = new WeakMap();

// Windows at 100% and the latest of their resets; null when the read failed.
export function exhaustedCodexWindows(limits, now = new Date()) {
  if (!limits || limits.status !== "available") return null;
  const windows = [limits.fiveHour, limits.weekly].filter(Boolean);
  if (!windows.length) return null;
  const exhausted = windows.filter((row) => row.usedPercent >= 100);
  const resets = exhausted.map((row) => Date.parse(row.resetsAt)).filter((time) => Number.isFinite(time) && time > now.getTime());
  return { exhausted: exhausted.length > 0, resetAt: resets.length ? new Date(Math.max(...resets)).toISOString() : null };
}

// Reset time and trust for a job that just hit a usage limit.
export async function resolveUsageReset(job, { readCodexLimits = null, now = new Date() } = {}) {
  if (job.provider === "claude") {
    const seconds = Number(job.claudeRateLimit?.resetsAt);
    const resetAt = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
    return { provider: "claude", resetAt, canReleaseEarly: false };
  }
  const limits = readCodexLimits ? await readCodexLimits().catch(() => null) : null;
  const state = exhaustedCodexWindows(limits, now);
  // Early release is trusted only when the read itself shows the exhaustion.
  return { provider: "codex", resetAt: state?.resetAt ?? null, canReleaseEarly: Boolean(state?.exhausted) };
}

export function formatUsageResumeNotice({ early }) {
  return early
    ? "▶️ AI 사용 한도가 갱신되어 예약 작업을 다시 시작합니다."
    : "▶️ AI 사용 한도 재설정 시각이 지나 예약 작업을 다시 시작합니다.";
}

// Called from the schedule tick. Ends an expired pause, or an active Codex pause whose
// limits are no longer exhausted, and sends one resume notice. Returns what happened.
export async function checkUsagePause({ schedules, readCodexLimits = null, telegram, fallbackChatId = null, now = new Date() }) {
  const pause = schedules.peekUsagePause?.();
  if (!pause) return null;
  const chatId = pause.chatId || fallbackChatId;
  if (Date.parse(pause.until) <= now.getTime()) {
    await schedules.clearUsagePause({ now });
    await notify(telegram, chatId, formatUsageResumeNotice({ early: false }));
    return "expired";
  }
  if (pause.provider !== "codex" || !pause.canReleaseEarly || !readCodexLimits) return null;
  if (now.getTime() - (lastChecks.get(schedules) ?? 0) < RECHECK_MS) return null;
  lastChecks.set(schedules, now.getTime());
  const state = exhaustedCodexWindows(await readCodexLimits().catch(() => null), now);
  // The read can take seconds: a /resume or a different pause in the meantime wins.
  const current = schedules.peekUsagePause?.();
  if (!state || !current || current.until !== pause.until || !current.canReleaseEarly) return null;
  if (state.exhausted) {
    if (state.resetAt) await schedules.extendUsagePause(state.resetAt);
    return null;
  }
  await schedules.clearUsagePause({ early: true, now });
  await notify(telegram, chatId, formatUsageResumeNotice({ early: true }));
  return "released";
}

export function describePauseEnd(pause) {
  return `재개 예정: ${formatKst(pause.until)} (KST)${pause.canReleaseEarly ? " · 한도가 먼저 갱신되면 바로 재개" : ""}`;
}

async function notify(telegram, chatId, text) {
  if (!chatId) return;
  try { await telegram.sendMessage(chatId, text); }
  catch (error) { console.error("Usage resume notice failed:", error.message); }
}
