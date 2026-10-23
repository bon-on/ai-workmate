import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getBriefingKind } from "./briefing-quality.js";

export class ScheduleStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.version = 1;
    this.entries = new Map();
    this.briefingAttempts = {};
    this.usagePausedUntil = null;
    this.saveQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== this.version || !Array.isArray(parsed.entries)) {
        return;
      }

      this.entries.clear();
      this.briefingAttempts = parsed.briefingAttempts || {};
      this.usagePausedUntil = parsed.usagePausedUntil || null;
      for (const entry of parsed.entries) {
        if (!isValidEntry(entry)) {
          continue;
        }

        this.entries.set(entry.id, normalizeEntry(entry));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async add({
    chatId,
    userId,
    workspaceAlias,
    prompt,
    nextRunAt,
    intervalMs = null,
    weekdaysOnly = false,
    failureCount = 0,
    lastError = null,
  }) {
    const entry = {
      id: randomUUID().slice(0, 8),
      chatId: String(chatId),
      userId: String(userId),
      workspaceAlias,
      prompt: prompt.trim(),
      nextRunAt: new Date(nextRunAt).toISOString(),
      intervalMs,
      weekdaysOnly,
      failureCount,
      lastError,
      createdAt: new Date().toISOString(),
    };

    if (!isValidEntry(entry)) {
      throw new Error("Invalid schedule entry");
    }

    this.entries.set(entry.id, entry);
    await this.#save();
    return entry;
  }

  list(chatId = null) {
    return [...this.entries.values()]
      .filter((entry) => !chatId || entry.chatId === String(chatId))
      .sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt));
  }

  due(now = new Date(), { includeWhileUsagePaused = false } = {}) {
    if (this.isUsagePaused(now) && !includeWhileUsagePaused) return [];
    const nowMs = Date.parse(now.toISOString());
    return this.list().filter((entry) => Date.parse(entry.nextRunAt) <= nowMs);
  }

  isUsagePaused(now = new Date()) {
    return Date.parse(this.usagePausedUntil) > now.getTime();
  }

  async pauseForUsageLimit(error, now = new Date()) {
    const text = String(error || "");
    if (!/usage_limit_reached|hit your usage limit|usage limit (?:has been )?(?:reached|exceeded)/i.test(text)) return false;
    const retryAt = text.match(/try again at ([A-Za-z]{3,9} \d{1,2}(?:st|nd|rd|th)?, \d{4} \d{1,2}:\d{2}\s*[AP]M)/i)?.[1];
    const parsed = retryAt ? Date.parse(retryAt.replace(/(\d)(st|nd|rd|th)/g, "$1")) : NaN;
    // CLI reset timestamps use the host timezone. Unknown resets fail closed
    // for 24 hours instead of spending another attempt every few minutes.
    const until = Number.isFinite(parsed) && parsed > now.getTime()
      ? parsed + 60_000 : now.getTime() + 24 * 60 * 60 * 1000;
    this.usagePausedUntil = new Date(Math.max(until, Date.parse(this.usagePausedUntil) || 0)).toISOString();
    await this.#save();
    return true;
  }

  async reserveBriefingAttempt(entry, { retry = false, now = new Date() } = {}) {
    if (this.isUsagePaused(now)) return false;
    const kind = getBriefingKind(entry.prompt);
    if (!kind) return true;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
    const key = `${day}:${entry.chatId}:${kind}`;
    const attempts = this.briefingAttempts[key] || 0;
    if ((!retry && attempts > 0) || (retry && attempts !== 1)) return false;
    this.briefingAttempts[key] = attempts + 1;
    // Retain a small restart-safe ledger, independent of schedule IDs.
    for (const old of Object.keys(this.briefingAttempts)) {
      if (old.slice(0, 10) < new Date(now.getTime() - 8 * 86400000).toISOString().slice(0, 10)) delete this.briefingAttempts[old];
    }
    await this.#save();
    return true;
  }

  async remove({ chatId, id }) {
    const entry = this.entries.get(id);
    if (!entry || entry.chatId !== String(chatId)) {
      return null;
    }

    this.entries.delete(id);
    await this.#save();
    return entry;
  }

  async updatePrompt(id, prompt) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.prompt = String(prompt).trim();
    await this.#save();
    return entry;
  }

  async reschedule(id, nextRunAt) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.nextRunAt = new Date(nextRunAt).toISOString();
    await this.#save();
    return entry;
  }

  async markStarted(id, now = new Date()) {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }

    if (!entry.intervalMs) {
      this.entries.delete(id);
      await this.#save();
      return null;
    }

    entry.nextRunAt = computeNextRunAt(entry, now).toISOString();
    await this.#save();
    return entry;
  }

  async recordSuccess(id) {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }

    entry.failureCount = 0;
    entry.lastError = null;
    await this.#save();
    return entry;
  }

  async recordFailure(id, error, { maxFailures = 3, retryDelayMs = 10 * 60 * 1000 } = {}) {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }

    entry.failureCount = (entry.failureCount ?? 0) + 1;
    entry.lastError = String(error || "Scheduled job failed").slice(0, 500);
    if (getBriefingKind(entry.prompt)) {
      // Its next normal occurrence was already persisted before execution.
      // Never regenerate a daily briefing as a generic failure retry.
      await this.#save();
      return entry;
    }
    if (entry.failureCount >= maxFailures) {
      this.entries.delete(id);
      await this.#save();
      return { ...entry, disabled: true };
    }

    entry.nextRunAt = new Date(Date.now() + retryDelayMs * entry.failureCount).toISOString();
    await this.#save();
    return entry;
  }

  async delay(id, delayMs, now = new Date()) {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }

    entry.nextRunAt = new Date(now.getTime() + delayMs).toISOString();
    await this.#save();
    return entry;
  }

  async #save() {
    const payload = {
      version: this.version,
      entries: this.list(),
      briefingAttempts: this.briefingAttempts,
      usagePausedUntil: this.usagePausedUntil,
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const write = this.saveQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const tempPath = `${this.statePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, serialized, "utf8");
      await fs.rename(tempPath, this.statePath);
    });
    this.saveQueue = write.catch(() => {});
    await write;
  }
}

export function parseScheduleRequest(text, now = new Date()) {
  const trimmed = text.trim();
  const daily = trimmed.match(/^(?:daily|매일)\s+(\d{1,2})(?::(\d{2}))?\s*(?:시|:)?\s+(.+)$/i);
  if (daily) {
    return buildDailySchedule({
      hour: daily[1],
      minute: daily[2] ?? "0",
      prompt: daily[3],
      now,
      weekdaysOnly: false,
    });
  }

  const weekdays = trimmed.match(/^(?:weekdays|평일)\s+(\d{1,2})(?::(\d{2}))?\s*(?:시|:)?\s+(.+)$/i);
  if (weekdays) {
    return buildDailySchedule({
      hour: weekdays[1],
      minute: weekdays[2] ?? "0",
      prompt: weekdays[3],
      now,
      weekdaysOnly: true,
    });
  }

  const recurring = trimmed.match(/^(?:every|마다|매)\s+(\d+)\s*([a-zA-Z가-힣]+)\s+(.+)$/i);
  if (recurring) {
    const intervalMs = parseDuration(recurring[1], recurring[2]);
    if (!intervalMs) {
      return null;
    }

    return {
      intervalMs,
      nextRunAt: new Date(now.getTime() + intervalMs).toISOString(),
      weekdaysOnly: false,
      prompt: recurring[3].trim(),
    };
  }

  const once = trimmed.match(/^(?:in|후)\s+(\d+)\s*([a-zA-Z가-힣]+)\s+(.+)$/i)
    ?? trimmed.match(/^(\d+)\s*([a-zA-Z가-힣]+)\s*(?:후|뒤에)\s+(.+)$/i);
  if (!once) {
    return null;
  }

  const delayMs = parseDuration(once[1], once[2]);
  if (!delayMs) {
    return null;
  }

  return {
    intervalMs: null,
    nextRunAt: new Date(now.getTime() + delayMs).toISOString(),
    weekdaysOnly: false,
    prompt: once[3].trim(),
  };
}

export function parseNaturalScheduleRequest(text, now = new Date()) {
  const value = String(text || "").trim();
  const once = value.match(/^(\d+)\s*(분|시간|일)\s*(?:후|뒤)(?:에)?\s*(.*)$/);
  if (once) {
    const tail = once[3].trim();
    if (!/(?:알려\s*줘|알림\s*해\s*줘|리마인드\s*해\s*줘|보내\s*줘)$/i.test(tail)) return null;
    const delayMs = parseDuration(once[1], once[2]);
    const request = stripNaturalDeliveryWords(tail) || `${once[1]}${once[2]} 전 요청한 알림입니다.`;
    return naturalScheduleResult({ request, nextRunAt: new Date(now.getTime() + delayMs), intervalMs: null, repeatLabel: "없음" });
  }

  const exact = value.match(/^(오늘|내일)\s*(?:(오전|오후)\s*)?(\d{1,2})(?::(\d{2}))?\s*시?(?:에)?\s+(.+)$/i);
  if (exact && hasNaturalDeliveryWords(exact[5])) {
    const clock = parseKoreanClock(exact[2], exact[3], exact[4]);
    if (!clock) return null;
    const nextRunAt = new Date(now);
    nextRunAt.setHours(clock.hour, clock.minute, 0, 0);
    if (exact[1] === "내일") nextRunAt.setDate(nextRunAt.getDate() + 1);
    if (nextRunAt <= now) return null;
    const request = stripNaturalDeliveryWords(exact[5]);
    if (!request) return null;
    return naturalScheduleResult({ request, nextRunAt, intervalMs: null, repeatLabel: "없음" });
  }

  const daily = value.match(/^(매일|평일)\s*(?:(오전|오후)\s*)?(\d{1,2})(?::(\d{2}))?\s*시?(?:에)?\s+(.+)$/i);
  if (daily && hasNaturalDeliveryWords(daily[5])) {
    const clock = parseKoreanClock(daily[2], daily[3], daily[4]);
    if (!clock) return null;
    const request = stripNaturalDeliveryWords(daily[5]);
    if (!request) return null;
    const weekdaysOnly = daily[1] === "평일";
    return naturalScheduleResult({ request, nextRunAt: nextDailyRun(now, clock.hour, clock.minute, weekdaysOnly), intervalMs: 86400000, weekdaysOnly, repeatLabel: daily[1] });
  }

  const weekly = value.match(/^매주\s*(월|화|수|목|금|토|일)요일\s*(?:(오전|오후)\s*)?(\d{1,2})(?::(\d{2}))?\s*시?(?:에)?\s+(.+)$/i);
  if (weekly && hasNaturalDeliveryWords(weekly[5])) {
    const clock = parseKoreanClock(weekly[2], weekly[3], weekly[4]);
    if (!clock) return null;
    const request = stripNaturalDeliveryWords(weekly[5]);
    if (!request) return null;
    const weekday = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 }[weekly[1]];
    return naturalScheduleResult({ request, nextRunAt: nextWeeklyRun(now, weekday, clock.hour, clock.minute), intervalMs: 7 * 86400000, repeatLabel: `매주 ${weekly[1]}요일` });
  }

  return null;
}

function naturalScheduleResult({ request, nextRunAt, intervalMs, weekdaysOnly = false, repeatLabel }) {
  const requiresAi = /(?:AI|인공지능|뉴스|스크랩|요약|조사|검색|찾아|브리핑|동향|릴리스|업데이트)/i.test(request);
  const prompt = requiresAi
    ? `[AI_WORKMATE_NATURAL_SCHEDULE]\n예약된 요청입니다. 실행 시점의 최신 정보를 필요한 경우 웹에서 확인하고, 한국어로 간결하게 결과만 작성하세요. 사실 확인이 필요한 내용에는 원문 링크를 포함하세요. 외부 상태는 변경하지 마세요.\n요청: ${request}`
    : `[AI_WORKMATE_REMINDER]\n${request}`;
  return { intervalMs, nextRunAt: nextRunAt.toISOString(), weekdaysOnly, prompt, kind: requiresAi ? "ai" : "reminder", request, repeatLabel };
}

function hasNaturalDeliveryWords(value) {
  return /(?:알려\s*줘|알림\s*해\s*줘|리마인드\s*해\s*줘|보내\s*줘|해\s*줘)$/i.test(String(value || ""));
}

function parseKoreanClock(period, hourText, minuteText) {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  if (period === "오후" && hour < 12) hour += 12;
  if (period === "오전" && hour === 12) hour = 0;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

function nextWeeklyRun(now, weekday, hour, minute) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  let days = (weekday - next.getDay() + 7) % 7;
  if (days === 0 && next <= now) days = 7;
  next.setDate(next.getDate() + days);
  return next;
}

function stripNaturalDeliveryWords(value) {
  return String(value || "")
    .replace(/\s*(?:알려\s*줘|알림\s*해\s*줘|리마인드\s*해\s*줘|보내\s*줘)$/i, "")
    .trim();
}

function buildDailySchedule({ hour, minute, prompt, now, weekdaysOnly }) {
  const parsedHour = Number.parseInt(hour, 10);
  const parsedMinute = Number.parseInt(minute, 10);
  if (
    !Number.isInteger(parsedHour) ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    !Number.isInteger(parsedMinute) ||
    parsedMinute < 0 ||
    parsedMinute > 59
  ) {
    return null;
  }

  return {
    intervalMs: 24 * 60 * 60 * 1000,
    nextRunAt: nextDailyRun(now, parsedHour, parsedMinute, weekdaysOnly).toISOString(),
    weekdaysOnly,
    prompt: prompt.trim(),
  };
}

function computeNextRunAt(entry, now) {
  if (entry.intervalMs === 24 * 60 * 60 * 1000) {
    const previous = new Date(entry.nextRunAt);
    return nextDailyRun(now, previous.getHours(), previous.getMinutes(), entry.weekdaysOnly);
  }

  return new Date(now.getTime() + entry.intervalMs);
}

function nextDailyRun(now, hour, minute, weekdaysOnly) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  while (weekdaysOnly && (next.getDay() === 0 || next.getDay() === 6)) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

function parseDuration(amountText, unitText) {
  const amount = Number.parseInt(amountText, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    return null;
  }

  const unit = unitText.toLowerCase();
  if (["m", "min", "mins", "minute", "minutes", "분"].includes(unit)) {
    return amount * 60 * 1000;
  }

  if (["h", "hr", "hrs", "hour", "hours", "시간"].includes(unit)) {
    return amount * 60 * 60 * 1000;
  }

  if (["d", "day", "days", "일"].includes(unit)) {
    return amount * 24 * 60 * 60 * 1000;
  }

  return null;
}

function normalizeEntry(entry) {
  return {
    id: entry.id,
    chatId: String(entry.chatId),
    userId: String(entry.userId),
    workspaceAlias: entry.workspaceAlias,
    prompt: entry.prompt,
    nextRunAt: entry.nextRunAt,
    intervalMs: entry.intervalMs,
    weekdaysOnly: Boolean(entry.weekdaysOnly),
    failureCount: Number.isInteger(entry.failureCount) ? entry.failureCount : 0,
    lastError: typeof entry.lastError === "string" ? entry.lastError : null,
    createdAt: entry.createdAt,
  };
}

function isValidEntry(entry) {
  return (
    entry &&
    typeof entry.id === "string" &&
    entry.id.trim() &&
    typeof entry.chatId === "string" &&
    entry.chatId.trim() &&
    typeof entry.userId === "string" &&
    entry.userId.trim() &&
    typeof entry.workspaceAlias === "string" &&
    entry.workspaceAlias.trim() &&
    typeof entry.prompt === "string" &&
    entry.prompt.trim() &&
    typeof entry.nextRunAt === "string" &&
    !Number.isNaN(Date.parse(entry.nextRunAt)) &&
    (entry.intervalMs === null || (Number.isInteger(entry.intervalMs) && entry.intervalMs > 0)) &&
    (entry.weekdaysOnly === undefined || typeof entry.weekdaysOnly === "boolean") &&
    (entry.failureCount === undefined || (Number.isInteger(entry.failureCount) && entry.failureCount >= 0)) &&
    (entry.lastError === undefined || entry.lastError === null || typeof entry.lastError === "string") &&
    typeof entry.createdAt === "string" &&
    entry.createdAt.trim()
  );
}
