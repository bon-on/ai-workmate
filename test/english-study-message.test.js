import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStudyMessage,
  parseArgs,
  parseStudySchedule,
  resolveTargetSlot,
} from "../src/english-study-message.js";
import {
  buildFormattedLesson,
  extractKeyPointWords,
  parseLesson,
} from "../src/english-study-format.js";

const SAMPLE_MARKDOWN = `## Monday

### 12:00
Focus: Ordering lunch and asking for menu options
Vocabulary (20): order, menu, recommend, favorite, quick, healthy, crowded, break, nearby, price, receipt, card, cash, discount, total, seat, table, spicy, sauce, takeaway
Core pattern: I'd like to + verb / Can I get + noun?
Mini reading: I'd like to order a quick lunch before my break ends. The cafe nearby is crowded, but the menu has a healthy set with a discount, so I usually order it as takeaway.
Example sentences:
- I'd like to order the chicken salad and an iced coffee.
- Can I get this sandwich without spicy sauce?
- Is there a cheaper set menu for lunch today?
- I'll pay by card, so please give me the receipt.
- The cafe is crowded, so let's find a table outside.
Speaking task: Role-play a short lunch order conversation with a cashier and include one question about the menu.
Writing challenge: Write 6 sentences about what you usually order for lunch, how you pay, and what kind of food you recommend.

### 19:00
Focus: Grocery shopping and simple home cooking
Vocabulary (20): grocery, ingredients, vegetables, fruit, basket, aisle, list, fresh, recipe, dinner, hungry, cook, boil, fry, package, delivery, kitchen, refrigerator, enough, cheap
Core pattern: I need to + verb / I'm going to + verb
Mini reading: I need to buy fresh vegetables and a few other ingredients for dinner. After work, I'm going to stop by the grocery store, check my list, and cook something simple at home.
Example sentences:
- I need to buy eggs, milk, and fruit on the way home.
- This aisle has cheaper vegetables than the one near the entrance.
- I'm going to cook pasta, so I need tomatoes and garlic.
- The delivery package arrived, so I put everything in the refrigerator.
- We have enough ingredients for dinner, so I don't need extra food.
Speaking task: Describe your grocery routine in 7 sentences and explain what you usually cook on weeknights.
Writing challenge: Write a short dinner plan with what you need to buy, how much you want to spend, and what you will cook.

## Tuesday

### 12:00
Focus: Commuting and arranging appointments
Vocabulary (20): commute, subway, bus, station, transfer, route, traffic, platform, passenger, late, schedule, appointment, reserve, available, confirm, delay, arrive, leave, map, destination
Core pattern: I need to be + place / I'm supposed to + verb
Mini reading: I need to be at the dentist by six, so I checked the subway route before lunch. If traffic is heavy later, I'm supposed to leave early and confirm my appointment on the way.
Example sentences:
- I usually take the subway because the bus is delayed too often.
- Which platform should I use for the airport line?
- I want to reserve an appointment for Thursday evening.
- Please confirm whether the 7 p.m. time is still available.
- I left the office early because traffic was worse than usual.
Speaking task: Explain how you get to work or another regular destination and include one problem that often happens on the way.
Writing challenge: Write 6 to 8 sentences about a recent commute, an appointment you made, and how you confirmed the time.`;

test("parseArgs uses defaults and reads overrides", () => {
  const defaults = parseArgs([]);
  assert.match(defaults.sourcePath, /english-study-weekday-hourly\.md$/);
  assert.match(defaults.outputPath, /telegram-english-study-message\.txt$/);
  assert.equal(defaults.timezone, "Asia/Seoul");

  const custom = parseArgs([
    "--source",
    "/tmp/source.md",
    "--output",
    "/tmp/out.txt",
    "--date-time",
    "2026-04-20T12:00:00+09:00",
    "--timezone",
    "UTC",
  ]);

  assert.equal(custom.sourcePath, "/tmp/source.md");
  assert.equal(custom.outputPath, "/tmp/out.txt");
  assert.equal(custom.dateTime, "2026-04-20T12:00:00+09:00");
  assert.equal(custom.timezone, "UTC");
});

test("parseStudySchedule maps day and hour sections", () => {
  const schedule = parseStudySchedule(SAMPLE_MARKDOWN);

  assert.match(schedule.get("Monday").get("12:00"), /Ordering lunch/);
  assert.match(schedule.get("Monday").get("19:00"), /Vocabulary \(20\): grocery/);
  assert.match(schedule.get("Tuesday").get("12:00"), /Commuting and arranging appointments/);
});

test("resolveTargetSlot returns allowed lunch slot in Asia/Seoul", () => {
  const slot = resolveTargetSlot({
    now: new Date("2026-04-20T12:15:00+09:00"),
    timezone: "Asia/Seoul",
  });

  assert.deepEqual(slot, {
    dayName: "Monday",
    hourLabel: "12:00",
    dateLabel: "2026-04-20",
  });
});

test("resolveTargetSlot allows weekends and rejects unsupported hours", () => {
  const weekendSlot = resolveTargetSlot({
    now: new Date("2026-04-18T12:00:00+09:00"),
    timezone: "Asia/Seoul",
  });

  assert.deepEqual(weekendSlot, {
    dayName: "Saturday",
    hourLabel: "12:00",
    dateLabel: "2026-04-18",
  });

  assert.throws(
    () =>
      resolveTargetSlot({
        now: new Date("2026-04-20T15:00:00+09:00"),
        timezone: "Asia/Seoul",
      }),
    /No English study slot at 15:00/,
  );
});

test("buildStudyMessage formats the selected lesson", () => {
  const schedule = parseStudySchedule(SAMPLE_MARKDOWN);
  const message = buildStudyMessage({
    schedule,
    dayName: "Monday",
    hourLabel: "19:00",
    dateLabel: "2026-04-20",
  });

  assert.match(message, /^English Study Reminder \| Monday 19:00\n2026-04-20/m);
  assert.match(message, /Vocabulary list:\n- grocery: 식료품/m);
  assert.match(message, /Example sentences:\n- I need to buy eggs, milk, and fruit on the way home\./m);
});

test("parseLesson reads structured lesson fields and example sentences", () => {
  const schedule = parseStudySchedule(SAMPLE_MARKDOWN);
  const lesson = parseLesson(schedule.get("Monday").get("12:00"));

  assert.equal(lesson.focus, "Ordering lunch and asking for menu options");
  assert.equal(lesson.vocabulary.length, 20);
  assert.equal(lesson.exampleSentences.length, 5);
  assert.equal(lesson.exampleSentences[1], "Can I get this sandwich without spicy sauce?");
});

test("extractKeyPointWords prefers vocabulary used in reading", () => {
  const schedule = parseStudySchedule(SAMPLE_MARKDOWN);
  const lesson = parseLesson(schedule.get("Tuesday").get("12:00"));

  assert.deepEqual(extractKeyPointWords(lesson).slice(0, 4), ["subway", "route", "traffic", "leave"]);
});

test("buildFormattedLesson renders meanings and practical examples", () => {
  const schedule = parseStudySchedule(SAMPLE_MARKDOWN);
  const formatted = buildFormattedLesson(schedule.get("Monday").get("12:00"));

  assert.match(formatted, /- order: 주문하다, 주문/m);
  assert.match(formatted, /Key point words:\n- order: 주문하다, 주문/m);
  assert.match(formatted, /Example sentences:\n- I'd like to order the chicken salad and an iced coffee\./m);
});
