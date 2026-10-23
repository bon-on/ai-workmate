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
      await store.updateWatch(watch.id, {
        lastHash: hash,
        lastChangedAt: changed ? now.toISOString() : watch.lastChangedAt,
        lastError: null,
        failureCount: 0,
      }, now);
      if (changed) await telegram.sendMessage(watch.chatId, `웹 변경 감지\n${watch.label}\n${watch.url}`);
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
