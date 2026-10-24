import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ENGLISH_STUDY_PROMPT, buildEnglishStudy, formatEnglishStudy, lemmaCandidates, parseFeed, reviewWords, runEnglishStudy, selectCandidates, splitSentences,
} from "../src/english-study.js";
import { PersonalOpsStore } from "../src/personal-ops-store.js";
import { runDueSchedules } from "../src/scheduler.js";
import { ensurePersonalBriefingSchedules } from "../src/briefings.js";
import { handleMessage } from "../src/router.js";
import { loadConfig } from "../src/config.js";

const now = new Date("2026-10-26T03:10:00Z"); // Monday 12:10 KST
const BNE_LINK = "https://breakingnewsenglish.com/2610/261025-deep-sea.html";
const BNE_RSS = `<rss><channel>
<item><title>Scientists find &quot;new&quot; deep-sea creatures</title><link>${BNE_LINK}</link>
<pubDate>Sun, 25 Oct 2026 00:30:00 GMT</pubDate><description><![CDATA[Oct 25, 2026. Researchers found animals near hot vents.]]></description></item>
</channel></rss>`;
const BNE_HTML = `<html><p>Researchers discovered remarkable creatures living near volcanic vents. The team travelled across the ocean to survey the seabed. Many species survive without sunlight.</p>
<p>Researchers (1) ________________ remarkable creatures</p></html>`;
const DW_LINK = "https://www.dw.com/en/rivers/a-1";
const DW_RDF = `<rdf:RDF><item rdf:about="${DW_LINK}"><title>Europe&apos;s rivers face drought</title><link>${DW_LINK}</link>
<description>Farmers worry as shrinking rivers threaten harvests across southern regions this summer.</description><dc:date>2026-10-25T10:00:00Z</dc:date></item></rdf:RDF>`;
const WORDS = new Set(["remarkable", "creature", "volcanic", "vent", "travel", "survey", "seabed", "species", "survive", "sunlight", "researcher", "discover",
  "shrink", "threaten", "harvest", "farmer", "drought", "region", "river", "worry", "summer", "living", "across", "ocean"]);
const DICTIONARY = {
  remarkable: [{ word: "remarkable", meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "Worthy of being noticed.", example: "a remarkable achievement" }] }] }],
  travel: [{ word: "travel", meanings: [
    { partOfSpeech: "noun", definitions: [{ definition: "The act of traveling.", example: "space travel" }] },
    { partOfSpeech: "verb", definitions: [{ definition: "To be on a journey.", example: "We travel by train." }] },
  ] }],
};

function fakeFetch({ ollama = defaultOllama, dictionaryStatus = null, feeds = "ok", calls = [] } = {}) {
  return async (url, options = {}) => {
    calls.push(String(url));
    const text = (body, status = 200) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body) });
    if (url.includes("bne.rss")) return feeds === "ok" ? text(BNE_RSS) : text("", 503);
    if (url.includes("rss-en-world")) return feeds === "ok" ? text(DW_RDF) : text("", 503);
    if (url.includes("rss.dw.com")) return feeds === "ok" ? text("<rdf:RDF></rdf:RDF>") : text("", 503);
    if (url === BNE_LINK) return text(BNE_HTML);
    if (url.includes("dictionaryapi.dev")) {
      if (dictionaryStatus) return text("error", dictionaryStatus);
      const word = decodeURIComponent(url.split("/").pop());
      return DICTIONARY[word] ? text(JSON.stringify(DICTIONARY[word])) : text("{}", 404);
    }
    if (url.includes("/api/generate")) return ollama(JSON.parse(options.body));
    throw new Error(`unexpected ${url}`);
  };
}

