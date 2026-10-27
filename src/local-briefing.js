import { buildBriefingContext } from "./briefing-context.js";
import { repoCheckBriefingDelta } from "./repo-checks.js";
import { formatKstClock } from "./schedule-names.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LATE_AFTER_MS = 10 * 60 * 1000;
const DUE_SOON_MS = 2 * DAY_MS;

const WEATHER = new Map([
  [0, "맑음"], [1, "대체로 맑음"], [2, "구름 조금"], [3, "흐림"],
  [45, "안개"], [48, "안개"], [51, "약한 이슬비"], [53, "이슬비"], [55, "강한 이슬비"],
  [61, "약한 비"], [63, "비"], [65, "강한 비"], [71, "약한 눈"], [73, "눈"], [75, "강한 눈"],
  [80, "소나기"], [81, "소나기"], [82, "강한 소나기"], [95, "뇌우"], [96, "우박 동반 뇌우"], [99, "강한 우박 동반 뇌우"],
]);

// Returns { summary, replyMarkup } when the morning focus item gets inline buttons, otherwise a string.
export async function buildLocalBriefing({ kind, config, chatId, personalOps, schedules, now = new Date(), fetchImpl = fetch }) {
  const snapshot = await buildBriefingContext({
    config, chatId, personalOps, schedules, now,
    includeSystem: false,
    includeTrading: kind === "evening",
  });
  const recommendations = await generateLocalRecommendations({ kind, snapshot, config, fetchImpl, now });
  if (kind !== "morning") return formatEvening(snapshot, recommendations, now);
  // The full open list, not the newest-30 context slice, so old items can surface.
  const focus = pickFocusItem(personalOps?.listInbox?.(chatId, { now }) ?? snapshot.personal?.inbox, now);
  const summary = formatMorning(snapshot, recommendations, now, await morningRepoLines(personalOps, now), { focus });
  return focus ? { summary, replyMarkup: inboxFocusMarkup(focus.id) } : summary;
}

// Repo-check lines not yet briefed. Marked before sending: a failed send drops them
// from later briefings, but /repos and the dashboard still show them.
export async function morningRepoLines(personalOps, now = new Date()) {
  const repo = repoCheckBriefingDelta(personalOps?.getRepoChecks?.(), personalOps?.getRepoChecksBriefed?.(), { now });
  if (repo.state) {
    try { await personalOps.setRepoChecksBriefed?.(repo.state); }
    catch (error) { console.error("Repo check briefing state save failed:", error.message); }
  }
  return repo.lines;
}

// Overdue or due within two days first (earliest due), then the oldest open item.
export function pickFocusItem(rows = [], now = new Date()) {
  const open = (rows || []).filter((row) => row && (!row.status || row.status === "open") && row.type !== "journal");
  if (!open.length) return null;
  const dueSoon = open.filter((row) => Date.parse(row.dueAt) <= now.getTime() + DUE_SOON_MS)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  if (dueSoon.length) return dueSoon[0];
  return [...open].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))[0];
}

export function inboxFocusMarkup(id) {
  return { inline_keyboard: [[
    { text: "✅ 완료", callback_data: `inbox:done:${id}` },
    { text: "⏰ 내일 다시", callback_data: `inbox:later:${id}` },
  ]] };
}

// "N일째 · 마감 M/D" style annotation for an open inbox item.
export function inboxAgeLabel(row, now = new Date()) {
  const parts = [];
  const created = Date.parse(row?.createdAt);
  if (Number.isFinite(created)) parts.push(`${Math.max(1, Math.floor((kstDayStart(now) - kstDayStart(new Date(created))) / DAY_MS) + 1)}일째`);
  const due = Date.parse(row?.dueAt);
  if (Number.isFinite(due)) {
    const label = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(new Date(due));
    parts.push(`${due < kstDayStart(now) ? "마감 지남" : "마감"} ${label}`);
  }
  return parts.join(" · ");
}

export function applyLatePrefix(text, scheduledAt, now = new Date()) {
  const value = String(text ?? "");
  const scheduled = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduled) || now.getTime() - scheduled <= LATE_AFTER_MS) return { text: value, late: false };
  return { text: `⏰ 지연 발송 (원래 ${formatKstClock(scheduled)})\n${value}`, late: true };
}

function kstDayStart(date) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(date);
  return Date.parse(`${day}T00:00:00+09:00`);
}

function inboxLine(row, now, suffix = "") {
  const age = inboxAgeLabel(row, now);
  return `${row.text}${age ? ` (${age})` : ""}${suffix}`;
}

