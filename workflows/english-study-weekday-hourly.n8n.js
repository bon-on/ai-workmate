const schedule = node({
  type: "n8n-nodes-base.scheduleTrigger",
  version: 1.3,
  config: {
    name: "매일 영어 학습 트리거",
    position: [180, 280],
    parameters: {
      rule: {
        interval: [
          {
            field: "cronExpression",
            expression: "0 0 12,19 * * *",
          },
        ],
      },
    },
  },
});

const createFeedSources = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "피드 목록 만들기",
    position: [420, 280],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: `
return [
  {
    json: {
      sourceName: 'Breaking News English',
      url: 'https://breakingnewsenglish.com/bne.rss',
    },
  },
  {
    json: {
      sourceName: 'DW Top Stories',
      url: 'https://rss.dw.com/rdf/rss-en-top',
    },
  },
  {
    json: {
      sourceName: 'DW World',
      url: 'https://rss.dw.com/rdf/rss-en-world',
    },
  },
  {
    json: {
      sourceName: 'DW Science',
      url: 'https://rss.dw.com/xml/rss_en_science',
    },
  },
];
`,
    },
  },
});

const fetchFeeds = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "피드 가져오기",
    position: [660, 280],
    parameters: {
      method: "GET",
      url: "={{ $json.url }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "user-agent", value: "n8n-english-study-bot/1.0" },
          { name: "accept", value: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8" },
        ],
      },
      options: {
        redirect: {
          redirect: {
            followRedirects: true,
            maxRedirects: 5,
          },
        },
        response: {
          response: {
            responseFormat: "text",
            outputPropertyName: "body",
          },
        },
        timeout: 20000,
      },
    },
  },
});

const parseFeeds = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "피드 파싱",
    position: [900, 280],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: `
const newline = String.fromCharCode(10);
const sourceNames = [
  'Breaking News English',
  'DW Top Stories',
  'DW World',
  'DW Science',
];

const decodeHtml = (input) => String(input || '')
  .replace(/<!\\\\[CDATA\\\\[([\\\\s\\\\S]*?)\\\\]\\\\]>/g, '$1')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&mdash;/g, '-')
  .replace(/&ndash;/g, '-')
  .replace(/&nbsp;/g, ' ');

const collapseBlankLines = (text) => {
  let output = text;
  const triple = newline + newline + newline;
  const double = newline + newline;
  while (output.includes(triple)) output = output.split(triple).join(double);
  return output;
};

const stripTags = (input) => collapseBlankLines(decodeHtml(input)
  .replace(/<script[\\\\s\\\\S]*?<\\\\/script>/gi, ' ')
  .replace(/<style[\\\\s\\\\S]*?<\\\\/style>/gi, ' ')
  .replace(/<br\\\\s*\\\\/?>/gi, newline)
  .replace(/<\\\\/p>/gi, newline)
  .replace(/<[^>]+>/g, ' ')
  .replace(/\\\\r/g, '')
  .replace(/[ \\\\t]+/g, ' ')
  .trim());

const normalizeDescription = (text) => text
  .replace(/^[A-Za-z]{3,9} \\d{1,2}, \\d{4}\\.\\s*/, '')
  .replace(/^[A-Za-z]{3,9} \\d{1,2}, \\d{4}\\s*/, '')
  .replace(/^Listen to this story\\.?\\s*/i, '')
  .replace(/^Read more\\.?\\s*/i, '')
  .trim();

const cleanSentence = (text) => normalizeDescription(stripTags(text))
  .replace(/\\s+/g, ' ')
  .trim();

const extractTag = (chunk, tagNames) => {
  const names = Array.isArray(tagNames) ? tagNames : [tagNames];
  const lowerChunk = chunk.toLowerCase();

  for (const rawName of names) {
    const tagName = String(rawName).toLowerCase();
    const openStart = lowerChunk.indexOf('<' + tagName);
    if (openStart < 0) continue;

    const openEnd = lowerChunk.indexOf('>', openStart);
    if (openEnd < 0) continue;

    const closeStart = lowerChunk.indexOf('</' + tagName + '>', openEnd + 1);
    if (closeStart < 0) continue;

    return decodeHtml(chunk.slice(openEnd + 1, closeStart)).trim();
  }

  return '';
};

const splitItems = (xml) => {
  const matches = xml.match(/<item\\\\b[\\\\s\\\\S]*?<\\\\/item>/gi);
  if (matches && matches.length > 0) return matches;

  const parts = xml.split(/<item\\\\b/gi).slice(1);
  return parts
    .map((part) => '<item ' + part)
    .map((part) => {
      const endIndex = part.search(/<\\\\/item>/i);
      return endIndex >= 0 ? part.slice(0, endIndex + 7) : '';
    })
    .filter(Boolean);
};

const results = [];
const debug = [];

for (const item of $input.all()) {
  const xml = String(item.json.body || '');
  const sourceIndex = item.pairedItem?.item ?? 0;
  const sourceName = sourceNames[sourceIndex] || ('Source ' + String(sourceIndex + 1));
  const itemMatches = splitItems(xml);
  let parsedCount = 0;

  for (const chunk of itemMatches) {
    const title = cleanSentence(extractTag(chunk, 'title'));
    const description = cleanSentence(extractTag(chunk, 'description'));
    const link = cleanSentence(extractTag(chunk, 'link'));
    const pubDate = cleanSentence(extractTag(chunk, ['pubDate', 'dc:date']));
    if (!title || !description) continue;
    if (title.startsWith('Materials related') || title.startsWith('... and')) continue;
    parsedCount += 1;
    results.push({
      json: {
        sourceName,
        title,
        description,
        link,
        pubDate,
      },
    });
  }

  debug.push({
    sourceName,
    xmlLength: xml.length,
    itemMatchCount: itemMatches.length,
    parsedCount,
  });
}

if (results.length === 0) {
  throw new Error('피드 파싱 결과가 0건입니다: ' + JSON.stringify(debug));
}

return results;
`,
    },
  },
});

