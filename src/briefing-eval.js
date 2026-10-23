const MARKERS = {
  morning: ["🌦 날씨", "📅 일정"],
  evening: ["📈 Trading dry-run", "📅 내일 일정"],
  weekly: ["🏁 이번 주", "🎯 다음 주 핵심"],
  aiTrend: ["🤖 AI 트렌드", "🧪 오늘의 15분 실험"],
};

// Code-generated status sections repeat daily by design; they are not AI recommendations.
const STATUS_SECTIONS = ["🧰 저장소 점검", "🤖 AI 작업 · "];

export function evaluateBriefing({ kind, text, recentRecommendations = [] }) {
  const output = stripStatusSections(String(text || "")).trim();
  const issues = [];
  if (!output) issues.push("empty");
  if (output.length > (kind === "weekly" ? 1800 : kind === "aiTrend" ? 2200 : 1300)) issues.push("too-long");
  if (/^#{1,6}\s/m.test(output) || /\*\*|```/.test(output)) issues.push("markdown-noise");
  for (const marker of MARKERS[kind] || []) if (!output.includes(marker)) issues.push(`missing:${marker}`);
  if (/통화 단위 미제공/.test(output)) issues.push("unknown-currency");
  const recommendations = extractRecommendationLines(output);
  const duplicateCount = recommendations.filter((line) => recentRecommendations.some((past) => similarity(line, past) >= 0.7)).length;
  if (duplicateCount) issues.push("repeated-recommendation");
  return {
    valid: issues.length === 0,
    score: Math.max(0, 100 - issues.length * 20),
    issues,
    length: output.length,
    recommendationCount: recommendations.length,
    duplicateCount,
  };
}

export function evaluateBriefingHistory(rows = []) {
  const ordered = [...rows].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const recent = [];
  const results = ordered.map((row) => {
    const result = evaluateBriefing({ kind: row.kind, text: row.text, recentRecommendations: recent.slice(-30) });
    recent.push(...(row.recommendations || []));
    return result;
  });
  return {
    samples: results.length,
    averageScore: results.length ? Math.round(results.reduce((sum, row) => sum + row.score, 0) / results.length) : null,
    failures: results.filter((row) => !row.valid).length,
    duplicateRecommendations: results.reduce((sum, row) => sum + row.duplicateCount, 0),
  };
}

function stripStatusSections(text) {
  const kept = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (STATUS_SECTIONS.some((heading) => line.trim().startsWith(heading))) { skipping = true; continue; }
    if (skipping && !line.trim()) { skipping = false; continue; }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

function extractRecommendationLines(text) {
  return String(text).split(/\r?\n/)
    .map((line) => line.replace(/^\s*[•*-]\s*/, "").trim())
    .filter((line) => line.length >= 10)
    .filter((line) => !/^(현재|내일)?\s*(맑음|흐림|비|눈|구름)|당일 손익|실험 \S+ ·|종일|\d{1,2}:\d{2}/.test(line));
}

function similarity(left, right) {
  const a = new Set(String(left).match(/[가-힣a-zA-Z0-9]{2,}/g) || []);
  const b = new Set(String(right).match(/[가-힣a-zA-Z0-9]{2,}/g) || []);
  if (!a.size || !b.size) return 0;
  return [...a].filter((word) => b.has(word)).length / new Set([...a, ...b]).size;
}