function defaultOllama(body) {
  const words = [...body.prompt.matchAll(/\{"word":"([a-z]+)","form":"([a-z]+)"/g)].map((match) => ({
    word: match[1],
    pos: match[2].endsWith("ed") ? "verb" : ["remarkable", "volcanic"].includes(match[1]) ? "adjective" : "noun",
    meaning_ko: `${match[1]} 뜻`,
    sentence_ko: `${match[1]} 문장 해석`,
  }));
  return { ok: true, status: 200, json: async () => ({ response: JSON.stringify({ title_ko: "과학자들이 새로운 심해 생물을 찾다", words }) }) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function store() {
  const personalOps = new PersonalOpsStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), "english-study-")), "state.json"));
  await personalOps.load();
  return personalOps;
}

async function staticSource() {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "english-static-")), "lessons.md");
  await fs.writeFile(file, [
    "# Lessons", "", "## Monday", "", "### 12:00", "Focus: Ordering at a cafe", "Vocabulary (2): order, receipt",
    "Core pattern: I'd like to ...", "Mini reading: I order coffee.", "Example sentences:", "- I'd like to order coffee.",
    "Speaking task: Order lunch.", "Writing challenge: Write two sentences.", "",
  ].join("\n"));
  return file;
}

test("feeds parse RSS and RDF items with entities and CDATA", () => {
  const [bne] = parseFeed(BNE_RSS, { source: "BNE", learner: true });
  assert.equal(bne.title, "Scientists find \"new\" deep-sea creatures");
  assert.equal(bne.description, "Oct 25, 2026. Researchers found animals near hot vents.");
  assert.equal(bne.learner, true);
  const [dw] = parseFeed(DW_RDF, { source: "DW" });
  assert.equal(dw.title, "Europe's rivers face drought");
  assert.equal(dw.publishedAt.toISOString(), "2026-10-25T10:00:00.000Z");
});

test("candidates skip names, common and recent words and repeated stems; base forms resolve first", () => {
  const sentences = splitSentences('Maria said: "Farmers worry." Shrinking rivers threaten harvests. Rivers keep shrinking because farmers worry.');
  assert.deepEqual(sentences.length, 3);
  const tokens = selectCandidates(sentences, new Set(["harvest"])).map((row) => row.token);
  assert.ok(!tokens.includes("maria") && !tokens.includes("because"));
  assert.ok(!tokens.includes("harvests"), "recently sent word");
  assert.equal(tokens.filter((token) => token.startsWith("shrink")).length, 1);
  const spread = selectCandidates(["Remarkable volcanic creatures survive.", "Farmers worry."]).map((row) => row.token);
  assert.deepEqual(spread.slice(0, 2), ["creatures", "worry"], "one word per sentence before a second from the same one");
  assert.deepEqual(lemmaCandidates("travelled").slice(0, 2), ["travelle", "travel"]);
  assert.equal(lemmaCandidates("sells")[0], "sell");
  // "+e" restorations come before bare stems, and -ies words never lose only the "s".
  const list = new Set(["rais", "raise", "not", "note", "hop", "hope", "agre", "agree", "specie", "species", "add", "stop", "study"]);
  const pick = (word) => lemmaCandidates(word).find((form) => list.has(form));
  assert.deepEqual(["raised", "notes", "hoping", "hoped", "agreed", "species", "added", "stopped", "studies"].map(pick),
    ["raise", "note", "hope", "hope", "agree", "species", "add", "stop", "study"]);
  assert.equal(lemmaCandidates("dying")[0], "die");
  assert.equal(lemmaCandidates("playing")[0], "playe");
});

