import { workflow, node, trigger, merge, newCredential, placeholder, expr } from '@n8n/workflow-sdk';

const schedule = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Daily 8PM', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 0 20 * * *' }] } }, position: [240, 300] }, output: [{}] });
const openaiFeed = node({ type: 'n8n-nodes-base.rssFeedRead', version: 1.2, config: { name: 'OpenAI News RSS', parameters: { url: 'https://openai.com/news/rss.xml', options: { customFields: 'contentSnippet' } }, position: [520, 180] }, output: [{ title: 'Example OpenAI article', link: 'https://openai.com/news/example', contentSnippet: 'Example summary' }] });
const githubFeed = node({ type: 'n8n-nodes-base.rssFeedRead', version: 1.2, config: { name: 'GitHub Changelog RSS', parameters: { url: 'https://github.blog/changelog/feed/', options: { customFields: 'contentSnippet' } }, position: [520, 420] }, output: [{ title: 'Example GitHub change', link: 'https://github.blog/changelog/example', contentSnippet: 'Example summary' }] });
const combined = merge({ version: 3.2, config: { name: 'Combine Research Sources', parameters: { mode: 'append', numberInputs: 2 }, position: [780, 300] } });
const format = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Research Digest', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const seen = new Set();\nconst entries = $input.all().map(i => i.json).filter(x => x.title && x.link).filter(x => { const key = String(x.title).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 10);\nconst lines = ['[AI / 개발 리서치 다이제스트]', new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), ''];\nfor (const [index, entry] of entries.entries()) { const summary = String(entry.contentSnippet || entry.content || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 240); lines.push((index + 1) + '. ' + entry.title, summary ? '- ' + summary : '- 본문 요약 없음', entry.link, ''); }\nreturn [{ json: { text: lines.join('\\n').slice(0, 3900), count: entries.length } }];" }, position: [1020, 300] },
  output: [{ text: '[AI / 개발 리서치 다이제스트]\n...', count: 2 }]
});
const send = node({ type: 'n8n-nodes-base.telegram', version: 1.2, config: { name: 'Send Research Digest', parameters: { resource: 'message', operation: 'sendMessage', chatId: placeholder('Your Telegram numeric chat ID'), text: expr('{{ $json.text }}'), replyMarkup: 'none', additionalFields: { appendAttribution: false, disable_web_page_preview: true } }, credentials: { telegramApi: newCredential('AI Workmate Telegram') }, position: [1280, 300] }, output: [{ ok: true, result: { message_id: 1, text: 'digest' } }] });

export default workflow('ai-workmate-research-digest', 'AI Workmate - Research Digest')
  .add(schedule).to(openaiFeed.to(combined.input(0)))
  .add(schedule).to(githubFeed.to(combined.input(1)))
  .add(combined).to(format).to(send);
