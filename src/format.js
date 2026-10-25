import { formatKst } from "./schedule-names.js";

const TELEGRAM_MESSAGE_LIMIT = 3500;
const STATUS_LABELS = { queued: "대기 중", running: "실행 중", completed: "완료", failed: "실패", cancelled: "취소됨" };

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? "알 수 없음");
}

export function formatJobStatus(job, now = new Date()) {
  if (!job) {
    return "이 채팅에서 진행 중인 작업이 없습니다.";
  }
  return [
    `작업: ${job.jobId} · ${statusLabel(job.status)}`,
    `엔진: ${providerLabel(job)}${job.resumeFromSessionId ? " · 이전 대화 이어서" : ""}`,
    `시작: ${formatKst(job.startedAt)} (${formatElapsed(job.startedAt, job.finishedAt || now) || "방금"} 경과)`,
    `작업공간: ${job.workspaceAlias}`,
    job.exitCode == null ? null : `종료 코드: ${job.exitCode}`,
    `자세히: /job ${job.jobId} · 중단: /cancel`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCompletionMessage(job) {
  const summary = job.summary?.trim() || "(최종 응답을 받지 못했습니다)";
  if (job.status === "completed" && isPersonalBriefing(job)) {
    return summary;
  }
  return `${summary}\n\n${buildResultFooter(job)}`;
}

// One line instead of the old Job/Session/Mode/Workspace header. Replies to the result still continue
// the session: the mapping is stored by message id in job-settle, not parsed from this text.
export function buildResultFooter(job) {
  const parts = [];
  if (job.status === "completed") parts.push(`✅ ${providerLabel(job)}`);
  else if (job.status === "cancelled") parts.push("⏹ 취소됨", providerLabel(job));
  else parts.push("⚠️ 실패", providerLabel(job), failureCause(job));
  const elapsed = formatElapsed(job.startedAt, job.finishedAt);
  if (elapsed && job.status !== "failed") parts.push(elapsed);
  if (job.resumeFromSessionId) parts.push("이어서");
  if (job.workspaceAlias && job.workspaceAlias !== "default") parts.push(job.workspaceAlias);
  if (job.fallbackReason && job.provider === "codex") parts.push(`Codex 대체(${job.fallbackReason})`);
  if (job.jobId) parts.push(`/job ${job.jobId}`);
  return parts.filter(Boolean).join(" · ");
}

function failureCause(job) {
  const line = String(job.summary || job.lastOutputSnippet || "").split("\n").map((row) => row.trim()).find(Boolean) || "원인 미상";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function isPersonalBriefing(job) {
  return job.operationMode === "brief"
    || /^\[AI_WORKMATE_(?:MORNING_BRIEF|EVENING_BRIEF|WEEKLY_REVIEW|AI_TREND_BRIEF|DAILY_DISCOVERY)_V1\]/.test(String(job.prompt || ""));
}

export function buildBusyMessage(job) {
  const id = job?.jobId ? ` (/job ${job.jobId} · ${statusLabel(job.status)})` : "";
  return `이미 작업이 진행 중입니다${id}.\n끝난 뒤 다시 보내거나 /cancel 로 중단하세요.`;
}

export function buildAcceptedMessage(job) {
  return [
    `접수했습니다 · ${providerLabel(job)}${job.resumeFromSessionId ? " · 이전 대화 이어서" : ""}${job.workspaceAlias && job.workspaceAlias !== "default" ? ` · ${job.workspaceAlias}` : ""} · /job ${job.jobId}`,
    job.fallbackReason && job.provider === "codex" ? `Codex로 대체: ${job.fallbackReason}` : null,
  ].filter(Boolean).join("\n");
}

export function providerLabel(job) {
  return job?.provider === "claude" ? "Claude" : "Codex";
}

export function formatElapsed(start, end) {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
}

export function splitTelegramMessage(text, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  if (!text) {
    return [""];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const splitAt = findSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  if (chunks.length <= 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}]\n${chunk}`);
}

function findSplitPoint(text, maxLength) {
  const window = text.slice(0, maxLength + 1);
  const candidates = ["\n\n", "\n", ". ", " "];

  for (const candidate of candidates) {
    const index = window.lastIndexOf(candidate);
    if (index > maxLength * 0.6) {
      return index + candidate.length;
    }
  }

  return maxLength;
}
