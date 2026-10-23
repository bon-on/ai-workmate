import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBriefing, evaluateBriefingHistory } from "../src/briefing-eval.js";

test("briefing eval catches structural and repetition regressions", () => {
  const result = evaluateBriefing({
    kind: "morning",
    text: "☀️ 모닝 브리핑\n\n💡 오늘의 추천\n• 브라우저 탭 다섯 개를 정리하세요.",
    recentRecommendations: ["브라우저 탭 다섯 개를 정리하세요."],
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("missing:🌦 날씨"));
  assert.ok(result.issues.includes("repeated-recommendation"));
});

test("briefing history returns a compact quality summary", () => {
  const result = evaluateBriefingHistory([{
    kind: "evening", sentAt: "2026-09-28T11:00:00Z", recommendations: [],
    text: "🌙 이브닝 브리핑\n\n📈 Trading dry-run\n• 변화 없음\n\n📅 내일 일정\n• 내일 등록된 일정 없음",
  }]);
  assert.deepEqual(result, { samples: 1, averageScore: 100, failures: 0, duplicateRecommendations: 0 });
});

test("code-generated status sections are not scored as repeated recommendations", async () => {
  const { evaluateBriefing } = await import("../src/briefing-eval.js");
  const text = ["☀️ 모닝 브리핑", "", "🌦 날씨", "• 맑음", "", "📅 일정", "• 없음", "", "🧰 저장소 점검", "• trading · 공개 주의 9건 (home-path 9)", "", "💡 오늘의 추천", "• 실패 가능성이 큰 경로를 테스트로 고정하세요"].join("\n");
  const result = evaluateBriefing({ kind: "morning", text, recentRecommendations: ["trading · 공개 주의 9건 (home-path 9)"] });
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.recommendationCount, 1);
});
