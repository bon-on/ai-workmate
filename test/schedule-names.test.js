import test from "node:test";
import assert from "node:assert/strict";
import { formatKst, formatKstClock, scheduleName, scheduleRepeatLabel } from "../src/schedule-names.js";

test("schedule names hide prompts behind short Korean labels", () => {
  assert.equal(scheduleName("[AI_WORKMATE_EVENING_BRIEF_V1] 역할: ..."), "이브닝 브리핑");
  assert.equal(scheduleName("[AI_WORKMATE_REMINDER] 물 마시기"), "개인 알림 · 물 마시기");
  assert.equal(scheduleName("[AI_WORKMATE_NATURAL_SCHEDULE]\n요청: 환율 확인\n세부"), "AI 예약 · 환율 확인");
  assert.equal(scheduleName("[CUSTOM] first line\nsecond"), "first line");
  assert.equal(scheduleName(""), "예약 작업");
});

test("repeat labels and times use KST and mark weekday schedules", () => {
  const day = 86400000;
  assert.equal(scheduleRepeatLabel({ intervalMs: day, nextRunAt: "2026-10-25T23:00:00Z" }), "매일 08:00");
  assert.equal(scheduleRepeatLabel({ intervalMs: day, weekdaysOnly: true, nextRunAt: "2026-10-25T23:00:00Z" }), "평일 08:00");
  assert.equal(scheduleRepeatLabel({ intervalMs: 7 * day }), "매주");
  assert.equal(scheduleRepeatLabel({ intervalMs: 3 * 3600000 }), "3시간마다");
  assert.equal(scheduleRepeatLabel({ intervalMs: null }), "한 번");
  assert.equal(formatKstClock("2026-10-24T11:00:00Z"), "20:00");
  assert.match(formatKst("2026-10-24T11:00:00Z"), /10\. 24\. \(토\) 20:00/);
  assert.equal(formatKst("nope"), "");
});