export async function generateLocalRecommendations({ kind, snapshot, config, fetchImpl = fetch, now = new Date() }) {
  const count = kind === "morning" ? 2 : 3;
  const recent = (snapshot.personal?.recentBriefings || [])
    .flatMap((row) => row.recommendations || [])
    .map((row) => typeof row === "string" ? row : row.text)
    .filter(Boolean)
    .slice(0, 20);
  const prompt = [
    "한국어 개인 비서입니다. 설명이나 제목 없이 실행 행동만 한 줄씩 출력하세요.",
    `${count}개 이하로 작성하고 각 줄은 '• '로 시작하세요.`,
    "서로 다른 분야를 고르고, 10~30분 안에 할 수 있는 구체적인 행동과 완료 기준을 넣으세요.",
    "생활 모드가 weekday면 이동이 필요한 장소를 피하고, weekend 또는 holiday면 여유가 필요한 활동도 후보로 고려하세요. 뻔한 걷기·독서·안부 연락을 반복하지 마세요.",
    "최근 추천과 의미상 같은 행동은 제외하세요.",
    `시점: ${now.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    `종류: ${kind}`,
    `생활 모드: ${JSON.stringify(snapshot.dayProfile || {})}`,
    `날씨: ${JSON.stringify(compactWeather(snapshot.weather, kind === "morning" ? 0 : 1))}`,
    `열린 inbox: ${JSON.stringify(snapshot.personal?.inbox?.slice(0, 5) || [])}`,
    `일정: ${JSON.stringify(kind === "morning" ? snapshot.calendar?.today : snapshot.calendar?.tomorrow)}`,
    `최근 추천: ${JSON.stringify(recent)}`,
    `사용자 선호: ${JSON.stringify(snapshot.personal?.preferences || [])}`,
  ].join("\n");
  try {
    const response = await fetchImpl(`http://127.0.0.1:${config.ollamaPort || 11434}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.localBriefingModel || "qwen3.5:latest", prompt, stream: false, think: false, options: { temperature: 0.7, num_predict: 220 } }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const body = await response.json();
    const lines = String(body.response || "").split(/\r?\n/)
      .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter(Boolean)
      .filter((line) => !recent.some((past) => overlap(line, past) > 0.7))
      .slice(0, count);
    if (lines.length) return lines;
  } catch {}
  return fallbackRecommendations(kind, now, recent).slice(0, count);
}

function compactWeather(weather, dayIndex) {
  if (!weather?.ok) return { available: false };
  return {
    available: true,
    condition: WEATHER.get(weather.daily?.weather_code?.[dayIndex]) || "날씨 변화",
    minC: number(weather.daily?.temperature_2m_min?.[dayIndex]),
    maxC: number(weather.daily?.temperature_2m_max?.[dayIndex]),
    rainPercent: number(weather.daily?.precipitation_probability_max?.[dayIndex], 0),
  };
}

export function formatMorning(snapshot, recommendations, now, repoLines = [], { focus = pickFocusItem(snapshot.personal?.inbox, now) } = {}) {
  const lines = [`☀️ 모닝 브리핑 · ${dateLabel(now)}`, "", "🌦 날씨", ...weatherLines(snapshot.weather, 0)];
  lines.push("", "📅 일정", ...calendarLines(snapshot.calendar?.today, "오늘 등록된 일정 없음"));
  if (focus) lines.push("", "🎯 오늘의 초점", `• ${inboxLine(focus, now, " — 첫 10분에 시작할 단계 하나를 끝내세요.")}`);
  if (repoLines.length) lines.push("", "🧰 저장소 점검", ...repoLines);
  if (recommendations.length) lines.push("", "💡 오늘의 추천", ...recommendations.map((row) => `• ${row}`));
  return lines.join("\n");
}

function formatEvening(snapshot, recommendations, now) {
  const lines = [`🌙 이브닝 브리핑 · ${dateLabel(now)}`];
  const inbox = snapshot.personal?.inbox || [];
  const completed = snapshot.personal?.activity?.completedItems || [];
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const completedToday = completed.filter((row) => Date.parse(row.updatedAt) >= dayStart.getTime()).slice(0, 2);
  const wrapUp = [
    ...completedToday.map((row) => `• 완료 · ${row.text}`),
    ...inbox.slice(0, Math.max(0, 3 - completedToday.length)).map((row) => `• 미완료 · ${inboxLine(row, now)}`),
  ];
  if (wrapUp.length) lines.push("", "✅ 오늘 정리", ...wrapUp);
  lines.push("", "📈 Trading dry-run", ...tradingLines(snapshot.trading));
  lines.push("", "📅 내일 일정", ...calendarLines(snapshot.calendar?.tomorrow, "내일 등록된 일정 없음"));
  const tomorrowWeather = weatherLines(snapshot.weather, 1);
  if (tomorrowWeather.length) lines.push(`• 내일 ${tomorrowWeather[0].replace(/^•\s*/, "")}`);
  if (recommendations.length) lines.push("", "🧭 내일과 가까운 시일의 제안", ...recommendations.map((row) => `• ${row}`));
  return lines.join("\n");
}

