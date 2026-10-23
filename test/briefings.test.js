import test from "node:test";
import assert from "node:assert/strict";
import { ensurePersonalBriefingSchedules, buildMorningBriefPrompt, buildEveningBriefPrompt, buildWeeklyReviewPrompt, buildAiTrendBriefPrompt, buildDailyDiscoveryPrompt } from "../src/briefings.js";

test("ensurePersonalBriefingSchedules creates all personal briefing jobs once", async () => {
  const entries = [];
  const schedules = {
    list() { return entries; },
    async add(input) { const row = { id: String(entries.length + 1), ...input }; entries.push(row); return row; },
    async updatePrompt(id, prompt) { const row = entries.find((entry) => entry.id === id); row.prompt = prompt; return row; },
    async reschedule(id, nextRunAt) { const row = entries.find((entry) => entry.id === id); row.nextRunAt = nextRunAt; return row; },
    async remove({ id }) { const index = entries.findIndex((entry) => entry.id === id); return index < 0 ? null : entries.splice(index, 1)[0]; },
  };
  const config = {
    personalBriefingsEnabled: true,
    defaultTelegramTargetChatId: "100",
    allowedChatIds: ["100"], allowedUserIds: ["200"],
    workspaces: { defaultAlias: "default" },
    morningBriefHour: 8, morningBriefMinute: 0,
    eveningBriefHour: 20, eveningBriefMinute: 0,
    weeklyReviewHour: 20, weeklyReviewMinute: 30,
    aiTrendBriefHour: 12, aiTrendBriefMinute: 0,
    personalLocation: "서울",
  };
  const now = new Date("2026-08-19T07:00:00+09:00");
  assert.equal((await ensurePersonalBriefingSchedules({ schedules, config, now })).length, 4);
  assert.equal((await ensurePersonalBriefingSchedules({ schedules, config, now })).length, 0);
  assert.match(entries[0].prompt, /MORNING_BRIEF/);
  assert.match(entries[1].prompt, /EVENING_BRIEF/);
  assert.match(entries[3].prompt, /AI_TREND_BRIEF/);
  assert.match(entries[1].prompt, /서울/);
  assert.equal(new Date(entries[1].nextRunAt).getHours(), 20);
});

test("personal briefing prompts are read-only and situation aware", () => {
  assert.match(buildMorningBriefPrompt("부산"), /부산/);
  assert.match(buildWeeklyReviewPrompt("부산"), /현재 위치 '부산'를 출발점/);
  assert.match(buildMorningBriefPrompt(), /Apple Calendar/);
  assert.match(buildMorningBriefPrompt(), /외부 상태는 변경하지 마세요/);
  assert.match(buildMorningBriefPrompt(), /1,300자 이내/);
  assert.match(buildMorningBriefPrompt(), /오늘의 추천/);
  assert.match(buildMorningBriefPrompt(), /행동 1~2개/);
  assert.match(buildMorningBriefPrompt(), /최근 추천 이력/);
  assert.match(buildMorningBriefPrompt(), /오늘의 초점/);
  assert.match(buildMorningBriefPrompt(), /생활 동선.*10~30분/);
  assert.doesNotMatch(buildMorningBriefPrompt(), /Trading dry-run/);
  assert.match(buildMorningBriefPrompt(), /시스템·서비스 상태.*포함하지 마세요/);
  assert.match(buildEveningBriefPrompt(), /trading dry-run/i);
  assert.match(buildEveningBriefPrompt(), /항상 원화\(KRW\)/);
  assert.match(buildEveningBriefPrompt(), /통화 단위 미제공.*쓰지 마세요/);
  assert.match(buildEveningBriefPrompt(), /1,300자 이내/);
  assert.match(buildEveningBriefPrompt(), /내일과 가까운 시일의 제안/);
  assert.match(buildEveningBriefPrompt(), /행동 2~3개/);
  assert.match(buildEveningBriefPrompt(), /아무 기록도 없으면 이 블록 전체를 생략/);
  assert.match(buildEveningBriefPrompt(), /7일에 한 번 이하/);
  assert.match(buildEveningBriefPrompt("부산"), /부산/);
  assert.match(buildEveningBriefPrompt(), /주말 후보/);
  assert.match(buildWeeklyReviewPrompt(), /1,800자 이내/);
  assert.match(buildWeeklyReviewPrompt(), /다음 주 추천/);
  assert.match(buildWeeklyReviewPrompt(), /평일 추천/);
  assert.doesNotMatch(buildWeeklyReviewPrompt(), /📈 Trading dry-run/);
  assert.match(buildAiTrendBriefPrompt(), /1차 출처/);
  assert.match(buildAiTrendBriefPrompt(), /2,200자 이내/);
  assert.match(buildAiTrendBriefPrompt(), /Markdown 링크/);
  assert.match(buildAiTrendBriefPrompt(), /오늘의 15분 실험/);
  assert.match(buildDailyDiscoveryPrompt("부산"), /부산/);
  assert.match(buildDailyDiscoveryPrompt("부산"), /주말 후보/);
});