test("a lesson uses a learner article, context part of speech, Korean meanings and a review quiz", async () => {
  const personalOps = await store();
  personalOps.englishStudy.words.push({ chatId: "1", word: "resilient", meaning: "회복력 있는", pos: "adjective", sentAt: "2026-10-23T03:10:00Z" });
  const result = await buildEnglishStudy({ chatId: "1", personalOps, now, fetchImpl: fakeFetch(), wordList: WORDS, staticSourcePath: "/nonexistent" });
  assert.equal(result.mode, "news");
  assert.match(result.text, /^📘 영어 학습 · 10월 26일 \(월\)/);
  assert.match(result.text, /📰 Scientists find "new" deep-sea creatures\n해석: 과학자들이 새로운 심해 생물을 찾다/);
  assert.match(result.text, /• remarkable \(adj\.\) remarkable 뜻\n  “Researchers discovered remarkable creatures living near volcanic vents\.”\n  → remarkable 문장 해석\n  예: a remarkable achievement/);
  // "travelled" is a verb here, so the verb sense and its example are shown, not "space travel".
  assert.match(result.text, /• travel \(v\.\) travel 뜻\n.*\n.*\n  예: We travel by train\./);
  assert.doesNotMatch(result.text, /space travel/);
  assert.doesNotMatch(result.text, /“Scientists find "new" deep-sea creatures\.?”/, "headline is not reused as an example");
  assert.match(result.text, /🔁 복습 \(3일 전\)\n• resilient → \?\n  정답: 회복력 있는/);
  assert.match(result.text, new RegExp(`🔗 BNE · ${BNE_LINK.replaceAll(".", "\\.")}`));
  assert.equal(result.record.link, BNE_LINK);
  assert.ok(result.record.words.length >= 3 && result.record.words.length <= 5);
  assert.ok(result.record.words.every((row) => /뜻$/.test(row.meaning)));
});

test("a used article is skipped and a down dictionary is asked only once", async () => {
  const personalOps = await store();
  await personalOps.recordEnglishStudy({ chatId: "1", link: BNE_LINK, words: [], now: new Date("2026-10-20T03:10:00Z") });
  const calls = [];
  const result = await buildEnglishStudy({ chatId: "1", personalOps, now, fetchImpl: fakeFetch({ dictionaryStatus: 530, calls }), wordList: WORDS, staticSourcePath: "/nonexistent" });
  assert.equal(result.record.link, DW_LINK);
  assert.equal(calls.filter((url) => url.includes("dictionaryapi.dev")).length, 1);
  assert.match(result.text, /• (shrink|threaten|harvest|farmer|region) \((n|v)\.\) \S+ 뜻/);
});

test("invalid model output never leaks; the static lesson or an English-only lesson is sent instead", async () => {
  const english = async () => ({ ok: true, status: 200, json: async () => ({ response: '{"title_ko":"Deep sea","words":[{"word":"remarkable","meaning_ko":"notable"}]}' }) });
  const withStatic = await buildEnglishStudy({ chatId: "1", now, fetchImpl: fakeFetch({ ollama: english }), wordList: WORDS, staticSourcePath: await staticSource() });
  assert.equal(withStatic.mode, "static");
  assert.match(withStatic.text, /^ℹ️ 로컬 번역 모델\(Ollama\)에 연결하지 못해 기본 교재를 보냅니다\.\n\nEnglish Study Reminder \| Monday 12:00/);
  assert.equal(withStatic.record, null);

  const broken = async () => ({ ok: true, status: 200, json: async () => ({ response: "not json {" }) });
  const englishOnly = await buildEnglishStudy({ chatId: "1", now, fetchImpl: fakeFetch({ ollama: broken }), wordList: WORDS, staticSourcePath: "/nonexistent" });
  assert.equal(englishOnly.mode, "english-only");
  assert.doesNotMatch(englishOnly.text, /not json|해석:/);
  assert.match(englishOnly.text, /• remarkable \(adj\.\) Worthy of being noticed\./);
});

test("when every feed fails the static lesson is sent, otherwise the error surfaces", async () => {
  const result = await buildEnglishStudy({ chatId: "1", now, fetchImpl: fakeFetch({ feeds: "down" }), wordList: WORDS, staticSourcePath: await staticSource() });
  assert.equal(result.mode, "static");
  assert.match(result.text, /뉴스를 가져오지 못해 기본 교재를 보냅니다/);
  await assert.rejects(
    buildEnglishStudy({ chatId: "1", now, fetchImpl: fakeFetch({ feeds: "down" }), wordList: WORDS, staticSourcePath: "/nonexistent" }),
    /모든 영어 뉴스 피드 응답 실패/,
  );
});