const selectEntries = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "원문 5개 선택",
    position: [1140, 280],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: `
const ENTRY_COUNT = 5;
const WORDS_PER_ENTRY = 3;
const WORD_CANDIDATE_LIMIT = 12;
const HISTORY_LIMIT = 800;
const TRANSLATE_BASE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=';
const WORD_LOOKUP_BASE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&dt=bd&q=';
const DICTIONARY_LOOKUP_BASE_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const stopWords = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'before',
  'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'during', 'even', 'for', 'from',
  'get', 'had', 'has', 'have', 'he', 'her', 'his', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'more', 'most', 'new', 'not', 'of', 'on', 'one', 'or', 'our', 'out', 'over', 's',
  'she', 'so', 'some', 'than', 'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to',
  'up', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you',
]);
const denyWords = new Set([
  'article', 'attack', 'attacks', 'country', 'countries', 'expert', 'experts', 'leader', 'leaders',
  'crack', 'people', 'president', 'problem', 'problems', 'report', 'reports', 'state', 'story',
]);
const allowedPos = new Set(['noun', 'verb', 'adjective', 'adverb']);
const posHintOverrides = {
  adopt: 'verb',
  accuses: 'verb',
  accused: 'adjective',
  affects: 'verb',
  alleged: 'adjective',
  adopted: 'verb',
  adopting: 'verb',
  adopts: 'verb',
  arenas: 'noun',
  away: 'adverb',
  cracks: 'verb',
  groups: 'noun',
  objected: 'verb',
  objects: 'verb',
};

const normalizeLink = (link) => {
  const value = String(link || '').trim();
  if (!value) return '';
  return value.replace(/\\?.*$/, '').toLowerCase();
};

const entryKey = (entry) => {
  const normalizedLink = normalizeLink(entry.link);
  return normalizedLink || (entry.title + '|' + entry.description).trim().toLowerCase();
};
const parseDateValue = (value) => {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const cleanToken = (token) => String(token || '')
  .replace(/[’']/g, "'")
  .replace(/'s$/i, '')
  .replace(/^'+|'+$/g, '');

const isProperNounToken = (token) => {
  const cleaned = cleanToken(token);
  if (!cleaned) return false;
  if (/^[A-Z]{2,}$/.test(cleaned)) return true;
  if (/[a-z][A-Z]/.test(cleaned)) return true;
  return /^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/.test(cleaned);
};

const guessPos = (word, original) => {
  const originalLower = cleanToken(original).toLowerCase();
  const lower = word.toLowerCase();
  if (posHintOverrides[originalLower]) return posHintOverrides[originalLower];
  if (posHintOverrides[lower]) return posHintOverrides[lower];
  if (/ly$/.test(originalLower) || /ly$/.test(lower)) return 'adverb';
  if (/(ing|ed)$/.test(originalLower)) return 'verb';
  if (isProperNounToken(original)) return 'proper noun';
  if (originalLower !== lower && /s$/.test(originalLower) && /(ce|ct|fy|ise|ize|ate|ute|en)$/.test(lower)) return 'verb';
  if (/ly$/.test(lower)) return 'adverb';
  if (/(ing|ed|ize|ise|fy|en)$/.test(lower)) return 'verb';
  if (/(ous|ful|less|able|ible|al|ive|ic|ish|ary)$/.test(lower)) return 'adjective';
  return 'noun';
};

const toLemma = (word, original) => {
  const lower = cleanToken(word).toLowerCase();
  if (isProperNounToken(original)) return lower;

  const irregular = {
    affects: 'affect',
    accused: 'accuse',
    accuses: 'accuse',
    alleged: 'alleged',
    became: 'become',
    died: 'die',
    objects: 'object',
    objected: 'object',
    adopted: 'adopt',
    adopts: 'adopt',
    adopting: 'adopt',
    groups: 'group',
    arenas: 'arena',
  };
  if (irregular[lower]) return irregular[lower];

  if (lower.length > 4 && /ies$/.test(lower)) return lower.slice(0, -3) + 'y';
  if (lower.length > 5 && /ing$/.test(lower)) {
    const base = lower.slice(0, -3);
    if (/(tt|pp|ll|gg|nn|mm|rr)$/.test(base)) return base.slice(0, -1);
    if (/v$/.test(base)) return base + 'e';
    return base;
  }
  if (lower.length > 4 && /ed$/.test(lower)) {
    const base = lower.slice(0, -2);
    if (/(tt|pp|ll|gg|nn|mm|rr)$/.test(base)) return base.slice(0, -1);
    if (/[bcdfghjklmnpqrstvwxyz]at$/.test(base) || /[bcdfghjklmnpqrstvwxyz]iz$/.test(base)) return base + 'e';
    if (/[bcdfghjklmnpqrstvwxyz][aeiou][bcdfghjklmnpqrstvwxyz]$/.test(base) && !/e$/.test(base)) return base;
    return base;
  }
  if (lower.length > 4 && /es$/.test(lower) && /(ses|xes|zes|ches|shes)$/.test(lower)) return lower.slice(0, -2);
  if (lower.length > 3 && /s$/.test(lower) && !/(ss|us|is)$/.test(lower)) return lower.slice(0, -1);
  return lower;
};

const extractKeywordCandidates = (entry) => {
  const tokens = (entry.title + ' ' + entry.description).match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const counts = new Map();
  const originals = new Map();
  const lemmas = new Map();

  for (const token of tokens) {
    if (isProperNounToken(token)) continue;
    const normalized = cleanToken(token).toLowerCase();
    if (stopWords.has(normalized) || normalized.length < 4) continue;
    const lemma = toLemma(normalized, token);
    if (denyWords.has(lemma)) continue;
    counts.set(lemma, (counts.get(lemma) || 0) + 1);
    if (!originals.has(lemma)) originals.set(lemma, token);
    if (!lemmas.has(lemma)) lemmas.set(lemma, normalized);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, WORD_CANDIDATE_LIMIT)
    .map(([word, count]) => ({
      word,
      original: originals.get(word) || word,
      sourceWord: lemmas.get(word) || word,
      pos: guessPos(word, originals.get(word) || word),
      score: count,
    }));
};

const isAllowedKeyword = (candidate) => allowedPos.has(candidate.pos);

const unique = new Map();
for (const item of $input.all()) {
  const entry = item.json;
  const key = entryKey(entry);
  if (!unique.has(key)) unique.set(key, entry);
}

const mergedEntries = [...unique.values()].sort((a, b) => parseDateValue(b.pubDate) - parseDateValue(a.pubDate));
const staticData = $getWorkflowStaticData('global');
const sentHistory = Array.isArray(staticData.englishStudySentHistory) ? staticData.englishStudySentHistory : [];
const sentSet = new Set(sentHistory);

if (mergedEntries.length < ENTRY_COUNT) {
  throw new Error('수집 가능한 원문이 5개 미만입니다: ' + mergedEntries.length);
}

let selectedEntries = mergedEntries.filter((entry) => !sentSet.has(entryKey(entry))).slice(0, ENTRY_COUNT);
let resetHistory = false;

if (selectedEntries.length < ENTRY_COUNT) {
  resetHistory = true;
  selectedEntries = mergedEntries.slice(0, ENTRY_COUNT);
}

staticData.englishStudyPendingHistoryKeys = selectedEntries.map((entry) => entryKey(entry)).slice(-HISTORY_LIMIT);
staticData.englishStudyPendingResetHistory = resetHistory;

const usedLemmas = new Set();

return selectedEntries.map((entry) => {
  const candidates = extractKeywordCandidates(entry).filter(isAllowedKeyword);
  const uniqueWords = candidates.filter((candidate) => !usedLemmas.has(candidate.word)).slice(0, WORDS_PER_ENTRY);
  const fallbackWords = candidates
    .filter((candidate) => !uniqueWords.some((selected) => selected.word === candidate.word))
    .slice(0, Math.max(0, WORDS_PER_ENTRY - uniqueWords.length));
  const words = uniqueWords.concat(fallbackWords).slice(0, WORDS_PER_ENTRY);
  for (const word of words) usedLemmas.add(word.word);
  return {
    json: {
      ...entry,
      words,
      titleTranslateUrl: TRANSLATE_BASE_URL + encodeURIComponent(entry.title),
      descriptionTranslateUrl: TRANSLATE_BASE_URL + encodeURIComponent(entry.description),
      wordLookupBaseUrl: WORD_LOOKUP_BASE_URL,
      dictionaryLookupBaseUrl: DICTIONARY_LOOKUP_BASE_URL,
    },
  };
});
`,
    },
  },
});

