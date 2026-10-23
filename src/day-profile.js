let holidayCache = { year: null, expiresAt: 0, dates: new Map() };

export async function buildDayProfile({ now = new Date(), calendar = null, fetchImpl = fetch } = {}) {
  const parts = seoulDateParts(now);
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(now);
  const weekend = weekday === "Sat" || weekday === "Sun";
  const leaveEvent = [...(calendar?.today || [])].find((event) => /(휴가|연차|반차|휴무|off)/i.test(event.summary || ""));
  const holidays = await fetchKoreanHolidays(parts.year, fetchImpl);
  const holidayName = holidays.get(date) || null;
  return { date, weekday, mode: holidayName || leaveEvent ? "holiday" : weekend ? "weekend" : "weekday", holidayName, leaveEvent: leaveEvent?.summary || null };
}

async function fetchKoreanHolidays(year, fetchImpl) {
  if (holidayCache.year === year && holidayCache.expiresAt > Date.now()) return holidayCache.dates;
  try {
    const response = await fetchImpl(`https://date.nager.at/api/v3/PublicHolidays/${year}/KR`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`holiday HTTP ${response.status}`);
    const rows = await response.json();
    const dates = new Map(rows.map((row) => [row.date, row.localName || row.name]));
    holidayCache = { year, expiresAt: Date.now() + 24 * 60 * 60 * 1000, dates };
    return dates;
  } catch { return new Map(); }
}

function seoulDateParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function pad(value) { return String(value).padStart(2, "0"); }
