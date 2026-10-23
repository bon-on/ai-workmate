import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBriefingRecommendations,
  extractTrendTopics,
  getBriefingKind,
  validateBriefingOutput,
  normalizeBriefingFormatting,
} from "../src/briefing-quality.js";

test("format-only issues are repaired locally without regeneration or loss of links", () => {
  const summary = normalizeBriefingFormatting("## 🤖 AI 트렌드\n**소식**\n[공식 출처](https://example.com/news)");
  assert.equal(summary, "🤖 AI 트렌드\n소식\n공식 출처: https://example.com/news");
  assert.equal(validateBriefingOutput({ status: "completed", prompt: "[AI_WORKMATE_AI_TREND_BRIEF_V1]", summary }).valid, true);
});

test("briefing quality helpers classify and extract recommendations", () => {
  const prompt = "[AI_WORKMATE_EVENING_BRIEF_V1]\n작성";
  const text = "🌙 이브닝 브리핑 · 9월 17일\n\n🧭 내일과 가까운 시일의 제안\n• 새 CLI를 15분 시험하세요.\n• 가족 일정 확인하기\n\n💭 짧은 회고\n• 질문";
  assert.equal(getBriefingKind(prompt), "evening");
  assert.deepEqual(extractBriefingRecommendations(text), ["새 CLI를 15분 시험하세요.", "가족 일정 확인하기"]);
});

test("briefing validator rejects metadata and recent duplicate recommendations", () => {
  const result = validateBriefingOutput({
    status: "completed",
    prompt: "[AI_WORKMATE_MORNING_BRIEF_V1]\n작성",
    summary: "☀️ 모닝 브리핑 · 9월 17일\nJob: abc\n\n💡 오늘의 추천\n• 새 CLI 도구를 15분 시험하세요.",
  }, [{ recommendations: ["새 CLI 도구를 오늘 15분 시험하세요"] }]);
  assert.equal(result.valid, false);
  assert.match(result.issues.join(" "), /메타데이터/);
  assert.match(result.issues.join(" "), /유사/);
});

test("extractTrendTopics pairs radar items with their source URL", () => {
  const text = "🤖 AI 트렌드\n\n1️⃣ Ollama v0.40.4 공개 · 10월 12일\n• 변화: x\n🔗 Ollama: https://ollama.com/blog/a\n\n2️⃣ GPT 발표 · 10월 14일\n• 의미: y\n\n🧪 오늘의 15분 실험";
  assert.deepEqual(extractTrendTopics(text), [
    { title: "Ollama v0.40.4 공개 · 10월 12일", url: "https://ollama.com/blog/a" },
    { title: "GPT 발표 · 10월 14일", url: null },
  ]);
});