const translateTitle = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "제목 번역",
    position: [1380, 120],
    parameters: {
      method: "GET",
      url: "={{ $('원문 5개 선택').all()[$itemIndex].json.titleTranslateUrl }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "user-agent", value: "n8n-english-study-bot/1.0" },
        ],
      },
      options: {
        response: {
          response: {
            responseFormat: "text",
            outputPropertyName: "titleTranslationBody",
          },
        },
        timeout: 20000,
      },
    },
  },
});

const translateDescription = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "본문 번역",
    position: [1620, 200],
    parameters: {
      method: "GET",
      url: "={{ $('원문 5개 선택').all()[$itemIndex].json.descriptionTranslateUrl }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "user-agent", value: "n8n-english-study-bot/1.0" },
        ],
      },
      options: {
        response: {
          response: {
            responseFormat: "text",
            outputPropertyName: "descriptionTranslationBody",
          },
        },
        timeout: 20000,
      },
    },
  },
});

const expandWordRequests = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "단어 조회 펼치기",
    position: [1860, 280],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: `
const entries = $('원문 5개 선택').all();

return entries.flatMap((item, entryIndex) => {
  const words = Array.isArray(item.json.words) ? item.json.words : [];
  return words.map((word, wordIndex) => ({
    json: {
      entryIndex,
      wordIndex,
      word: word.word,
      original: word.original,
      sourceWord: word.sourceWord,
      pos: word.pos,
      wordLookupUrl: item.json.wordLookupBaseUrl + encodeURIComponent(word.word || word.sourceWord),
      dictionaryLookupUrl: item.json.dictionaryLookupBaseUrl + encodeURIComponent(word.word),
    },
  }));
});
`,
    },
  },
});