test("sending records words and the link, which survive a reload and are bounded", async () => {
  const personalOps = await store();
  const sent = [];
  const telegram = { async sendMessage(chatId, text, extra) { sent.push({ chatId, text, extra }); } };
  await runEnglishStudy({ telegram, chatId: "1", personalOps, now, fetchImpl: fakeFetch(), wordList: WORDS, staticSourcePath: "/nonexistent" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].extra.disable_web_page_preview, true);
  const reloaded = new PersonalOpsStore(personalOps.statePath);
  await reloaded.load();
  const history = reloaded.getEnglishStudy("1");
  assert.deepEqual(history.links, [BNE_LINK]);
  assert.ok(history.words.every((row) => row.sentAt === now.toISOString() && row.meaning));
  assert.equal(reloaded.getEnglishStudy("2").words.length, 0);
  await reloaded.recordEnglishStudy({ chatId: "1", words: Array.from({ length: 1100 }, (_, index) => ({ word: `w${index}` })), now });
  assert.equal(reloaded.englishStudy.words.length, 1000);
  assert.deepEqual(reviewWords(history.words, new Date("2026-10-29T03:10:00Z")).map((group) => group.days), [3]);
  assert.deepEqual(reviewWords(history.words, new Date("2026-10-27T03:10:00Z")), []);
});

test("the scheduled entry runs even while usage is paused or the chat is busy, and reports failures", async () => {
  const calls = [];
  const entry = { id: "en-1", chatId: "1", prompt: ENGLISH_STUDY_PROMPT, workspaceAlias: "default" };
  const base = {
    schedules: { due: () => [entry], isUsagePaused: () => true, async markStarted(id) { calls.push(["markStarted", id]); } },
    jobs: { getActiveJob: () => ({ jobId: "busy" }), async startJob() { throw new Error("no AI job expected"); } },
    workspaces: { getWorkspaceByAlias: () => ({ alias: "default", path: "/tmp" }) },
    telegram: { async sendMessage(chatId, text) { calls.push(["send", text]); } },
    onJobSettled: async () => { throw new Error("not a briefing job"); },
  };
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  // The tick returns while the lesson is still being built, so other due entries are not delayed.
  await runDueSchedules({ ...base, now, runEnglishStudy: async (row) => { calls.push(["english", row.id]); await slow; calls.push(["english-done"]); } });
  await tick();
  assert.deepEqual(calls, [["markStarted", "en-1"], ["english", "en-1"]]);
  release();
  await tick();
  assert.deepEqual(calls.at(-1), ["english-done"]);
  calls.length = 0;
  await runDueSchedules({ ...base, now, runEnglishStudy: async () => { throw new Error("offline"); } });
  await tick();
  assert.deepEqual(calls, [["markStarted", "en-1"], ["send", "⚠️ 영어 학습 메시지를 만들지 못했습니다: offline"]]);
});

