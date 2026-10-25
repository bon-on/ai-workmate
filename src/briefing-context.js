import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildHealthReport } from "./health.js";
import { N8nManager } from "./n8n-manager.js";
import { TradingManager } from "./trading-manager.js";
import { buildDayProfile } from "./day-profile.js";

const execFileAsync = promisify(execFile);

export async function decorateScheduledPrompt(prompt, context) {
  if (!/^\[AI_WORKMATE_(?:MORNING_BRIEF|EVENING_BRIEF|WEEKLY_REVIEW|AI_TREND_BRIEF|DAILY_DISCOVERY)_V1\]/.test(prompt)) return prompt;
  if (prompt.startsWith("[AI_WORKMATE_AI_TREND_BRIEF_V1]")) {
    // News research needs a date and what was already sent, not personal calendars,
    // weather, inbox or weeks of unrelated recommendations (nor their slow collection).
    return `${prompt}\n\n${buildAiTrendContext(context)}`;
  }
  const snapshot = await buildBriefingContext({
    ...context,
    includeSystem: false,
    includeTrading: prompt.startsWith("[AI_WORKMATE_EVENING_BRIEF_V1]")
      || prompt.startsWith("[AI_WORKMATE_WEEKLY_REVIEW_V1]"),
  });
  return `${prompt}\n\n다음은 실행 시점에 수집한 로컬 컨텍스트입니다. 이 데이터를 우선 근거로 사용하세요.\n${JSON.stringify(snapshot, null, 2)}`;
}

export function buildAiTrendContext({ personalOps, chatId, now = new Date() }) {
  const lines = [`기준 시각: ${now.toISOString()} (시간대: Asia/Seoul)`];
  const sent = personalOps?.listTrendTopics?.(chatId, { days: 14, now }) ?? [];
  if (sent.length) {
    lines.push("", "최근 14일 동안 이미 보낸 항목입니다. 같은 사건, 같은 발표의 후속 요약, 같은 URL은 다시 고르지 마세요:");
    for (const row of sent.slice(-30)) lines.push(`- ${row.sentAt.slice(0, 10)} ${row.title}${row.url ? ` (${row.url})` : ""}`);
  }
  return lines.join("\n");
}

export async function buildBriefingContext({ config, chatId, personalOps, schedules, now = new Date(), includeSystem = true, includeTrading = true }) {
  const [health, calendar, weather, n8n, trading] = await Promise.all([
    includeSystem ? buildHealthReport(config) : Promise.resolve(null),
    readAppleCalendar(now),
    readWeather(config),
    includeSystem ? safely(() => new N8nManager({ port: config.n8nPort }).overview()) : Promise.resolve(null),
    includeTrading ? safely(() => new TradingManager({ port: config.tradingDashboardPort }).overview()) : Promise.resolve(null),
  ]);
  const dayProfile = await buildDayProfile({ now, calendar });
  return {
    generatedAt: now.toISOString(),
    dayProfile,
    ...(includeSystem ? { health } : {}),
    calendar,
    weather,
    personal: {
      summary: personalOps?.summary?.(chatId) ?? null,
      inbox: (personalOps?.listInbox?.(chatId) ?? []).slice(0, 30).map((row) => ({ ...row, waitingDays: waitingDays(row.createdAt, now) })),
      activity: personalOps?.activitySummary?.(chatId, { days: 7, now }) ?? null,
      preferences: (personalOps?.listPreferences?.(chatId) ?? []).slice(0, 30),
      watches: compactWatches(personalOps?.listWatches?.(chatId) ?? []),
      // currentFailureStreak resets on success; recentRunIssues keeps the past 7 days of failed/late runs.
      schedules: (schedules?.list?.(chatId) ?? []).map((row) => ({ id: row.id, nextRunAt: row.nextRunAt, currentFailureStreak: row.failureCount, label: row.prompt.split("\n")[0] })).slice(0, 20),
      recentRunIssues: personalOps?.listRunIssues?.(chatId, { days: 7, now }) ?? [],
      recentBriefings: (personalOps?.listBriefingHistory?.(chatId, { days: 30, limit: 20, now }) ?? []).map((row) => ({
        id: row.id,
        kind: row.kind,
        sentAt: row.sentAt,
        feedback: row.feedback,
        recommendations: row.recommendations.map((text, index) => ({
          text,
          feedback: row.recommendationFeedback?.[index] ?? row.feedback,
        })),
      })),
    },
    ...(includeSystem ? { n8n } : {}),
    ...(includeTrading ? { trading } : {}),
  };
}

