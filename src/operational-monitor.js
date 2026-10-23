import { buildHealthReport } from "./health.js";

const GB = 1024 ** 3;

export async function runOperationalMonitor({ config, schedules, personalOps, telegram, now = new Date() }) {
  if (!config.operationalMonitoringEnabled || !config.defaultTelegramTargetChatId) return [];
  const chatId = config.defaultTelegramTargetChatId;
  const health = await buildHealthReport(config);
  const alerts = [];
  if (health.storage.configured && !health.storage.ok) alerts.push(["storage-missing", "외장 SSD를 찾을 수 없습니다. 백업 경로와 연결 상태를 확인하세요."]);
  if (health.storage.ok && health.storage.availableBytes < 10 * GB) alerts.push(["storage-low", `외장 SSD 여유 공간이 ${Math.round(health.storage.availableBytes / GB)}GB 미만입니다.`]);
  if (health.photoBackup?.configured && !health.photoBackup.ok) alerts.push(["photo-backup-missing", "사진 원본 백업 경로에 접근할 수 없습니다."]);
  if (health.photoBackup?.ok && health.photoBackup.latestModifiedAt && now.getTime() - Date.parse(health.photoBackup.latestModifiedAt) > 72 * 60 * 60 * 1000) alerts.push(["photo-backup-stale", "사진 원본 백업에 72시간 이상 새 파일이 없습니다."]);
  const failing = (schedules?.list?.(chatId) || []).filter((row) => row.failureCount > 0 || row.disabled);
  if (failing.length) alerts.push(["schedule-failure", `실패 중인 스케줄이 ${failing.length}개 있습니다: ${failing.slice(0, 3).map((row) => row.id).join(", ")}`]);
  alerts.push(...missingBriefingAlerts({ config, personalOps, chatId, now }));
  const sent = [];
  for (const [key, message] of alerts) {
    const dailyKey = key.startsWith("missing-") ? `${key}:${seoulDate(now)}` : key;
    if (!await personalOps.reserveAlert(dailyKey, { now })) continue;
    await telegram.sendMessage(chatId, `⚠️ AI Workmate 점검\n${message}\n정상 상태는 별도로 알리지 않습니다.`);
    sent.push(key);
  }
  return sent;
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
