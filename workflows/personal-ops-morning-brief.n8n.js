import { workflow, node, trigger, merge, expr } from '@n8n/workflow-sdk';

const morning = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Weekday 8AM',
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 0 8 * * 1-5' }] } },
    position: [240, 360],
  },
  output: [{}],
});

const weather = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Seoul Weather',
    parameters: {
      method: 'GET',
      url: 'https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.9780&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=2',
      options: { timeout: 15000, response: { response: { responseFormat: 'json', neverError: true } } },
    },
    position: [520, 80],
  },
  output: [{ current: { temperature_2m: 24, apparent_temperature: 25, relative_humidity_2m: 60, precipitation: 0, weather_code: 1, wind_speed_10m: 7 }, daily: { temperature_2m_max: [28, 29], temperature_2m_min: [20, 21], precipitation_probability_max: [20, 40] } }],
});

// Open-Meteo can occasionally return a transient overload response. An
// independent provider prevents that one error from removing weather entirely.
const weatherFallback = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Seoul Weather Fallback',
    parameters: {
      method: 'GET',
      url: 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=37.5665&lon=126.9780',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'user-agent', value: 'AI-Workmate-Morning-Brief/1.0 contact@example.invalid' }] },
      options: { timeout: 15000, response: { response: { responseFormat: 'json', neverError: true } } },
    },
    position: [520, 120],
  },
  output: [{ properties: { timeseries: [] } }],
});

const openaiFeed = node({
  type: 'n8n-nodes-base.rssFeedRead',
  version: 1.2,
  config: { name: 'OpenAI News RSS', parameters: { url: 'https://openai.com/news/rss.xml', options: { customFields: 'contentSnippet' } }, position: [520, 200] },
  output: [{ title: 'OpenAI article', link: 'https://openai.com/news/example', contentSnippet: 'Example summary' }],
});

const githubFeed = node({
  type: 'n8n-nodes-base.rssFeedRead',
  version: 1.2,
  config: { name: 'GitHub Changelog RSS', parameters: { url: 'https://github.blog/changelog/feed/', options: { customFields: 'contentSnippet' } }, position: [520, 320] },
  output: [{ title: 'GitHub changelog', link: 'https://github.blog/changelog/example', contentSnippet: 'Example summary' }],
});

const aiToolsFeed = node({
  type: 'n8n-nodes-base.rssFeedRead',
  version: 1.2,
  config: { name: 'AI Tools News', parameters: { url: 'https://news.google.com/rss/search?q=%22AI+tool%22+OR+%22AI+tools%22+OR+Cursor+OR+Copilot+OR+Perplexity+OR+Gemini+OR+ChatGPT+when:1d&hl=ko&gl=KR&ceid=KR:ko', options: { customFields: 'contentSnippet' } }, position: [520, 440] },
  output: [{ title: 'AI tools article', link: 'https://news.google.com/example', contentSnippet: 'Example summary' }],
});

const aiGeneralFeed = node({
  type: 'n8n-nodes-base.rssFeedRead',
  version: 1.2,
  config: { name: 'AI General News', parameters: { url: 'https://news.google.com/rss/search?q=%22artificial+intelligence%22+OR+OpenAI+OR+LLM+OR+%22AI+model%22+when:1d&hl=ko&gl=KR&ceid=KR:ko', options: { customFields: 'contentSnippet' } }, position: [520, 560] },
  output: [{ title: 'AI article', link: 'https://news.google.com/example', contentSnippet: 'Example summary' }],
});

const developerFeed = node({
  type: 'n8n-nodes-base.rssFeedRead',
  version: 1.2,
  config: { name: 'Developer News', parameters: { url: 'https://news.google.com/rss/search?q=programming+OR+developer+OR+javascript+OR+typescript+OR+python+OR+react+OR+node.js+OR+github+OR+open+source+when:1d&hl=ko&gl=KR&ceid=KR:ko', options: { customFields: 'contentSnippet' } }, position: [520, 680] },
  output: [{ title: 'Developer article', link: 'https://news.google.com/example', contentSnippet: 'Example summary' }],
});

const itFeed = node({
  type: 'n8n-nodes-base.rssFeedRead',
  version: 1.2,
  config: { name: 'IT General News', parameters: { url: 'https://news.google.com/rss/search?q=technology+OR+software+OR+cloud+OR+semiconductor+OR+%22developer+platform%22+when:1d&hl=ko&gl=KR&ceid=KR:ko', options: { customFields: 'contentSnippet' } }, position: [520, 800] },
  output: [{ title: 'IT article', link: 'https://news.google.com/example', contentSnippet: 'Example summary' }],
});

const combined = merge({
  version: 3.2,
  config: { name: 'Combine Morning Sources', parameters: { mode: 'append', numberInputs: 8 }, position: [840, 440] },
});

