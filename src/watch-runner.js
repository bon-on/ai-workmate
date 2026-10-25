import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

export async function validatePublicUrl(value, { lookup = dns.lookup } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("올바른 URL을 입력하세요."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("http 또는 https URL만 감시할 수 있습니다.");
  if (url.username || url.password) throw new Error("인증 정보가 포함된 URL은 감시할 수 없습니다.");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("로컬 주소는 감시할 수 없습니다.");
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("사설망 또는 예약 주소는 감시할 수 없습니다.");
  }
  return url;
}

export async function runDueWatches({ store, telegram, now = new Date(), fetchImpl = fetch, lookup = dns.lookup }) {
  const results = [];
  for (const watch of store.dueWatches(now)) {
    try {
      const url = await validatePublicUrl(watch.url, { lookup });
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "user-agent": "AI-Workmate-Watch/1.0", accept: "text/html,text/plain,application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!/(text|json|xml|html)/i.test(contentType)) throw new Error(`지원하지 않는 콘텐츠 형식: ${contentType || "unknown"}`);
      const body = (await response.text()).slice(0, 2_000_000);
      const normalized = normalizeContent(body);
      const hash = createHash("sha256").update(normalized).digest("hex");
      const changed = Boolean(watch.lastHash && watch.lastHash !== hash);
      const snapshot = contentSnapshot(body);
      const excerpt = changed ? changeExcerpt(watch.lastSnapshot, snapshot) : null;
      await store.updateWatch(watch.id, {
        lastHash: hash,
        lastSnapshot: snapshot,
        lastChangedAt: changed ? now.toISOString() : watch.lastChangedAt,
        ...(changed ? { lastExcerpt: excerpt } : {}),
        lastError: null,
        failureCount: 0,
      }, now);
      if (changed) await telegram.sendMessage(watch.chatId, [`🔔 웹 변경 감지 · ${watch.label}`, watch.url, excerpt ? `\n${excerpt}` : null].filter(Boolean).join("\n"));
      results.push({ id: watch.id, ok: true, changed });
    } catch (error) {
      await store.updateWatch(watch.id, {
        lastError: String(error.message).slice(0, 300),
        failureCount: (watch.failureCount ?? 0) + 1,
      }, now);
      if ((watch.failureCount ?? 0) + 1 === 3) {
        await telegram.sendMessage(watch.chatId, `웹 감시 ${watch.id}가 3회 연속 실패했습니다.\n${watch.label}\n${error.message}`);
      }
      results.push({ id: watch.id, ok: false, error: error.message });
    }
  }
  return results;
}

const SNAPSHOT_LIMIT = 20_000;
const EXCERPT_LINES = 4;
const EXCERPT_LINE_LIMIT = 140;

// Visible text kept one block per line (bounded), so the next change can be shown as added/removed lines.
export function contentSnapshot(value) {
  const lines = String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[\d:.+-]+Z?\b/g, "<timestamp>")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim().slice(0, 2_000))
    .filter(Boolean);
  let size = 0;
  const kept = [];
  for (const line of lines) {
    size += line.length + 1;
    if (size > SNAPSHOT_LIMIT) break;
    kept.push(line);
  }
  return kept.join("\n");
}

// A few added (+) and removed (-) lines; null when there is no earlier snapshot to compare.
export function changeExcerpt(previous, current) {
  if (typeof previous !== "string" || !previous) return null;
  const before = new Set(previous.split("\n"));
  const after = new Set(current.split("\n"));
  const clip = (line) => (line.length > EXCERPT_LINE_LIMIT ? `${line.slice(0, EXCERPT_LINE_LIMIT - 1)}…` : line);
  const added = [...after].filter((line) => !before.has(line));
  const removed = [...before].filter((line) => !after.has(line));
  const addedRows = added.slice(0, removed.length ? EXCERPT_LINES - 1 : EXCERPT_LINES);
  const rows = [
    ...addedRows.map((line) => `+ ${clip(line)}`),
    ...removed.slice(0, EXCERPT_LINES - addedRows.length).map((line) => `- ${clip(line)}`),
  ];
  if (!rows.length) return "변경 내용: 줄 단위로 표시할 차이가 없습니다.";
  const more = added.length + removed.length - rows.length;
  return `변경 내용:\n${rows.join("\n")}${more > 0 ? `\n… 외 ${more}줄` : ""}`;
}

function normalizeContent(value) {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[\d:.+-]+Z?\b/g, "<timestamp>")
    .replace(/\s+/g, " ")
    .trim();
}

function isPrivateAddress(address) {
  if (address === "::1" || address === "::" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const candidate = mapped ?? address;
  if (!net.isIPv4(candidate)) return false;
  const [a, b] = candidate.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
