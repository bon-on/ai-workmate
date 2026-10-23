// Small Markdown-to-HTML renderer for the dashboard document viewer.
// Runs unchanged in Node (tests) and the browser (served as /assets/markdown-render.js).
// Every piece of source text is HTML-escaped before markup is added, so documents
// written by AI jobs cannot inject markup or scripts.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function safeHref(raw) {
  const href = raw.trim();
  return /^(https?:\/\/|mailto:|#)/i.test(href) ? href : null;
}

function renderInline(text) {
  const codes = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      const safe = safeHref(href.replace(/&amp;/g, "&"));
      return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (match, lead, url) =>
      `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index += 1;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); index += 1; continue; }

    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[index + 1])) {
      const head = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(tableCells(lines[index++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+•]|\d+[.)])\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+•]|\d+[.)])\s+(.*)$/);
        if (item) {
          const task = item[3].match(/^\[( |x|X)\]\s+(.*)$/);
          const text = task ? `${task[1] === " " ? "☐" : "☑"} ${task[2]}` : item[3];
          items.push({ depth: item[1].length >= 2 ? 1 : 0, html: renderInline(text) });
          index += 1;
        } else if (lines[index].trim() && /^\s{2,}\S/.test(lines[index]) && items.length) {
          items[items.length - 1].html += ` ${renderInline(lines[index].trim())}`;
          index += 1;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li${item.depth ? ' class="md-nested"' : ""}>${item.html}</li>`).join("")}</${tag}>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+•]|\d+[.)])\s+)/.test(lines[index])) {
      paragraph.push(renderInline(lines[index].trim()));
      index += 1;
    }
    if (!paragraph.length) { paragraph.push(renderInline(line.trim())); index += 1; }
    out.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return out.join("\n");
}