const prepareTranslations = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Morning Brief Translations',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const NL = String.fromCharCode(10);
const TRANSLATE_BASE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=';
const items = $input.all().map(i => i.json);
const compact = (value) => String(value || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[\\r\\n\\t]+/g, ' ')
  .replace(/\\s+/g, ' ')
  .trim();
const weatherCode = {
  0: '맑음',
  1: '대체로 맑음',
  2: '부분적으로 흐림',
  3: '흐림',
  45: '안개',
  48: '안개',
  51: '약한 이슬비',
  53: '이슬비',
  55: '강한 이슬비',
  61: '약한 비',
  63: '비',
  65: '강한 비',
  71: '약한 눈',
  73: '눈',
  75: '강한 눈',
  80: '소나기',
  81: '소나기',
  82: '강한 소나기',
  95: '뇌우',
};
const formatNum = (value, suffix) => Number.isFinite(Number(value)) ? String(Math.round(Number(value))) + suffix : '-';
const weatherItem = items.find(item => item.current && !item.error);
const fallbackSeries = items.find(item => Array.isArray(item?.properties?.timeseries) && item.properties.timeseries.length > 0)?.properties?.timeseries || [];
const current = weatherItem?.current || weatherItem?.current_weather || {};
const daily = weatherItem?.daily || {};
const fallbackNow = fallbackSeries[0]?.data || {};
const fallbackDetails = fallbackNow.instant?.details || {};
const fallbackWindow = fallbackSeries.slice(0, 24).map(entry => entry?.data?.instant?.details || {});
const fallbackTemps = fallbackWindow.map(value => Number(value.air_temperature)).filter(Number.isFinite);
const fallbackSymbol = fallbackNow.next_1_hours?.summary?.symbol_code || fallbackNow.next_6_hours?.summary?.symbol_code || '';
const fallbackCondition = fallbackSymbol ? fallbackSymbol.replace(/_day|_night|_polartwilight/g, '').replace(/_/g, ' ') : '정보 없음';
const condition = weatherCode[Number(current.weather_code)] || '날씨 코드 ' + String(current.weather_code ?? '-');
const weatherLines = weatherItem
  ? [
      '- 상태: 서울 ' + condition,
      '- 현재/체감: ' + formatNum(current.temperature_2m, '°C') + ' / ' + formatNum(current.apparent_temperature, '°C'),
      '- 최고/최저: ' + formatNum(daily.temperature_2m_max?.[0], '°C') + ' / ' + formatNum(daily.temperature_2m_min?.[0], '°C'),
      '- 강수확률: ' + formatNum(daily.precipitation_probability_max?.[0], '%'),
      '- 습도/풍속: ' + formatNum(current.relative_humidity_2m, '%') + ' / ' + formatNum(current.wind_speed_10m, 'km/h'),
    ]
  : fallbackSeries.length
    ? [
        '- 상태: 서울 ' + fallbackCondition,
        '- 현재: ' + formatNum(fallbackDetails.air_temperature, '°C'),
        '- 향후 24시간 최고/최저: ' + formatNum(Math.max(...fallbackTemps), '°C') + ' / ' + formatNum(Math.min(...fallbackTemps), '°C'),
        '- 습도/풍속: ' + formatNum(fallbackDetails.relative_humidity, '%') + ' / ' + formatNum(fallbackDetails.wind_speed, 'm/s'),
      ]
    : ['- 날씨 정보를 가져오지 못했습니다.'];