const lookupWordDetails = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "단어 뜻 조회",
    position: [2100, 280],
    parameters: {
      method: "GET",
      url: "={{ $json.wordLookupUrl }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "user-agent", value: "n8n-english-study-bot/1.0" },
        ],
      },
      options: {
        response: {
          response: {
            responseFormat: "text",
            outputPropertyName: "wordLookupBody",
          },
        },
        timeout: 20000,
      },
    },
  },
});

const lookupDictionaryDetails = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "단어 사전 조회",
    position: [2220, 280],
    parameters: {
      method: "GET",
      url: "={{ $('단어 조회 펼치기').all()[$itemIndex].json.dictionaryLookupUrl }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "user-agent", value: "n8n-english-study-bot/1.0" },
          { name: "accept", value: "application/json" },
        ],
      },
      options: {
        response: {
          response: {
            responseFormat: "text",
            outputPropertyName: "dictionaryLookupBody",
            neverError: true,
          },
        },
        timeout: 20000,
      },
    },
  },
});

const buildMessage = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "메시지 조립",
    position: [2460, 280],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: `
const newline = String.fromCharCode(10);
const baseItems = $('원문 5개 선택').all();
const titleItems = $('제목 번역').all();
const descriptionItems = $('본문 번역').all();
const wordRequestItems = $('단어 조회 펼치기').all();
const MAX_MESSAGE_LENGTH = 3500;
const ENTRY_SEPARATOR = '━━━━━━━━━━━━';

const parseTranslatedText = (body) => {
  const payload = JSON.parse(body || '[]');
  return Array.isArray(payload?.[0]) ? payload[0].map((part) => Array.isArray(part) ? part[0] : '').join('').trim() : '';
};

const normalizePos = (value) => String(value || '').trim().toLowerCase();

const parseWordLookup = (body, fallbackPos) => {
  try {
    const payload = JSON.parse(body || '[]');
    const primaryMeaning = Array.isArray(payload?.[0])
      ? payload[0].map((part) => Array.isArray(part) ? String(part[0] || '') : '').join('').trim()
      : '';
    const dictionaryEntries = Array.isArray(payload?.[1]) ? payload[1] : [];
    const additionalMeanings = [];
    const normalizedFallbackPos = normalizePos(fallbackPos);
    const prioritizedEntries = normalizedFallbackPos
      ? [
          ...dictionaryEntries.filter((entry) => normalizePos(entry?.[0]) === normalizedFallbackPos),
          ...dictionaryEntries.filter((entry) => normalizePos(entry?.[0]) !== normalizedFallbackPos),
        ]
      : dictionaryEntries;
    const matchingEntries = normalizedFallbackPos
      ? prioritizedEntries.filter((entry) => normalizePos(entry?.[0]) === normalizedFallbackPos)
      : [];
    const selectedEntries = matchingEntries.length > 0 ? matchingEntries : prioritizedEntries;
    let resolvedPos = fallbackPos || '';
    const selectedMeanings = [];

    for (const entry of selectedEntries) {
      const pos = String(entry?.[0] || '').trim();
      const meanings = Array.isArray(entry?.[1]) ? entry[1] : [];
      if (!resolvedPos && pos) resolvedPos = pos;
      for (const meaning of meanings) {
        const cleaned = String(meaning || '').trim();
        if (!cleaned) continue;
        if (!selectedMeanings.includes(cleaned)) selectedMeanings.push(cleaned);
        if (selectedMeanings.length >= 4) break;
      }
      if (selectedMeanings.length >= 4) break;
    }

    const resolvedPrimaryMeaning = matchingEntries.length > 0 && selectedMeanings.length > 0
      ? selectedMeanings[0]
      : primaryMeaning;
    for (const meaning of selectedMeanings) {
      if (!meaning || meaning === resolvedPrimaryMeaning) continue;
      if (!additionalMeanings.includes(meaning)) additionalMeanings.push(meaning);
      if (additionalMeanings.length >= 3) break;
    }

    return {
      primaryMeaning: resolvedPrimaryMeaning || '번역 실패',
      additionalMeanings: additionalMeanings.slice(0, 3),
      pos: resolvedPos || fallbackPos || 'unknown',
    };
  } catch (error) {
    return {
      primaryMeaning: '번역 실패',
      additionalMeanings: [],
      pos: fallbackPos || 'unknown',
    };
  }
};

const parseDictionaryLookup = (body, fallbackPos) => {
  try {
    const payload = JSON.parse(body || '[]');
    const entries = Array.isArray(payload) ? payload : [];
    const firstEntry = entries[0];

    if (!firstEntry || firstEntry.title === 'No Definitions Found') {
      return {
        dictionaryPos: fallbackPos || 'unknown',
        synonyms: [],
      };
    }

    const meanings = Array.isArray(firstEntry.meanings) ? firstEntry.meanings : [];
    const normalizedFallbackPos = normalizePos(fallbackPos);
    const prioritizedMeanings = [
      ...meanings.filter((meaning) => normalizePos(meaning?.partOfSpeech) === normalizedFallbackPos),
      ...meanings.filter((meaning) => normalizePos(meaning?.partOfSpeech) !== normalizedFallbackPos),
    ];

    const synonyms = [];
    let dictionaryPos = '';

    for (const meaning of prioritizedMeanings) {
      const partOfSpeech = String(meaning?.partOfSpeech || '').trim();
      if (!dictionaryPos && partOfSpeech) dictionaryPos = partOfSpeech;

      const definitions = Array.isArray(meaning?.definitions) ? meaning.definitions : [];
      for (const definition of definitions) {
        const synonymSources = [
          ...(Array.isArray(definition?.synonyms) ? definition.synonyms : []),
          ...(Array.isArray(meaning?.synonyms) ? meaning.synonyms : []),
        ];
        for (const synonym of synonymSources) {
          const cleaned = String(synonym || '').trim();
          if (!cleaned || synonyms.includes(cleaned)) continue;
          synonyms.push(cleaned);
          if (synonyms.length >= 4) break;
        }

        if (synonyms.length >= 3) break;
      }

      if (synonyms.length >= 3) break;
    }

    return {
      dictionaryPos: dictionaryPos || fallbackPos || 'unknown',
      synonyms: synonyms.slice(0, 3),
    };
  } catch (error) {
    return {
      dictionaryPos: fallbackPos || 'unknown',
      synonyms: [],
    };
  }
};

const wordLookupMap = new Map();
const dictionaryLookupMap = new Map();
for (const item of $('단어 뜻 조회').all()) {
  const requestIndex = item.pairedItem?.item;
  const requestItem = Number.isInteger(requestIndex) ? wordRequestItems[requestIndex] : null;
  const entryIndex = Number(requestItem?.json?.entryIndex);
  const wordIndex = Number(requestItem?.json?.wordIndex);
  const fallbackPos = requestItem?.json?.pos;
  if (!Number.isInteger(entryIndex) || !Number.isInteger(wordIndex)) continue;
  wordLookupMap.set(entryIndex + ':' + wordIndex, parseWordLookup(item.json.wordLookupBody, fallbackPos));
}

for (const item of $input.all()) {
  const requestIndex = item.pairedItem?.item;
  const requestItem = Number.isInteger(requestIndex) ? wordRequestItems[requestIndex] : null;
  const entryIndex = Number(requestItem?.json?.entryIndex);
  const wordIndex = Number(requestItem?.json?.wordIndex);
  const fallbackPos = requestItem?.json?.pos;
  if (!Number.isInteger(entryIndex) || !Number.isInteger(wordIndex)) continue;
  dictionaryLookupMap.set(entryIndex + ':' + wordIndex, parseDictionaryLookup(item.json.dictionaryLookupBody, fallbackPos));
}

const buildWordLines = (words) => {
  if (words.length === 0) return ['주요 단어', '없음'];
  const meaningOverrides = {
    alleged: { meanings: ['혐의를 받는', '주장된', '소위의'], pos: 'adjective' },
    crackdown: { meanings: ['단속', '탄압', '강력한 단속'], pos: 'noun' },
  };
  const posLabels = {
    noun: '명사',
    verb: '동사',
    adjective: '형용사',
    adverb: '부사',
    pronoun: '대명사',
    preposition: '전치사',
    conjunction: '접속사',
    interjection: '감탄사',
    propernoun: '고유명사',
    'proper noun': '고유명사',
    unknown: '품사 미상',
  };
  const toPosLabel = (value) => {
    const normalized = normalizePos(value).replace(/\s+/g, '');
    return posLabels[normalized] || String(value || '품사 미상');
  };
  const lines = ['주요 단어'];
  for (const item of words) {
    const displayWord = item.word || item.sourceWord || item.original;
    const override = meaningOverrides[String(displayWord || '').toLowerCase()];
    const meanings = [];
    const meaningSource = override?.meanings || [item.primaryMeaning, ...(item.additionalMeanings || [])];
    for (const meaning of meaningSource) {
      const cleaned = String(meaning || '').trim();
      if (!cleaned || cleaned === '번역 실패' || meanings.includes(cleaned)) continue;
      meanings.push(cleaned);
      if (meanings.length >= 3) break;
    }
    lines.push('- ' + displayWord);
    lines.push('  뜻: ' + (meanings.length > 0 ? meanings.join(', ') : '없음') + ' (' + toPosLabel(override?.pos || item.dictionaryPos || item.pos) + ')');
    if (item.synonyms.length > 0) lines.push('  유의어: ' + item.synonyms.join(', '));
  }
  return lines;
};

const items = baseItems.map((baseItem, index) => {
  const base = baseItem?.json || {};
  const titleBody = titleItems[index]?.json?.titleTranslationBody || '';
  const descriptionBody = descriptionItems[index]?.json?.descriptionTranslationBody || '';
  const words = (base.words || []).map((word, wordIndex) => ({
    ...word,
    primaryMeaning: '번역 실패',
    additionalMeanings: [],
    pos: word.pos,
    ...wordLookupMap.get(index + ':' + wordIndex),
    dictionaryPos: word.pos,
    synonyms: [],
    ...dictionaryLookupMap.get(index + ':' + wordIndex),
  }));
  return {
    ...base,
    titleKo: parseTranslatedText(titleBody),
    descriptionKo: parseTranslatedText(descriptionBody),
    words,
  };
});

const entryBlock = (entry, index) => [
  ENTRY_SEPARATOR,
  '[' + String(index + 1) + '] ' + entry.title,
  '제목 해석: ' + (entry.titleKo || '번역 실패'),
  '원문: ' + entry.description,
  '해석: ' + (entry.descriptionKo || '번역 실패'),
  '',
  ...buildWordLines(entry.words),
  '출처: ' + entry.sourceName,
].join(newline);

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
}).formatToParts(new Date()).reduce((acc, part) => {
  if (part.type !== 'literal') acc[part.type] = part.value;
  return acc;
}, {});

const slot = Number(parts.hour) >= 18 ? '19:00' : '12:00';
const staticData = $getWorkflowStaticData('global');
const previousHistory = Array.isArray(staticData.englishStudySentHistory) ? staticData.englishStudySentHistory : [];
const pendingKeys = Array.isArray(staticData.englishStudyPendingHistoryKeys) ? staticData.englishStudyPendingHistoryKeys : [];
const resetHistory = Boolean(staticData.englishStudyPendingResetHistory);

staticData.englishStudySentHistory = resetHistory
  ? pendingKeys
  : [...previousHistory, ...pendingKeys].slice(-800);
staticData.englishStudyLastRunAt = new Date().toISOString();

const headerLines = [
  'English Study Feed',
  parts.year + '-' + parts.month + '-' + parts.day + ' ' + slot,
  '원문 ' + String(items.length) + '개',
  '구성: 제목 / 해석 / 원문 / 단어',
  '출처: ' + [...new Set(items.map((entry) => entry.sourceName))].join(', '),
];

const blocks = items.map((entry, index) => entryBlock(entry, index));
const chunks = [];
let currentBlocks = [];

for (const block of blocks) {
  const candidateBlocks = currentBlocks.concat(block);
  const candidateMessage = [
    ...headerLines,
    '메시지 1/1',
    '',
    candidateBlocks.join(newline + newline),
  ].join(newline);

  if (currentBlocks.length > 0 && candidateMessage.length > MAX_MESSAGE_LENGTH) {
    chunks.push(currentBlocks);
    currentBlocks = [block];
    continue;
  }

  currentBlocks = candidateBlocks;
}

if (currentBlocks.length > 0) {
  chunks.push(currentBlocks);
}

return chunks.map((chunkBlocks, chunkIndex) => ({
  json: {
    message: [
      ...headerLines,
      '메시지 ' + String(chunkIndex + 1) + '/' + String(chunks.length),
      '',
      chunkBlocks.join(newline + newline),
    ].join(newline),
    date: parts.year + '-' + parts.month + '-' + parts.day,
    slot,
    itemCount: items.length,
    chunkIndex: chunkIndex + 1,
    chunkCount: chunks.length,
  },
}));
`,
    },
  },
});

const sendTelegram = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "텔레그램 전송",
    position: [2580, 280],
    parameters: {
      method: "POST",
      url: "https://api.telegram.org/botYOUR_TELEGRAM_BOT_TOKEN/sendMessage",
      sendBody: true,
      contentType: "form-urlencoded",
      bodyParameters: {
        parameters: [
          { name: "chat_id", value: "YOUR_TELEGRAM_CHAT_ID" },
          { name: "text", value: "={{ $json.message }}" },
          { name: "disable_web_page_preview", value: "true" },
        ],
      },
    },
  },
});

export default workflow("englishStudyDailyTwice", "Daily English Study Telegram Sender Active")
  .add(schedule)
  .to(createFeedSources)
  .to(fetchFeeds)
  .to(parseFeeds)
  .to(selectEntries)
  .to(translateTitle)
  .to(translateDescription)
  .to(expandWordRequests)
  .to(lookupWordDetails)
  .to(lookupDictionaryDetails)
  .to(buildMessage)
  .to(sendTelegram);