export async function readAppleCalendar(now, { execFileImpl = execFileAsync } = {}) {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const dayAfterStart = new Date(tomorrowStart);
  dayAfterStart.setDate(dayAfterStart.getDate() + 1);
  try {
    await execFileImpl("open", ["-gja", "/System/Applications/Calendar.app"], { timeout: 8000 });
  } catch {}
  const script = `
set todayStart to current date
set hours of todayStart to 0
set minutes of todayStart to 0
set seconds of todayStart to 0
set tomorrowStart to todayStart + (1 * days)
set dayAfterStart to todayStart + (2 * days)
set output to ""
tell application id "com.apple.iCal"
  repeat with cal in calendars
    repeat with ev in (every event of cal whose start date is less than dayAfterStart and end date is greater than todayStart)
      if (start date of ev) is less than tomorrowStart and (end date of ev) is greater than todayStart then
        set output to output & "today|||" & (summary of ev) & "|||" & ((start date of ev) as string) & "|||" & ((end date of ev) as string) & "|||" & ((allday event of ev) as string) & "|||" & (name of cal) & linefeed
      end if
      if (start date of ev) is less than dayAfterStart and (end date of ev) is greater than tomorrowStart then
        set output to output & "tomorrow|||" & (summary of ev) & "|||" & ((start date of ev) as string) & "|||" & ((end date of ev) as string) & "|||" & ((allday event of ev) as string) & "|||" & (name of cal) & linefeed
      end if
    end repeat
  end repeat
end tell
return output`;
  try {
    const { stdout } = await execFileImpl("osascript", ["-e", script], { timeout: 30000, maxBuffer: 256 * 1024 });
    const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(parseCalendarLine).filter(Boolean).slice(0, 80);
    const sorted = events.sort(compareCalendarEvents);
    return {
      ok: true,
      todayStart: todayStart.toISOString(),
      tomorrowStart: tomorrowStart.toISOString(),
      dayAfterStart: dayAfterStart.toISOString(),
      today: sorted.filter((event) => event.bucket === "today"),
      tomorrow: sorted.filter((event) => event.bucket === "tomorrow"),
    };
  } catch (error) {
    return { ok: false, error: String(error.message).slice(0, 300) };
  }
}

function parseCalendarLine(line) {
  const [bucket, summary, start, end, allDay, calendar] = line.split("|||");
  if (!bucket || !summary || !start) return null;
  return { bucket, summary, start, end, allDay: allDay === "true", calendar };
}

function compareCalendarEvents(left, right) {
  if (left.bucket !== right.bucket) return left.bucket.localeCompare(right.bucket);
  if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
  const leftTime = Date.parse(left.start);
  const rightTime = Date.parse(right.start);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return String(left.start).localeCompare(String(right.start), "ko");
}

const WEATHER_RETRY_DELAYS_MS = [3000, 10000];

// Morning network hiccups are common on this host; retry before giving up and log the cause.
export async function readWeather(config, fetchImpl = fetch, { retryDelaysMs = WEATHER_RETRY_DELAYS_MS } = {}) {
  let result = await readWeatherOnce(config, fetchImpl);
  for (const delay of retryDelaysMs) {
    if (result.ok || result.error === "Weather coordinates are not configured") break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = await readWeatherOnce(config, fetchImpl);
  }
  if (!result.ok) console.error(`Weather fetch failed after retries: ${result.error}`);
  return result;
}

async function readWeatherOnce(config, fetchImpl) {
  const latitude = config.weatherLatitude;
  const longitude = config.weatherLongitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: "Weather coordinates are not configured" };
  }
  const query = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude), timezone: "Asia/Seoul", forecast_days: "2",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    hourly: "precipitation_probability",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
  });
  try {
    const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Weather API HTTP ${response.status}`);
    const data = await response.json();
    const nowIndex = data.hourly?.time?.findIndex((time) => time >= data.current?.time) ?? -1;
    const upcomingRain = nowIndex >= 0
      ? data.hourly.precipitation_probability.slice(nowIndex, nowIndex + 18)
      : [];
    return {
      ok: true, location: config.personalLocation, provider: "Open-Meteo",
      timezone: data.timezone, currentUnits: data.current_units, current: data.current,
      dailyUnits: data.daily_units, daily: data.daily,
      maxPrecipitationProbabilityNext18Hours: upcomingRain.length ? Math.max(...upcomingRain) : null,
    };
  } catch (error) {
    return { ok: false, location: config.personalLocation, provider: "Open-Meteo", error: String(error.message).slice(0, 300) };
  }
}

function waitingDays(createdAt, now) {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / 86400000)) : null;
}

async function safely(run) {
  try { return { ok: true, data: await run() }; }
  catch (error) { return { ok: false, error: String(error.message).slice(0, 300) }; }
}

// Only metadata: scraped page text (snapshots, excerpts) is untrusted and large, so it never reaches AI prompts.
export function compactWatches(rows) {
  return rows.slice(0, 30).map((row) => ({
    id: row.id, label: row.label, url: row.url, lastChangedAt: row.lastChangedAt ?? null, failureCount: row.failureCount ?? 0,
  }));
}