const bySource = new Map();
for (const item of items
  .filter(item => item.title && item.link)
  .map(item => {
    const rawTitle = compact(item.title);
    const sourceMatch = rawTitle.match(/ - ([^-]+)$/);
    const title = rawTitle.replace(/ - [^-]+$/, '');
    const summary = compact(item.contentSnippet || item.content || item.description).replace(title, '').slice(0, 220);
    const link = String(item.link || '').trim();
    const key = title.toLowerCase().replace(/[\\[\\]().,:;'"!?]/g, ' ').replace(/\\s+/g, ' ').trim();
    const hostname = (() => { try { return new URL(link).hostname; } catch { return ''; } })();
    const source = sourceMatch?.[1] || (hostname.includes('openai.com') ? 'OpenAI' : hostname.includes('github.blog') ? 'GitHub' : hostname || '기타');
    return { title, summary, link, key, source, publishedAt: Date.parse(item.isoDate || item.pubDate || '') || 0 };
  })) {
  const entries = bySource.get(item.source) || [];
  if (!entries.some(entry => entry.key === item.key)) entries.push(item);
  bySource.set(item.source, entries);
}
for (const entries of bySource.values()) entries.sort((a, b) => b.publishedAt - a.publishedAt);
const sourceQueues = [...bySource.values()];
const news = [];
// Round-robin selection prevents an early input feed from consuming all slots.
while (news.length < 8 && sourceQueues.some(queue => queue.length > 0)) {
  for (const queue of sourceQueues) {
    if (queue.length > 0 && news.length < 8) news.push(queue.shift());
  }
}

if (news.length === 0) {
  return [{
    json: {
      weatherLines,
      news: [],
      newsIndex: -1,
      translateUrl: TRANSLATE_BASE_URL + encodeURIComponent('뉴스 없음'),
    },
  }];
}

return news.map((item, index) => ({
  json: {
    weatherLines,
    news,
    newsIndex: index,
    translateUrl: TRANSLATE_BASE_URL + encodeURIComponent(item.title + NL + item.summary),
  },
}));
`,
    },
    position: [1120, 460],
  },
  output: [{ weatherLines: ['- 상태: 서울 대체로 맑음'], news: [], newsIndex: 0, translateUrl: 'https://translate.googleapis.com/translate_a/single?...' }],
});

const translateNews = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Translate News',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.translateUrl }}'),
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'user-agent', value: 'n8n-morning-brief/1.0' },
      ] },
      options: {
        response: { response: { responseFormat: 'text', outputPropertyName: 'translationBody', neverError: true } },
        timeout: 20000,
      },
    },
    position: [1360, 460],
  },
  output: [{ translationBody: '[[["번역 결과",null,null,null]]]' }],
});

const format = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Integrated Morning Brief',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const NL = String.fromCharCode(10);
const prepareItems = $('Prepare Morning Brief Translations').all();
const translatedItems = $input.all();
const firstPrepared = prepareItems[0]?.json || {};
const news = Array.isArray(firstPrepared.news) ? firstPrepared.news : [];
const weatherLines = Array.isArray(firstPrepared.weatherLines) ? firstPrepared.weatherLines : ['- 날씨 정보를 가져오지 못했습니다.'];

const parseTranslatedText = (body) => {
  try {
    const payload = JSON.parse(String(body || '[]'));
    return Array.isArray(payload?.[0])
      ? payload[0].map(part => Array.isArray(part) ? String(part[0] || '') : '').join('').trim()
      : '';
  } catch (error) {
    return '';
  }
};

const translatedByIndex = new Map();
for (const [fallbackIndex, item] of translatedItems.entries()) {
  const pairedIndex = item.pairedItem?.item;
  const prepared = Number.isInteger(pairedIndex) ? prepareItems[pairedIndex]?.json : prepareItems[fallbackIndex]?.json;
  const newsIndex = Number(prepared?.newsIndex);
  if (!Number.isInteger(newsIndex) || newsIndex < 0) continue;
  const translated = parseTranslatedText(item.json.translationBody);
  const parts = translated.split(/\\r?\\n/).map(value => value.trim()).filter(Boolean);
  translatedByIndex.set(newsIndex, {
    title: parts[0] || '',
    summary: parts.slice(1).join(' '),
  });
}

const nowLabel = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).format(new Date());

const lines = ['[모닝 브리핑]', nowLabel, '', '[오늘의 날씨]', ...weatherLines, '', '[AI/IT 주요 뉴스]'];
if (news.length) {
  for (const [index, item] of news.entries()) {
    const translated = translatedByIndex.get(index) || {};
    lines.push(String(index + 1) + '. ' + (translated.title || item.title));
    if (translated.summary || item.summary) lines.push('   - ' + (translated.summary || item.summary));
    lines.push('   ' + item.link);
  }
} else {
  lines.push('- 가져온 뉴스가 없습니다.');
}

let message = lines.join(NL);
if (message.length > 3900) message = message.slice(0, 3850) + NL + NL + '(메시지 길이 제한으로 일부 생략)';
return [{ json: { message, newsCount: news.length } }];
`,
    },
    position: [1600, 460],
  },
  output: [{ message: '[모닝 브리핑]\n...', newsCount: 8 }],
});

const send = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send Morning Brief',
    parameters: {
      method: 'POST',
      url: 'https://api.telegram.org/botYOUR_TELEGRAM_BOT_TOKEN/sendMessage',
      sendBody: true,
      contentType: 'form-urlencoded',
      bodyParameters: { parameters: [
        { name: 'chat_id', value: 'YOUR_TELEGRAM_CHAT_ID' },
        { name: 'text', value: expr('{{ $json.message }}') },
        { name: 'disable_web_page_preview', value: 'true' },
      ] },
    },
    position: [1840, 460],
  },
  output: [{ ok: true }],
});

export default workflow('yAXfm2rCd2B8rcLX', 'AI Workmate - Morning Brief')
  .add(morning).to(weather.to(combined.input(0)))
  .add(morning).to(weatherFallback.to(combined.input(1)))
  .add(morning).to(openaiFeed.to(combined.input(2)))
  .add(morning).to(githubFeed.to(combined.input(3)))
  .add(morning).to(aiToolsFeed.to(combined.input(4)))
  .add(morning).to(aiGeneralFeed.to(combined.input(5)))
  .add(morning).to(developerFeed.to(combined.input(6)))
  .add(morning).to(itFeed.to(combined.input(7)))
  .add(combined).to(prepareTranslations).to(translateNews).to(format).to(send);
