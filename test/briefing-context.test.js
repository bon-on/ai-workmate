import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAppleCalendar, decorateScheduledPrompt, readWeather } from "../src/briefing-context.js";
import { PersonalOpsStore } from "../src/personal-ops-store.js";

test("AI trend prompt excludes unrelated personal context and slow collectors", async () => {
  const result = await decorateScheduledPrompt("[AI_WORKMATE_AI_TREND_BRIEF_V1]\n뉴스", {
    now: new Date("2026-09-24T03:00:00Z"),
    get config() { throw new Error("must not collect calendar or weather"); },
  });
  assert.match(result, /2026-09-24T03:00:00.000Z/);
  assert.ok(result.length < 150);
});

test("AI trend prompt lists recently sent items so the radar does not repeat them", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trend-topics-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "ops.json");
  const store = new PersonalOpsStore(statePath);
  await store.recordTrendTopics({ chatId: 1, topics: [{ title: "오래된 소식", url: null }], now: new Date("2026-09-01T03:00:00Z") });
  await store.recordTrendTopics({ chatId: 1, topics: [{ title: "Ollama 발표", url: "https://ollama.com/x" }], now: new Date("2026-09-23T03:00:00Z") });
  const reloaded = new PersonalOpsStore(statePath);
  await reloaded.load();
  const result = await decorateScheduledPrompt("[AI_WORKMATE_AI_TREND_BRIEF_V1]\n뉴스", {
    now: new Date("2026-09-24T03:00:00Z"), personalOps: reloaded, chatId: "1",
  });
  assert.match(result, /2026-09-23 Ollama 발표 \(https:\/\/ollama.com\/x\)/);
  assert.doesNotMatch(result, /오래된 소식/);
});

test("readAppleCalendar separates today and tomorrow and requests overlapping events", async () => {
  let script = "";
  const execFileImpl = async (command, args) => {
    if (command === "open") return { stdout: "" };
    script = args[1];
    return {
      stdout: [
        "today|||종일 일정|||2026년 9월 17일 목요일 오전 12:00:00|||2026년 9월 18일 금요일 오전 12:00:00|||true|||개인",
        "tomorrow|||내일 일정|||2026년 9월 18일 금요일 오전 9:00:00|||2026년 9월 18일 금요일 오전 10:00:00|||false|||업무",
      ].join("\n"),
    };
  };
  const result = await readAppleCalendar(new Date("2026-09-17T08:00:00+09:00"), { execFileImpl });
  assert.equal(result.today[0].summary, "종일 일정");
  assert.equal(result.today[0].allDay, true);
  assert.equal(result.tomorrow[0].summary, "내일 일정");
  assert.match(script, /end date is greater than todayStart/);
  assert.match(script, /tomorrowStart/);
});

test("readWeather retries a transient failure before reporting no weather", async () => {
  const config = { weatherLatitude: 37.5, weatherLongitude: 127, personalLocation: "서울" };
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("fetch failed");
    return { ok: true, json: async () => ({ timezone: "Asia/Seoul", current: { time: "2026-10-22T08:00" }, hourly: { time: [], precipitation_probability: [] }, daily: {} }) };
  };
  const result = await readWeather(config, flaky, { retryDelaysMs: [0, 0] });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);

  calls = 0;
  const down = async () => { calls += 1; throw new Error("ETIMEDOUT"); };
  const failed = await readWeather(config, down, { retryDelaysMs: [0, 0] });
  assert.equal(failed.ok, false);
  assert.equal(calls, 3);
  assert.match(failed.error, /ETIMEDOUT/);
});