test("the daily schedule is created at the configured time and removed when disabled", async () => {
  const entries = [];
  const schedules = {
    list: () => entries,
    async add(input) { const row = { id: String(entries.length + 1), ...input }; entries.push(row); return row; },
    async updatePrompt() {}, async reschedule() {},
    async remove({ id }) { entries.splice(entries.findIndex((row) => row.id === id), 1); },
  };
  const config = {
    personalBriefingsEnabled: true, englishStudyEnabled: true, englishStudyHour: 12, englishStudyMinute: 10,
    allowedChatIds: ["1"], allowedUserIds: ["2"], workspaces: { defaultAlias: "default" },
    morningBriefHour: 8, morningBriefMinute: 0, eveningBriefHour: 20, eveningBriefMinute: 0,
    weeklyReviewHour: 20, weeklyReviewMinute: 30, aiTrendBriefHour: 12, aiTrendBriefMinute: 0, personalLocation: "서울",
  };
  await ensurePersonalBriefingSchedules({ schedules, config, now: new Date("2026-10-26T09:00:00+09:00") });
  const english = entries.find((row) => row.prompt === ENGLISH_STUDY_PROMPT);
  assert.equal(new Date(english.nextRunAt).toISOString(), "2026-10-26T03:10:00.000Z");
  assert.equal(english.intervalMs, 24 * 60 * 60 * 1000);
  await ensurePersonalBriefingSchedules({ schedules, config: { ...config, englishStudyEnabled: false } });
  assert.equal(entries.filter((row) => row.prompt === ENGLISH_STUDY_PROMPT).length, 0);
  assert.equal(entries.length, 4);
  // Turning off all personal briefings also removes it, instead of leaving it running.
  await ensurePersonalBriefingSchedules({ schedules, config });
  assert.equal(entries.length, 5);
  await ensurePersonalBriefingSchedules({ schedules, config: { ...config, personalBriefingsEnabled: false } });
  assert.equal(entries.filter((row) => row.prompt === ENGLISH_STUDY_PROMPT).length, 0);
});

test("config defaults to 12:10 and accepts ENGLISH_STUDY_TIME and ENGLISH_STUDY_ENABLED", () => {
  const base = { TELEGRAM_BOT_TOKEN: "token", CODEX_WORKSPACE: "/tmp/workspace", ALLOWED_CHAT_IDS: "1" };
  const defaults = loadConfig(base);
  assert.deepEqual([defaults.englishStudyEnabled, defaults.englishStudyHour, defaults.englishStudyMinute], [true, 12, 10]);
  const custom = loadConfig({ ...base, ENGLISH_STUDY_TIME: "07:45", ENGLISH_STUDY_ENABLED: "false" });
  assert.deepEqual([custom.englishStudyEnabled, custom.englishStudyHour, custom.englishStudyMinute], [false, 7, 45]);
  assert.throws(() => loadConfig({ ...base, ENGLISH_STUDY_TIME: "noon" }), /ENGLISH_STUDY_TIME must use HH:MM/);
});

test("/english acknowledges at once and sends the lesson in the background", async () => {
  const sent = [];
  const personalOps = await store();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ feeds: "down" });
  try {
    await handleMessage({
      message: { chat: { id: 1 }, from: { id: 2 }, text: "/english" },
      config: { allowedChatIds: ["1"], allowedUserIds: ["2"] },
      telegram: { async sendMessage(chatId, text) { sent.push(text); } },
      jobs: {}, personalOps,
    });
    assert.match(sent[0], /영어 학습 메시지를 만드는 중입니다/);
    for (let index = 0; index < 50 && sent.length < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.fetch = originalFetch;
  }
  // Feeds are down in this test; with or without the local lesson source the user gets a message.
  assert.equal(sent.length, 2);
  assert.match(sent[1], /기본 교재|영어 학습 메시지를 만들지 못했습니다/);
});

