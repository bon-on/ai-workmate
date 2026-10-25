// Human-readable schedule labels shared by Telegram replies, alerts and the dashboard API.

const KST = "Asia/Seoul";

export function scheduleName(prompt) {
  const value = String(prompt || "");
  if (value.includes("MORNING_BRIEF")) return "모닝 브리핑";
  if (value.includes("EVENING_BRIEF")) return "이브닝 브리핑";
  if (value.includes("WEEKLY_REVIEW")) return "주간 리뷰";
  if (value.includes("AI_TREND_BRIEF")) return "AI 트렌드";
  if (value.includes("ENGLISH_STUDY")) return "영어 학습";
  if (value.includes("AI_WORKMATE_REMINDER")) return `개인 알림 · ${value.replace(/^\[AI_WORKMATE_REMINDER\]\s*/, "").slice(0, 42)}`;
  if (value.includes("AI_WORKMATE_NATURAL_SCHEDULE")) {
    const request = value.match(/요청:\s*([^\n]+)/)?.[1] || "예약된 AI 작업";
    return `AI 예약 · ${request.slice(0, 42)}`;
  }
  return value.replace(/^\[[^\]]+\]\s*/, "").split("\n")[0].slice(0, 60) || "예약 작업";
}

export function scheduleRepeatLabel(entry = {}) {
  const ms = Number(entry.intervalMs) || 0;
  if (!ms) return "한 번";
  const day = 24 * 60 * 60 * 1000;
  const time = entry.nextRunAt ? formatKstClock(entry.nextRunAt) : "";
  const at = time ? ` ${time}` : "";
  if (ms === day) return entry.weekdaysOnly ? `평일${at}` : `매일${at}`;
  if (ms === 7 * day) return `매주${at}`;
  if (ms % day === 0) return `${ms / day}일마다`;
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}시간마다`;
  return `${Math.round(ms / 60000)}분마다`;
}

export function formatKst(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

export function formatKstClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: KST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}
