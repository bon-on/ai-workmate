const TELEGRAM_MESSAGE_LIMIT = 3500;

export function formatJobStatus(job) {
  if (!job) {
    return "No active job in this chat.";
  }

  const started = new Date(job.startedAt).toISOString();
  return [
    `Job: ${job.jobId}`,
    `Session: ${job.sessionId || "(pending)"}`,
    `Mode: ${job.resumeFromSessionId ? "resumed" : "new"}`,
    `Status: ${job.status}`,
    `Workspace: ${job.workspaceAlias}`,
    `Started: ${started}`,
    job.exitCode == null ? null : `Exit code: ${job.exitCode}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCompletionMessage(job) {
  const summary = job.summary?.trim() || "(No final response captured)";
  if (job.status === "completed" && isPersonalBriefing(job)) {
    return summary;
  }
  const header = getJobHeader(job);
  return `${header}\nJob: ${job.jobId}\nSession: ${job.sessionId || "(unavailable)"}\nMode: ${job.resumeFromSessionId ? "resumed" : "new"}\nWorkspace: ${job.workspaceAlias}${formatFallback(job)}\n\n${summary}`;
}

function isPersonalBriefing(job) {
  return job.operationMode === "brief"
    || /^\[AI_WORKMATE_(?:MORNING_BRIEF|EVENING_BRIEF|WEEKLY_REVIEW|AI_TREND_BRIEF|DAILY_DISCOVERY)_V1\]/.test(String(job.prompt || ""));
}

export function buildBusyMessage(job) {
  return `A job is already running in this chat.\nJob: ${job.jobId}\nSession: ${job.sessionId || "(pending)"}\nStatus: ${job.status}`;
}

export function buildAcceptedMessage(job) {
  return `Accepted.\nJob: ${job.jobId}\nSession: ${job.sessionId || "(pending)"}\nMode: ${job.resumeFromSessionId ? "resumed" : "new"}\nWorkspace: ${job.workspaceAlias}${job.provider ? `\nEngine: ${providerLabel(job)}` : ""}${formatFallback(job)}\nStatus: queued`;
}

function providerLabel(job) {
  return job.provider === "claude" ? "Claude" : "Codex";
}

function formatFallback(job) {
  return job.fallbackReason && job.provider === "codex" ? `\nFallback: Codex (${job.fallbackReason})` : "";
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

function getJobHeader(job) {
  const label = providerLabel(job);
  if (job.status === "completed") {
    return `${label} job completed.`;
  }

  if (job.status === "cancelled") {
    return `${label} job cancelled.`;
  }

  return `${label} job failed.`;
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
