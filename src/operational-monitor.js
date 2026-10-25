import { buildHealthReport } from "./health.js";
import { scheduleName } from "./schedule-names.js";

const GB = 1024 ** 3;
let lastN8nErrorLogAt = 0;

// `n8n` (an N8nManager) is optional; without it the n8n failure summary is skipped.
export async function runOperationalMonitor({ config, schedules, personalOps, telegram, n8n = null, buildHealth = buildHealthReport, now = new Date() }) {
  if (!config.operationalMonitoringEnabled || !config.defaultTelegramTargetChatId) return [];
  const chatId = config.defaultTelegramTargetChatId;
  const health = await buildHealth(config);
  const alerts = [];
  if (health.storage.configured && !health.storage.ok) alerts.push(["storage-missing", "외장 SSD를 찾을 수 없습니다. 백업 경로와 연결 상태를 확인하세요."]);
  if (health.storage.ok && health.storage.availableBytes < 10 * GB) alerts.push(["storage-low", `외장 SSD 여유 공간이 ${Math.round(health.storage.availableBytes / GB)}GB 미만입니다.`]);
  if (health.photoBackup?.configured && !health.photoBackup.ok) alerts.push(["photo-backup-missing", "사진 원본 백업 경로에 접근할 수 없습니다."]);
  if (health.photoBackup?.ok && health.photoBackup.latestModifiedAt && now.getTime() - Date.parse(health.photoBackup.latestModifiedAt) > 72 * 60 * 60 * 1000) alerts.push(["photo-backup-stale", "사진 원본 백업에 72시간 이상 새 파일이 없습니다."]);
  const failure = await scheduleFailureAlert(schedules?.list?.(chatId) || [], { personalOps, now });
  if (failure) alerts.push(failure);
  alerts.push(...missingBriefingAlerts({ config, personalOps, chatId, now }));
  const n8nAlert = await n8nFailureAlert(n8n, now);
  if (n8nAlert) alerts.push(n8nAlert);
  const sent = [];
  for (const [key, message, options = {}] of alerts) {
    if (options.preReserved) {
      await telegram.sendMessage(chatId, `⚠️ AI Workmate 점검\n${message}\n정상 상태는 별도로 알리지 않습니다.`);
      sent.push(key);
      continue;
    }
    const dailyKey = key.startsWith("missing-") ? `${key}:${seoulDate(now)}` : options.reserveKey || key;
    if (!await personalOps.reserveAlert(dailyKey, { now, ...(options.cooldownMs ? { cooldownMs: options.cooldownMs } : {}) })) continue;
    await telegram.sendMessage(chatId, `⚠️ AI Workmate 점검\n${message}\n정상 상태는 별도로 알리지 않습니다.`);
    sent.push(key);
  }
  return sent;
}

// One alert per failure episode of each schedule (O2): each failing schedule reserves
// `schedule-failure:<id>:<failingSince>` and only newly reserved ones are announced.
export async function scheduleFailureAlert(rows, { personalOps, now = new Date() } = {}) {
  const failing = rows.filter((row) => row.failureCount > 0)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const fresh = [];
  for (const row of failing) {
    const key = `schedule-failure:${row.id}:${row.failingSince || "unknown"}`;
    if (await personalOps.reserveAlert(key, { now, cooldownMs: Number.POSITIVE_INFINITY })) fresh.push(row);
  }
  if (!fresh.length) return null;
  const lines = fresh.slice(0, 3).map((row) => {
    const reason = String(row.lastError || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120);
    return `• ${scheduleName(row.prompt)} (${row.id}) 실패${reason ? `\n  사유: ${reason}` : ""}`;
  });
  if (fresh.length > 3) lines.push(`• 외 ${fresh.length - 3}개`);
  const message = [`예약 작업 ${fresh.length}개가 실패했습니다. 같은 실패는 다시 알리지 않습니다.`, ...lines, `다시 실행: /runnow ${fresh[0].id}`].join("\n");
  // Already reserved per schedule above, so the send loop must not dedupe it again.
  // Accepted: a failed send loses this episode's alert; the dashboard still lists the failure.
  return ["schedule-failure", message, { preReserved: true }];
}

// At most one summary per 24 hours, covering the 24 hours before it, so windows never overlap.
async function n8nFailureAlert(n8n, now) {
  if (!n8n?.recentFailures) return null;
  let failures;
  try { failures = await n8n.recentFailures({ since: new Date(now.getTime() - 24 * 60 * 60 * 1000) }); }
  catch (error) {
    // Logged at most every 6 hours so an absent or keyless n8n does not flood the log every tick.
    if (now.getTime() - lastN8nErrorLogAt > 6 * 60 * 60 * 1000) {
      lastN8nErrorLogAt = now.getTime();
      console.error("n8n failure check failed:", error.message);
    }
    return null;
  }
  if (!failures?.length) return null;
  const total = failures.reduce((sum, row) => sum + row.count, 0);
  const lines = failures.slice(0, 5).map((row) => `• ${row.name}: ${row.count}회`);
  const message = [`최근 24시간 n8n 실행 실패 ${total}건`, ...lines, "대시보드 n8n 탭에서 실패 상세를 확인하고 재시도하세요."].join("\n");
  return ["n8n-failures", message, { cooldownMs: 24 * 60 * 60 * 1000 }];
}

function missingBriefingAlerts({ config, personalOps, chatId, now }) {
  if (!config.personalBriefingsEnabled) return [];
  const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(now));
  const today = seoulDate(now);
  const history = personalOps.listBriefingHistory(chatId, { days: 2, limit: 20, now });
  const has = (kind) => history.some((row) => row.kind === kind && seoulDate(new Date(row.sentAt)) === today);
  const alerts = [];
  if (localHour >= 12 && !has("morning")) alerts.push(["missing-morning", "오늘 모닝 브리핑 발송 기록이 없습니다."]);
  if (localHour >= 23 && !has("evening")) alerts.push(["missing-evening", "오늘 이브닝 브리핑 발송 기록이 없습니다."]);
  return alerts;
}

function seoulDate(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
