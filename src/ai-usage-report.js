// Deterministic AI job usage report from stored run metrics. It measures volume,
// fallbacks and failures; it does not judge whether results were good.

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildAiUsageReport({ personalOps, chatId, days = 7, now = new Date(), claudeLimits = null }) {
  const rows = personalOps?.listRunMetrics?.(chatId, { days, now }) ?? [];
  const report = {
    days,
    jobs: rows.length,
    bySource: { claude: 0, codex: 0, local: 0 },
    fallbacks: 0,
    fallbackReasons: {},
    failures: 0,
    qualityRetries: 0,
    tokens: { input: 0, cached: 0, output: 0, claude: 0, codex: 0 },
    heaviest: [],
    claudeLimits: claudeLimits?.snapshot?.() ?? null,
  };
  for (const row of rows) {
    report.bySource[row.source] = (report.bySource[row.source] || 0) + 1;
    if (row.status !== "completed") report.failures += 1;
    if (row.qualityRejected) report.qualityRetries += 1;
    if (row.source === "codex" && row.fallbackReason) {
      report.fallbacks += 1;
      const reason = String(row.fallbackReason).replace(/\s*\(.*$/, "").slice(0, 60);
      report.fallbackReasons[reason] = (report.fallbackReasons[reason] || 0) + 1;
    }
    const total = Number(row.inputTokens || 0) + Number(row.outputTokens || 0);
    report.tokens.input += Number(row.inputTokens || 0);
    report.tokens.cached += Number(row.cachedInputTokens || 0);
    report.tokens.output += Number(row.outputTokens || 0);
    if (row.source === "claude" || row.source === "codex") report.tokens[row.source] += total;
    if (total > 0) report.heaviest.push({ title: row.title || row.kind || row.id, source: row.source, tokens: total });
  }
  report.heaviest = report.heaviest.sort((a, b) => b.tokens - a.tokens).slice(0, 2);
  return report;
}

export function formatAiUsageReport(report) {
  const lines = [`🤖 AI 작업 · 최근 ${report.days}일`];
  if (!report.jobs) {
    lines.push("• 기록된 작업 없음");
  } else {
    lines.push(`• 전체 ${report.jobs}건: Claude ${report.bySource.claude} · Codex ${report.bySource.codex}${report.fallbacks ? ` (폴백 ${report.fallbacks})` : ""} · 로컬 ${report.bySource.local} · 실패 ${report.failures}`);
    const reasons = Object.entries(report.fallbackReasons).sort((a, b) => b[1] - a[1]);
    if (reasons.length) lines.push(`• 폴백 이유: ${reasons.slice(0, 3).map(([reason, count]) => `${reason} ${count}`).join(", ")}`);
    if (report.qualityRetries) lines.push(`• 브리핑 품질 재시도 ${report.qualityRetries}건`);
    lines.push(`• 토큰: 입력 ${compact(report.tokens.input)} (캐시 ${compact(report.tokens.cached)}) · 출력 ${compact(report.tokens.output)} — Claude ${compact(report.tokens.claude)} / Codex ${compact(report.tokens.codex)}`);
    for (const row of report.heaviest) lines.push(`• 많이 쓴 작업: ${row.title.slice(0, 40)} · ${row.source} ${compact(row.tokens)}`);
  }
  const limits = report.claudeLimits;
  if (limits?.fiveHour || limits?.weekly) {
    lines.push(`• Claude 한도 사용: 5시간 ${limits.fiveHour?.usedPercent ?? "-"}% · 7일 ${limits.weekly?.usedPercent ?? "-"}%`);
  }
  lines.push("• 작업량 집계이며 결과 품질 평가는 아닙니다.");
  return lines.join("\n");
}

export function filterRecentMetrics(rows, chatId, { days, now }) {
  const cutoff = now.getTime() - days * DAY_MS;
  return rows.filter((row) => row.chatId === String(chatId) && Date.parse(row.finishedAt) >= cutoff);
}

function compact(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}
