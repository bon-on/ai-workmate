import test from "node:test";
import assert from "node:assert/strict";
import { buildDayProfile } from "../src/day-profile.js";

test("day profile recognizes Korean holidays", async () => {
  const result = await buildDayProfile({
    now: new Date("2026-09-28T01:00:00Z"),
    fetchImpl: async () => ({ ok: true, async json() { return [{ date: "2026-09-28", localName: "대체공휴일" }]; } }),
  });
  assert.equal(result.mode, "holiday");
  assert.equal(result.holidayName, "대체공휴일");
});
