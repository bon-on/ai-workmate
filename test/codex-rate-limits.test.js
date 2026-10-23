import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { readCodexRateLimits, normalizeFiveHourLimit, normalizeWeeklyLimit, createCodexLimitReader } from "../src/codex-rate-limits.js";

const primary = { usedPercent: 79, windowDurationMins: 300, resetsAt: 2000000000 };
test("selects the Codex five hour bucket and converts seconds", () => {
  const value = normalizeFiveHourLimit({ rateLimitsByLimitId: { codex: { primary } } });
  assert.equal(value.remainingPercent, 21);
  assert.equal(value.resetsAt, "2033-05-18T03:33:20.000Z");
  assert.equal(normalizeFiveHourLimit({ rateLimits: { primary: { ...primary, windowDurationMins: 10080 } } }), null);
  assert.equal(normalizeFiveHourLimit({ rateLimits: { primary: { ...primary, usedPercent: null } } }), null);
  assert.equal(normalizeFiveHourLimit({ rateLimits: { limitId: "other", primary } }), null);
});
test("lookup only initializes and reads account limits, then closes process", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() { this.killed = true; } });
  const methods = [];
  child.stdin.on("data", data => {
    const message = JSON.parse(data);
    methods.push(message.method);
    if (message.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: message.id === 2 ? { rateLimits: { primary } } : {} }) + "\n"));
  });
  assert.equal(normalizeFiveHourLimit(await readCodexRateLimits({ spawnProcess: () => child })).usedPercent, 79);
  assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read"]);
  assert.equal(child.killed, true);
});
test("cache shares concurrent reads and clears old data after lookup failure", async () => {
  let calls = 0;
  let clock = 0;
  const read = createCodexLimitReader({ now: () => clock, read: async () => { if (++calls > 1) throw Error("private error"); return { rateLimits: { primary } }; } });
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a, b);
  await read();
  assert.equal(calls, 1);
  clock = 60001;
  assert.equal((await read()).status, "unavailable");
  assert.equal((await read()).fiveHour, null);
  assert.equal(calls, 2);
});

test("weekly limit is selected by duration, including weekly-only responses", async () => {
  const weekly = { usedPercent: 92, windowDurationMins: 10080, resetsAt: 2000000000 };
  const result = { rateLimitsByLimitId: { codex: { primary, secondary: weekly } } };
  assert.equal(normalizeWeeklyLimit(result).remainingPercent, 8);
  assert.equal(normalizeWeeklyLimit({ rateLimits: { primary } }), null);
  assert.equal(normalizeWeeklyLimit({ rateLimits: { primary: weekly, secondary: primary } }).remainingPercent, 8);
  const read = createCodexLimitReader({ read: async () => result });
  const limits = await read();
  assert.equal(limits.fiveHour.remainingPercent, 21);
  assert.equal(limits.weekly.remainingPercent, 8);
  const weeklyOnly = createCodexLimitReader({ read: async () => ({ rateLimits: { secondary: weekly } }) });
  assert.equal((await weeklyOnly()).status, "available");
  assert.equal((await weeklyOnly()).fiveHour, null);
});