test("the model's lemma replaces a wrong guess only when it is a plausible headword, and senses follow it", async () => {
  // The heuristic guesses "evening" -> "even"; the model, which sees the sentence, keeps "evening".
  const words = new Set(["crowd", "gather", "even", "evening", "rate", "rise"]);
  const dictionaryCalls = [];
  const rss = `<rss><item><title>City life</title><link>https://breakingnewsenglish.com/x.html</link><description>Crowds gathered every evening as rates rose across the city.</description></item></rss>`;
  const ollama = async (body) => {
    const rows = [...body.prompt.matchAll(/\{"word":"([a-z]+)","form":"([a-z]+)"/g)].map((match) => ({
      word: match[1], lemma: { evening: "evening", rates: "https" }[match[2]] ?? match[1], pos: match[2] === "gathered" ? "verb" : "noun",
      meaning_ko: match[1] === "rate" ? "자세히는 https://x.example 참고" : `${match[2] === "evening" ? "evening" : match[1]} 뜻`, sentence_ko: "군중이 매일 저녁 모였다.",
    }));
    return { ok: true, status: 200, json: async () => ({ response: JSON.stringify({ title_ko: "도시의 삶", words: rows }) }) };
  };
  const fetchImpl = async (url, options) => {
    if (url.includes("bne.rss")) return { ok: true, status: 200, text: async () => rss };
    if (url.includes("rss.dw.com")) return { ok: true, status: 200, text: async () => "<rss></rss>" };
    if (url.includes("breakingnewsenglish.com/x")) return { ok: false, status: 404, text: async () => "" };
    if (url.includes("dictionaryapi.dev")) {
      const word = url.split("/").pop();
      dictionaryCalls.push(word);
      return word === "evening"
        ? { ok: true, status: 200, json: async () => [{ word: "evening", meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "The time after sunset.", example: "a quiet evening" }] }] }] }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    if (url.includes("/api/generate")) return ollama(JSON.parse(options.body));
    throw new Error(url);
  };
  const result = await buildEnglishStudy({ chatId: "1", now, fetchImpl, wordList: words, staticSourcePath: "/nonexistent" });
  assert.match(result.text, /• evening \(n\.\) evening 뜻\n.*\n.*\n  예: a quiet evening/);
  assert.doesNotMatch(result.text, /• even\b|x\.example|참고/);
  assert.match(result.text, /• rate \(n\.\)\n/, "invalid lemma and a meaning with a link are both dropped");
  assert.ok(dictionaryCalls.includes("even") && dictionaryCalls.includes("evening"));
  assert.ok(result.record.words.some((row) => row.word === "evening"));
});

test("both review intervals are quizzed and long lessons stay under the Telegram limit", () => {
  const history = [
    { word: "resilient", meaning: "회복력 있는", sentAt: "2026-10-23T03:10:00Z" },
    { word: "commute", meaning: "통근하다", sentAt: "2026-10-19T03:10:00Z" },
    { word: "ignored", meaning: "-", sentAt: "2026-10-21T03:10:00Z" },
  ];
  const review = reviewWords(history, now);
  assert.deepEqual(review.map((group) => [group.days, group.words.map((row) => row.word)]), [[3, ["resilient"]], [7, ["commute"]]]);
  const long = "x".repeat(180);
  const text = formatEnglishStudy({
    article: { title: "t".repeat(300), source: "DW", link: "https://www.dw.com/en/a" }, titleKo: "가".repeat(160), review, now,
    words: Array.from({ length: 5 }, (_, index) => ({ word: `word${index}`, partOfSpeech: "noun", meaningKo: "뜻".repeat(40), sentence: long, sentenceKo: "해".repeat(240), example: "e".repeat(160) })),
  });
  assert.ok(text.length <= 3900, String(text.length));
  assert.match(text, /🔁 복습 \(3일 전\)[\s\S]*🔁 복습 \(7일 전\)/);
  assert.match(text, /🔗 DW · https:\/\/www\.dw\.com\/en\/a$/);
});

test("concurrent requests share one build and a failed history save is not reported as a failed lesson", async () => {
  const sent = [];
  const telegram = { async sendMessage(chatId, text) { sent.push(text); } };
  const personalOps = { getEnglishStudy: () => ({ words: [], links: [] }), async recordEnglishStudy() { throw new Error("disk full"); } };
  const options = { telegram, chatId: "1", personalOps, now, fetchImpl: fakeFetch(), wordList: WORDS, staticSourcePath: "/nonexistent" };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const [first, second] = await Promise.all([runEnglishStudy(options), runEnglishStudy(options)]);
    assert.equal(first, second);
  } finally {
    console.error = originalError;
  }
  assert.equal(sent.length, 1);
  assert.match(logged.join("\n"), /history save failed: disk full/);
});
