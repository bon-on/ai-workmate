import test from "node:test";
import assert from "node:assert/strict";
import { generateLocalRecommendations, tradingLines } from "../src/local-briefing.js";

test("local recommendation generator uses Ollama and limits output", async () => {
  let request;
  const recommendations = await generateLocalRecommendations({
    kind: "morning",
    config: { ollamaPort: 11434, localBriefingModel: "qwen3.5:latest" },
    snapshot: { personal: { inbox: [], recentBriefings: [] }, calendar: { today: [] } },
    now: new Date("2026-09-28T08:00:00+09:00"),
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, async json() { return { response: "• 테스트 하나 작성하기\n• 자동화 후보 기록하기\n• 초과 항목" }; } };
    },
  });
  assert.equal(request.model, "qwen3.5:latest");
  assert.equal(request.think, false);
  assert.deepEqual(recommendations, ["테스트 하나 작성하기", "자동화 후보 기록하기"]);
});

test("local recommendation generator falls back without Codex when Ollama is unavailable", async () => {
  const recommendations = await generateLocalRecommendations({
    kind: "evening",
    config: {},
    snapshot: { personal: { inbox: [], recentBriefings: [] }, calendar: { tomorrow: [] } },
    now: new Date("2026-09-28T20:00:00+09:00"),
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.ok(recommendations.length > 0);
  assert.ok(recommendations.length <= 3);
});

test("evening trading section shows forward experiment trades instead of no change", () => {
  const forwardTrades = [
    { experiment: "exp", arm: "current_policy", trades: 22, wins: 8, losses: 14, pnl: -45706.4 },
    { experiment: "exp", arm: "relaxed_policy", trades: 20, wins: 7, losses: 13, pnl: -41371 },
  ];
  assert.deepEqual(tradingLines({ ok: true, data: { pnl: 0, orders: 0, positions: 0, forwardTrades } }), [
    "• 실험 current_policy · 22건 (8승 14패), 손익 -45,706원",
    "• 실험 relaxed_policy · 20건 (7승 13패), 손익 -41,371원",
  ]);
  assert.deepEqual(tradingLines({ ok: true, data: { pnl: 0, orders: 0, positions: 0 } }), ["• 변화 없음"]);
  assert.deepEqual(tradingLines({ ok: true, data: { pnl: 1200, orders: 2, positions: 1, forwardTrades: [] } }),
    ["• 당일 손익 1,200원, 주문 2건, 현재 보유 포지션 1개"]);
});

test("morning briefing shows repository check lines before recommendations and omits the section when empty", async () => {
  const { formatMorning } = await import("../src/local-briefing.js");
  const now = new Date("2026-10-22T23:00:00Z");
  const snapshot = { weather: { ok: false }, calendar: { today: [] }, personal: { inbox: [] } };
  const text = formatMorning(snapshot, ["테스트 하나를 먼저 고정하세요"], now, ["• trading · 공개 주의 9건 (home-path 9)"]);
  assert.match(text, /🧰 저장소 점검\n• trading · 공개 주의 9건 \(home-path 9\)\n\n💡 오늘의 추천/);
  assert.doesNotMatch(formatMorning(snapshot, [], now, []), /저장소 점검/);
});