function weatherLines(weather, dayIndex) {
  if (!weather?.ok) return ["• 날씨 정보를 가져오지 못했습니다."];
  const daily = weather.daily || {};
  const max = number(daily.temperature_2m_max?.[dayIndex]);
  const min = number(daily.temperature_2m_min?.[dayIndex]);
  const rain = number(daily.precipitation_probability_max?.[dayIndex], 0);
  const condition = WEATHER.get(daily.weather_code?.[dayIndex]) || "날씨 변화";
  if (dayIndex > 0) return [`• ${condition}, 최저 ${min}°C / 최고 ${max}°C, 강수 확률 ${rain}%`];
  const current = weather.current || {};
  const advice = rain >= 50 ? "우산을 챙기세요." : max - min >= 8 ? "일교차에 맞춰 벗기 쉬운 겉옷을 준비하세요." : "예보상 특별한 외출 준비는 필요하지 않습니다.";
  return [
    `• 하늘: ${condition}`,
    `• 현재: ${number(current.temperature_2m)}°C (체감 ${number(current.apparent_temperature)}°C)`,
    `• 최고/최저: ${max}°C / ${min}°C`,
    `• 강수 확률: ${rain}%`,
    `• ${advice}`,
  ];
}

function calendarLines(events, emptyText) {
  if (!Array.isArray(events) || !events.length) return [`• ${emptyText}`];
  return events.slice(0, 3).map((event) => `• ${event.allDay ? "종일" : event.start} · ${event.summary}`);
}

export function tradingLines(trading) {
  if (!trading?.ok) return ["• 결과를 가져오지 못했습니다."];
  const row = trading.data || {};
  const forward = (row.forwardTrades || []).map((arm) =>
    `• 실험 ${arm.arm} · ${arm.trades}건 (${arm.wins}승 ${arm.losses}패), 손익 ${won(arm.pnl)}원`);
  const main = !row.pnl && !row.orders && !row.positions
    ? (forward.length ? [] : ["• 변화 없음"])
    : [`• 당일 손익 ${won(row.pnl)}원, 주문 ${row.orders || 0}건, 현재 보유 포지션 ${row.positions || 0}개`];
  return [...main, ...forward];
}

function won(value) {
  return Math.round(Number(value || 0)).toLocaleString("ko-KR");
}

function fallbackRecommendations(kind, now, recent) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(now);
  const pool = kind === "morning" ? [
    "오늘 반복할 작업 하나를 골라 입력·출력 예시를 한 쌍 적어 자동화 후보로 남기세요. 완료 기준은 예시 저장입니다.",
    "업무 시작 전에 가장 오래 열린 브라우저 탭 다섯 개만 닫거나 북마크하세요. 10분이면 충분합니다.",
    "자주 쓰는 셸 명령 하나에 별칭이나 함수를 만들기 전에 사용 사례 세 가지를 메모하세요.",
    "오늘 작성할 코드에서 실패 가능성이 큰 경로 하나를 먼저 테스트로 고정하세요.",
  ] : [
    "내일 첫 업무의 문서나 저장소를 열어 두고 첫 커밋의 완료 조건을 한 문장으로 적으세요.",
    "이번 주 반복된 수작업 하나의 단계와 소요 시간을 기록해 다음 자동화 대상을 정하세요.",
    "맥미니에서 최근 7일간 쌓인 다운로드 파일을 종류별로 확인하고 삭제 대신 정리 규칙 하나만 정하세요.",
    `${weekday === "Fri" || weekday === "Sat" ? "주말에" : "이번 주말 후보로"} 가족과 함께 할 활동 하나를 20분 동안만 찾아 후보 목록에 저장하세요.`,
  ];
  return pool.filter((item) => !recent.some((past) => overlap(item, past) > 0.7));
}

function overlap(left, right) {
  const a = new Set(String(left).match(/[가-힣a-zA-Z0-9]{2,}/g) || []);
  const b = new Set(String(right).match(/[가-힣a-zA-Z0-9]{2,}/g) || []);
  if (!a.size || !b.size) return 0;
  return [...a].filter((value) => b.has(value)).length / new Set([...a, ...b]).size;
}

function number(value, fallback = "-") {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : fallback;
}

function dateLabel(now) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "long" }).format(now);
}
