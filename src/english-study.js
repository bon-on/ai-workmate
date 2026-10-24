import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildStudyMessage, parseStudySchedule } from "./english-study-message.js";

// Daily vocabulary from a real English news article, assembled by code. Korean
// meanings come from the local Ollama model; nothing here starts a Claude/Codex job.

export const ENGLISH_STUDY_MARKER = "[AI_WORKMATE_ENGLISH_STUDY_V1]";
export const ENGLISH_STUDY_PROMPT = `${ENGLISH_STUDY_MARKER}\n영어 학습: 뉴스 기사 단어·예문·복습 (로컬 생성)`;

export const ENGLISH_FEEDS = [
  { source: "BNE", url: "https://breakingnewsenglish.com/bne.rss", learner: true },
  { source: "DW", url: "https://rss.dw.com/rdf/rss-en-top" },
  { source: "DW", url: "https://rss.dw.com/rdf/rss-en-world" },
  { source: "DW", url: "https://rss.dw.com/xml/rss_en_science" },
];

const DEFAULT_STATIC_SOURCE = fileURLToPath(new URL("../english-study-weekday-hourly.md", import.meta.url));
const DICTIONARY_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const SYSTEM_WORD_LIST = "/usr/share/dict/words";
const USER_AGENT = "Mozilla/5.0 (compatible; ai-workmate/1.0)";
const WORD_COUNT = 5;
const MIN_WORDS = 3;
const RECENT_WORD_DAYS = 60;
const REVIEW_DAYS = [3, 7];
const ARTICLE_MAX_AGE_DAYS = 10;
const HANGUL = /[가-힣]/;
const POS_LABELS = { noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.", preposition: "prep.", conjunction: "conj." };
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Frequent words of five or more letters that are not worth a vocabulary slot.
const COMMON_WORDS = new Set(`
about above according across actually added after again against already also although always among
another answer anyone anything around asked became because become before began behind being believe
below better between beyond biggest called cannot change children city's clear close comes coming
company could country course daily days during early earlier either enough every everyone everything
example family father feel first found friday friends front further getting given going great group
happen happened having heard house however human important including inside instead itself known large
later least leave level little local looking major makes making matter maybe means might million minutes
money monday month months morning mother never night north number often other others outside people
percent place plans point power president probably problem public quite rather really reported right
said saturday saying school second seems several should since small social something sometimes south
start started state states still story study sunday taken taking their there these thing things think
third those though thought three through thursday times today together tuesday under until using usually
various water wednesday weeks where whether which while white whole whose woman women world would write
years young yesterday officials government country's people's minister according reported told
`.trim().split(/\s+/));

const inFlight = new Map();

// One build per chat at a time, so /english and the schedule cannot send the same lesson twice.
export function runEnglishStudy(options) {
  const key = String(options.chatId);
  if (!inFlight.has(key)) {
    inFlight.set(key, sendEnglishStudy(options).finally(() => inFlight.delete(key)));
  }
  return inFlight.get(key);
}

async function sendEnglishStudy({ telegram, chatId, personalOps, config = {}, now = new Date(), fetchImpl = fetch, staticSourcePath, wordList }) {
  const result = await buildEnglishStudy({ config, chatId, personalOps, now, fetchImpl, staticSourcePath, wordList });
  await telegram.sendMessage(chatId, result.text, { disable_web_page_preview: true });
  // Already delivered: a failed save must not be reported as a failed lesson.
  if (result.record) {
    await personalOps?.recordEnglishStudy?.({ chatId, ...result.record, now })
      .catch((error) => console.error("English study history save failed:", error.message));
  }
  return result;
}

export async function buildEnglishStudy({ config = {}, chatId, personalOps, now = new Date(), fetchImpl = fetch, staticSourcePath = DEFAULT_STATIC_SOURCE, wordList }) {
  const history = personalOps?.getEnglishStudy?.(chatId) ?? { words: [], links: [] };
  const review = reviewWords(history.words, now);
  let lesson;
  try {
    lesson = await buildNewsLesson({ history, now, fetchImpl, wordList: wordList === undefined ? await loadWordList() : wordList });
  } catch (error) {
    const fallback = await staticLesson(staticSourcePath, now, `뉴스를 가져오지 못해 기본 교재를 보냅니다 (${error.message}).`);
    if (fallback) return { mode: "static", text: fallback, record: null };
    throw error;
  }
  const translation = await translateLesson(lesson, { config, fetchImpl });
  if (!translation) {
    const fallback = await staticLesson(staticSourcePath, now, "로컬 번역 모델(Ollama)에 연결하지 못해 기본 교재를 보냅니다.");
    if (fallback) return { mode: "static", text: fallback, record: null };
  }
  const words = [];
  for (const [index, base] of lesson.words.entries()) {
    const translated = translation?.words[index] ?? {};
    let word = base;
    // Same repeat rules as the original pick: not common, not sent recently, not twice in one lesson.
    const taken = new Set([...lesson.words.map((row) => row.word), ...words.map((row) => row.word)]);
    if (translated.lemma && !COMMON_WORDS.has(translated.lemma) && !lesson.recent?.has(translated.lemma) && !taken.has(translated.lemma)) {
      const looked = lesson.dictionaryUp ? await lookupDictionary(translated.lemma, fetchImpl) : null;
      word = { ...base, word: translated.lemma, senses: looked?.entry?.senses ?? {}, ...pickSense(looked?.entry?.senses) };
    }
    // The model sees the sentence, so its part of speech decides which dictionary sense to show.
    words.push({ ...word, ...(translated.pos ? pickSense(word.senses, translated.pos) : {}), meaningKo: translated.meaningKo ?? null, sentenceKo: translated.sentenceKo ?? null });
  }
  return {
    mode: translation ? "news" : "english-only",
    text: formatEnglishStudy({ article: lesson.article, titleKo: translation?.titleKo ?? null, words, review, now }),
    record: { link: lesson.article.link, words: words.map((word) => ({ word: word.word, meaning: word.meaningKo || word.definition, pos: word.partOfSpeech })) },
  };
}

async function buildNewsLesson({ history, now, fetchImpl, wordList }) {
  const articles = await fetchArticles({ fetchImpl });
  const used = new Set(history.links);
  const recent = recentWordSet(history.words, now);
  for (const article of rankArticles(articles, used, now).slice(0, 4)) {
    const text = article.source === "BNE" ? await fetchBneText(article.link, fetchImpl) || article.description : article.description;
    // Body sentences first: a word from the headline would repeat the 📰 line as its example.
    const body = selectCandidates(splitSentences(text).filter((sentence) => sentence !== article.title), recent);
    const bodyTokens = new Set(body.map((row) => row.token));
    const headline = selectCandidates([`${article.title}.`], recent).filter((row) => !bodyTokens.has(row.token));
    const state = {};
    const words = await resolveWords([...body, ...headline], { fetchImpl, recent, wordList, state });
    if (words.length >= MIN_WORDS) return { article, words, dictionaryUp: state.dictionaryUp, wordList, recent };
  }
  throw new Error("단어를 고를 만한 새 기사가 없습니다");
}

export async function fetchArticles({ fetchImpl = fetch, feeds = ENGLISH_FEEDS } = {}) {
  const settled = await Promise.allSettled(feeds.map(async (feed) => {
    const response = await fetchImpl(feed.url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${feed.source} HTTP ${response.status}`);
    return parseFeed(await response.text(), feed);
  }));
  const articles = settled.flatMap((row) => row.status === "fulfilled" ? row.value : []);
  if (!articles.length) throw new Error("모든 영어 뉴스 피드 응답 실패");
  return articles;
}

export function parseFeed(xml, { source = "news", learner = false } = {}) {
  return [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/g)].map(([item]) => ({
    source,
    learner,
    title: cleanText(tag(item, "title")),
    link: cleanText(tag(item, "link")),
    description: cleanText(tag(item, "description")),
    publishedAt: parseDate(tag(item, "pubDate") || tag(item, "dc:date")),
  })).filter((row) => row.title && /^https?:\/\//.test(row.link));
}

export function rankArticles(articles, usedLinks, now = new Date()) {
  const maxAge = ARTICLE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set();
  return articles
    .filter((row) => !usedLinks.has(row.link) && !seen.has(row.link) && seen.add(row.link))
    .filter((row) => !row.publishedAt || now.getTime() - row.publishedAt.getTime() < maxAge)
    .filter((row) => `${row.title} ${row.description}`.length >= 60)
    // Learner-graded articles first, then the newest.
    .sort((a, b) => Number(b.learner) - Number(a.learner) || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}

async function fetchBneText(link, fetchImpl) {
  try {
    const response = await fetchImpl(link, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return "";
    const html = await response.text();
    // The first full paragraph is the article; later ones are gap-fill exercises.
    const paragraph = [...html.matchAll(/<p[^>]*>([\s\S]*?)(?=<p[\s>]|<\/p>|<div|<table)/gi)]
      .map((match) => cleanText(match[1]))
      .find((text) => text.length >= 150 && !text.includes("___"));
    return paragraph ? paragraph.slice(0, 1200) : "";
  } catch {
    return "";
  }
}

export function splitSentences(text) {
  return String(text).split(/(?<=[.!?]["”’']?)\s+/).map((row) => row.trim()).filter((row) => row.length > 3);
}

export function selectCandidates(sentences, recent = new Set(), limit = 12) {
  const candidates = [];
  const stems = new Set();
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(/[A-Za-z]+(?:'[a-z]+)?/g)) {
      const raw = match[0];
      // Capitalized tokens are names or sentence starts; neither is a good vocabulary pick.
      if (raw.includes("'") || /^[A-Z]/.test(raw) || raw.length < 5 || raw.length > 14) continue;
      const word = raw.toLowerCase();
      const stem = word.replace(/(?:ies|es|s|ed|ing|ly)$/, "");
      if (COMMON_WORDS.has(word) || recent.has(word) || recent.has(stem) || stems.has(stem)) continue;
      stems.add(stem);
      candidates.push({ token: word, sentence });
    }
  }
  // Longest words first, but one per sentence per round, so examples come from different sentences.
  const bySentence = new Map();
  for (const row of candidates.sort((a, b) => b.token.length - a.token.length)) {
    if (!bySentence.has(row.sentence)) bySentence.set(row.sentence, []);
    bySentence.get(row.sentence).push(row);
  }
  const groups = [...bySentence.values()];
  const ordered = [];
  for (let round = 0; ordered.length < candidates.length; round += 1) {
    for (const group of groups) if (group[round]) ordered.push(group[round]);
  }
  return ordered.slice(0, limit);
}

// Base forms first, "+e" restorations before bare stems (hoped -> hope, notes -> note,
// not hop/not). This is only a guess: the model confirms the lemma from the sentence.
export function lemmaCandidates(word) {
  const forms = [];
  const doubled = (base) => /([b-df-hj-np-tv-z])\1$/.test(base) ? [base.slice(0, -1)] : [];
  if (/(?:ies|ied)$/.test(word)) {
    forms.push(`${word.slice(0, -3)}y`);
  } else if (word.endsWith("ying") && word.length <= 6) {
    forms.push(`${word.slice(0, -4)}ie`, word.slice(0, -3)); // dying -> die, but not playing -> plaie
  } else if (word.endsWith("ing")) {
    const base = word.slice(0, -3);
    forms.push(`${base}e`, ...doubled(base), base);
  } else if (word.endsWith("ed")) {
    const base = word.slice(0, -2);
    forms.push(word.slice(0, -1), ...doubled(base), base);
  } else if (word.endsWith("es")) {
    forms.push(word.slice(0, -1), word.slice(0, -2));
  } else if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) {
    forms.push(word.slice(0, -1));
  }
  forms.push(word);
  return [...new Set(forms)].filter((form) => form.length >= 3);
}

let cachedWordList;
export async function loadWordList(file = SYSTEM_WORD_LIST) {
  if (cachedWordList !== undefined && file === SYSTEM_WORD_LIST) return cachedWordList;
  let list = null;
  try {
    list = new Set((await fs.readFile(file, "utf8")).split(/\r?\n/).filter((row) => /^[a-z]+$/.test(row)));
  } catch {}
  if (file === SYSTEM_WORD_LIST) cachedWordList = list;
  return list;
}

// The word list (when present) rejects typos and names; the dictionary only adds
// part of speech and definitions, because the free API is not always reachable.
export async function resolveWords(candidates, { fetchImpl = fetch, recent = new Set(), wordList = null, state = {} } = {}) {
  const words = [];
  const seen = new Set();
  state.dictionaryUp ??= true;
  for (const candidate of candidates) {
    if (words.length >= WORD_COUNT) break;
    const forms = lemmaCandidates(candidate.token);
    const lemma = wordList ? forms.find((form) => wordList.has(form)) : forms.at(-1);
    if (!lemma || seen.has(lemma) || recent.has(lemma) || COMMON_WORDS.has(lemma)) continue;
    let entry = null;
    if (state.dictionaryUp) {
      const result = await lookupDictionary(lemma, fetchImpl);
      state.dictionaryUp = result.available;
      entry = result.entry;
    }
    seen.add(lemma);
    words.push({ word: entry?.word || lemma, form: candidate.token, senses: entry?.senses || {}, ...pickSense(entry?.senses), sentence: trimSentence(candidate.sentence) });
  }
  return words;
}

export async function lookupDictionary(word, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${DICTIONARY_URL}${encodeURIComponent(word)}`, { signal: AbortSignal.timeout(6_000) });
    // 404 means an unknown word; 5xx means the service is down, so stop asking for this lesson.
    if (!response.ok) return { available: response.status < 500, entry: null };
    const entries = await response.json();
    const entry = Array.isArray(entries) ? entries[0] : null;
    const senses = {};
    for (const meaning of entry?.meanings ?? []) {
      const definition = meaning?.definitions?.[0]?.definition;
      if (!POS_LABELS[meaning?.partOfSpeech] || senses[meaning.partOfSpeech] || !definition) continue;
      senses[meaning.partOfSpeech] = {
        definition: definition.slice(0, 160),
        example: meaning.definitions.find((row) => row.example)?.example?.slice(0, 160) || "",
      };
    }
    if (!entry?.word || !Object.keys(senses).length) return { available: true, entry: null };
    return { available: true, entry: { word: String(entry.word).toLowerCase(), senses } };
  } catch {
    return { available: false, entry: null };
  }
}

// Definition and example of one part of speech; the first one unless the sentence context names another.
export function pickSense(senses = {}, pos) {
  if (senses[pos]) return { partOfSpeech: pos, ...senses[pos] };
  // A context part of speech the dictionary lacks: keep it, drop the mismatched definition.
  if (POS_LABELS[pos]) return { partOfSpeech: pos, definition: "", example: "" };
  const first = Object.keys(senses)[0];
  return first ? { partOfSpeech: first, ...senses[first] } : { partOfSpeech: "", definition: "", example: "" };
}

export async function translateLesson(lesson, { config = {}, fetchImpl = fetch } = {}) {
  const prompt = [
    "You translate English study material for a Korean learner. Reply with JSON only.",
    'Schema: {"title_ko": string, "words": [{"word": string, "lemma": string, "pos": "noun"|"verb"|"adjective"|"adverb", "meaning_ko": string, "sentence_ko": string}]}',
    "lemma: dictionary headword of the form as used in the sentence (\"raised\" -> \"raise\", the noun \"building\" stays \"building\").",
    "pos: part of speech of the form as used in the sentence (e.g. form \"travelled\" is a verb). meaning_ko: 1-3 short Korean meanings that fit the sentence, comma separated. sentence_ko: natural Korean translation of the sentence.",
    `Title: ${lesson.article.title}`,
    "Words:",
    ...lesson.words.map((word) => JSON.stringify({ word: word.word, form: word.form, sentence: word.sentence })),
  ].join("\n");
  try {
    const response = await fetchImpl(`http://127.0.0.1:${config.ollamaPort || 11434}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.localBriefingModel || "qwen3.5:latest", prompt, format: "json", stream: false, think: false, options: { temperature: 0.2, num_predict: 1400 } }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) return null;
    const parsed = JSON.parse(String((await response.json()).response || ""));
    const byWord = new Map((Array.isArray(parsed.words) ? parsed.words : []).map((row) => [String(row?.word || "").toLowerCase(), row]));
    const words = lesson.words.map((word, index) => {
      const row = byWord.get(word.word) ?? parsed.words?.[index] ?? {};
      const pos = String(row.pos || "").toLowerCase();
      return { meaningKo: korean(row.meaning_ko, 40), sentenceKo: korean(row.sentence_ko, 240), pos: POS_LABELS[pos] ? pos : null, lemma: confirmLemma(row.lemma, word, lesson.wordList) };
    });
    const titleKo = korean(parsed.title_ko, 160);
    if (!titleKo && !words.some((row) => row.meaningKo)) return null;
    return { titleKo, words };
  } catch {
    return null;
  }
}

// The model's lemma is accepted only if it is a plausible headword of the sentence form.
function confirmLemma(value, word, wordList) {
  const lemma = String(value || "").trim().toLowerCase();
  if (!/^[a-z]{3,20}$/.test(lemma) || lemma === word.word) return null;
  if (wordList && !wordList.has(lemma)) return null;
  const form = word.form || word.word;
  // "dying" -> "die" shares only one letter, so -ying/-ie pairs are matched on the stem.
  const related = form.startsWith(lemma.slice(0, 3)) || (form.endsWith("ying") && lemma.endsWith("ie") && form.startsWith(lemma.slice(0, -2)));
  return related ? lemma : null;
}

export function reviewWords(words = [], now = new Date()) {
  const today = dayNumber(now);
  return REVIEW_DAYS
    .map((days) => ({ days, words: words.filter((row) => today - dayNumber(new Date(row.sentAt)) === days).slice(0, 3) }))
    .filter((group) => group.words.length);
}

const TELEGRAM_SAFE_LENGTH = 3900;

// Telegram rejects messages over 4096 characters; drop dictionary examples, then shorten sentences.
export function formatEnglishStudy(lesson) {
  for (const compact of [0, 1, 2]) {
    const text = renderEnglishStudy(lesson, compact);
    if (text.length <= TELEGRAM_SAFE_LENGTH || compact === 2) return text.slice(0, TELEGRAM_SAFE_LENGTH);
  }
  return "";
}

function renderEnglishStudy({ article, titleKo, words, review = [], now = new Date() }, compact) {
  const clip = (text, max) => compact < 2 || text.length <= max ? text : `${text.slice(0, max - 3)}...`;
  const lines = [`📘 영어 학습 · ${kstDateLabel(now)}`, "", `📰 ${article.title}`];
  if (titleKo) lines.push(`해석: ${titleKo}`);
  lines.push("", "📚 오늘의 단어");
  for (const word of words) {
    const pos = POS_LABELS[word.partOfSpeech] ? ` (${POS_LABELS[word.partOfSpeech]})` : "";
    lines.push(`• ${word.word}${pos}${word.meaningKo || word.definition ? ` ${word.meaningKo || word.definition}` : ""}`);
    if (word.sentence) lines.push(`  “${clip(word.sentence, 120)}”`);
    if (word.sentence && word.sentenceKo) lines.push(`  → ${clip(word.sentenceKo, 100)}`);
    if (!compact && word.example && word.example !== word.sentence) lines.push(`  예: ${word.example}`);
  }
  for (const group of review) {
    lines.push("", `🔁 복습 (${group.days}일 전)`);
    lines.push(group.words.map((row) => `• ${row.word} → ?`).join("   "));
    lines.push(`  정답: ${group.words.map((row) => row.meaning || "-").join(" / ")}`);
  }
  lines.push("", `🔗 ${article.source} · ${article.link}`);
  return lines.join("\n");
}

async function staticLesson(sourcePath, now, notice) {
  try {
    const schedule = parseStudySchedule(await fs.readFile(sourcePath, "utf8"));
    const dayName = DAY_NAMES[kstParts(now).weekday];
    const slots = schedule.get(dayName);
    const hourLabel = slots?.has("12:00") ? "12:00" : slots?.keys().next().value;
    if (!hourLabel) return null;
    const message = buildStudyMessage({ schedule, dayName, hourLabel, dateLabel: kstDateLabel(now) });
    return `ℹ️ ${notice}\n\n${message}`;
  } catch {
    return null;
  }
}

function recentWordSet(words = [], now) {
  const cutoff = now.getTime() - RECENT_WORD_DAYS * 24 * 60 * 60 * 1000;
  return new Set(words.filter((row) => new Date(row.sentAt).getTime() >= cutoff).map((row) => row.word));
}

function korean(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  // Article text reaches the prompt, so links or handles in the output are rejected.
  return text && HANGUL.test(text) && text.length <= max && !/https?:|:\/\/|www\.|@/i.test(text) ? text : null;
}

function trimSentence(sentence) {
  return sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence;
}

function tag(item, name) {
  const match = item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match ? match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1") : "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/&quot;/g, "\"").replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(value) {
  const date = new Date(String(value || "").trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function kstParts(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return { month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}

function kstDateLabel(date) {
  const { month, day, weekday } = kstParts(date);
  return `${month}월 ${day}일 (${WEEKDAYS[weekday]})`;
}

function dayNumber(date) {
  return Math.floor((date.getTime() + 9 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000));
}
