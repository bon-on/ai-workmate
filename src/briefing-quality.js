const PERSONAL_BRIEFING_MARKERS = {
  morning: "[AI_WORKMATE_MORNING_BRIEF_V1]",
  evening: "[AI_WORKMATE_EVENING_BRIEF_V1]",
  weekly: "[AI_WORKMATE_WEEKLY_REVIEW_V1]",
  aiTrend: "[AI_WORKMATE_AI_TREND_BRIEF_V1]",
};

const RECOMMENDATION_HEADINGS = [
  "💡 오늘의 추천",
  "🧭 내일과 가까운 시일의 제안",
  "💡 다음 주 추천",
];

export function getBriefingKind(prompt) {
  const source = String(prompt || "");
  return Object.entries(PERSONAL_BRIEFING_MARKERS)
    .find(([, marker]) => source.startsWith(marker))?.[0] ?? null;
}

export function supportsBriefingFeedback(prompt) {
  return ["morning", "evening"].includes(getBriefingKind(prompt));
}

export function normalizeBriefingFormatting(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

export function extractTrendTopics(text) {
  const topics = [];
  for (const line of String(text || "").split(/\r?\n/).map((row) => row.trim())) {
    const title = line.match(/^\d\uFE0F?\u20E3\s*(.+)$/u)?.[1];
    if (title) topics.push({ title, url: null });
    const url = line.match(/^🔗.*?(https?:\/\/\S+)/u)?.[1];
    if (url && topics.length && !topics.at(-1).url) topics.at(-1).url = url;
  }
  return topics.slice(0, 5);
}

export function extractBriefingRecommendations(text) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => RECOMMENDATION_HEADINGS.includes(line.trim()));
  if (start < 0) return [];
  const recommendations = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^[^•\s].*$/.test(trimmed) && !trimmed.startsWith("•")) break;
    if (trimmed.startsWith("•")) recommendations.push(trimmed.slice(1).trim());
  }
  return recommendations.slice(0, 6);
}

export function validateBriefingOutput(job, recentHistory = []) {
  const kind = getBriefingKind(job?.prompt);
  if (!kind || job?.status !== "completed") return { valid: true, issues: [] };
  const text = String(job.summary || "").trim();
  const issues = [];
  const limit = kind === "weekly" ? 1800 : kind === "aiTrend" ? 2200 : 1300;
  if (!text) issues.push("내용이 비어 있음");
  if (text.length > limit) issues.push(`${limit}자 초과`);
  if (/^(?:#|\*\*)/m.test(text) || /\[[^\]]+\]\(https?:\/\//.test(text)) issues.push("금지된 Markdown 형식 포함");
  if (/(?:Codex|Claude) job (?:completed|started)|Job:\s|Session:\s|Workspace:\s/.test(text)) issues.push("작업 메타데이터 포함");
  const expectedTitle = kind === "morning" ? "☀️ 모닝 브리핑"
    : kind === "evening" ? "🌙 이브닝 브리핑"
      : kind === "weekly" ? "🗓 주간 리뷰" : "🤖 AI 트렌드";
  if (!text.includes(expectedTitle)) issues.push("필수 제목 누락");

  const recommendations = extractBriefingRecommendations(text);
  const recent = recentHistory.flatMap((entry) => entry.recommendations || []);
  if (recommendations.some((item) => recent.some((past) => similarity(item, past) >= 0.72))) {
    issues.push("최근 추천과 매우 유사한 항목 포함");
  }
  return { valid: issues.length === 0, issues };
}

export function buildBriefingFeedbackMarkup(briefingId, recommendationCount = 1) {
  return {
    inline_keyboard: Array.from({ length: Math.max(1, recommendationCount) }, (_, index) => [
      { text: `${index + 1} 👍`, callback_data: `brief:interest:${briefingId}:${index}` },
      { text: `${index + 1} ✅`, callback_data: `brief:done:${briefingId}:${index}` },
      { text: `${index + 1} 👎`, callback_data: `brief:skip:${briefingId}:${index}` },
    ]),
  };
}

function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / new Set([...a, ...b]).size;
}

function tokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[가-힣a-z0-9]{2,}/g) || []);
}
