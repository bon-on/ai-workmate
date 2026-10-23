import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdown-render.js";

test("renderMarkdown renders common report structure", () => {
  const html = renderMarkdown([
    "# 보고서", "", "핵심 **결론**과 `code`.", "", "- 하나", "- [링크](https://example.com/a?b=1&c=2)", "", "1. 첫째", "2. 둘째", "",
    "| 항목 | 값 |", "|---|---|", "| A | 1 |", "", "> 인용", "", "```js", "const a = '<b>';", "```", "", "---",
  ].join("\n"));
  assert.match(html, /<h1>보고서<\/h1>/);
  assert.match(html, /<strong>결론<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>하나<\/li><li><a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">링크<\/a><\/li><\/ul>/);
  assert.match(html, /<ol><li>첫째<\/li><li>둘째<\/li><\/ol>/);
  assert.match(html, /<th>항목<\/th>[\s\S]*<td>1<\/td>/);
  assert.match(html, /<blockquote><p>인용<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>const a = &#39;&lt;b&gt;&#39;;<\/code><\/pre>/);
  assert.match(html, /<hr>/);
});

test("renderMarkdown escapes raw HTML and unsafe links", () => {
  const html = renderMarkdown("<script>alert(1)</script>\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>");
  assert.doesNotMatch(html, /<script|<img|href="javascript/i);
  assert.match(html, /&lt;script&gt;/);
});

test("renderMarkdown links bare URLs once", () => {
  const html = renderMarkdown("출처: https://example.com/x");
  assert.equal((html.match(/<a /g) || []).length, 1);
});
