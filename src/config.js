import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspaceMap } from "./workspaces.js";

const DEFAULTS = {
  jobTimeoutMs: 30 * 60 * 1000,
  maxLogBytes: 200_000,
  pollTimeoutSeconds: 30,
  telegramRequestTimeoutMs: 45_000,
  pollRetryMinMs: 2_000,
  pollRetryMaxMs: 60_000,
  pollRestartFailureThreshold: 6,
  pollRestartWindowMs: 5 * 60 * 1000,
  maxDelegateJobsPerChat: 2,
  maxDelegateJobsTotal: 4,
  scheduleMaxFailures: 3,
  maxIncomingFileBytes: 20 * 1024 * 1024,
  dashboardPort: 8766,
  dashboardHost: "127.0.0.1",
  tradingDashboardPort: 8000,
  n8nPort: 5678,
  ollamaPort: 11434,
  repoCheckHour: 7,
  launchdLabel: "com.ai-workmate.bridge",
  morningBriefHour: 8,
  morningBriefMinute: 0,
  eveningBriefHour: 20,
  eveningBriefMinute: 0,
  weeklyReviewHour: 20,
  weeklyReviewMinute: 30,
  aiTrendBriefHour: 12,
  aiTrendBriefMinute: 0,
  englishStudyHour: 12,
  englishStudyMinute: 10,
  denyMode: "reply",
};

export function loadEnvFile(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseIdList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseHour(value, fallback, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) throw new Error(`${name} must be an hour from 0 to 23`);
  return parsed;
}

function parseInteger(value, fallback, name) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseClock(value, fallbackHour, fallbackMinute, name) {
  if (!value) return { hour: fallbackHour, minute: fallbackMinute };
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${name} must use HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${name} must be a valid time`);
  return { hour, minute };
}

function parseProvider(value) {
  const provider = (value || "claude").trim().toLowerCase();
  if (!["claude", "codex"].includes(provider)) throw new Error("AI_PROVIDER must be either 'claude' or 'codex'");
  return provider;
}

function parseUtilization(value) {
  if (value == null || value === "") return 0.95;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) throw new Error("CLAUDE_FALLBACK_UTILIZATION must be between 0 and 1");
  return parsed;
}

export function loadConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const allowedChatIds = parseIdList(env.ALLOWED_CHAT_IDS);
  const allowedUserIds = parseIdList(env.ALLOWED_USER_IDS);

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  const workspaces = parseWorkspaceMap(env);
  if (allowedChatIds.length === 0 && allowedUserIds.length === 0) {
    throw new Error("At least one of ALLOWED_CHAT_IDS or ALLOWED_USER_IDS is required");
  }

  const denyMode = env.DENY_MODE ?? DEFAULTS.denyMode;
  if (!["reply", "silent"].includes(denyMode)) {
    throw new Error("DENY_MODE must be either 'reply' or 'silent'");
  }
  const dashboardEnabled = env.DASHBOARD_ENABLED !== "false";
  const morningBrief = parseClock(env.MORNING_BRIEF_TIME, DEFAULTS.morningBriefHour, DEFAULTS.morningBriefMinute, "MORNING_BRIEF_TIME");
  const eveningBrief = parseClock(env.EVENING_BRIEF_TIME, DEFAULTS.eveningBriefHour, DEFAULTS.eveningBriefMinute, "EVENING_BRIEF_TIME");
  const weeklyReview = parseClock(env.WEEKLY_REVIEW_TIME, DEFAULTS.weeklyReviewHour, DEFAULTS.weeklyReviewMinute, "WEEKLY_REVIEW_TIME");
  const aiTrendBrief = parseClock(env.AI_TREND_BRIEF_TIME, DEFAULTS.aiTrendBriefHour, DEFAULTS.aiTrendBriefMinute, "AI_TREND_BRIEF_TIME");
  const englishStudy = parseClock(env.ENGLISH_STUDY_TIME, DEFAULTS.englishStudyHour, DEFAULTS.englishStudyMinute, "ENGLISH_STUDY_TIME");

  return {
    telegramBotToken: token,
    codexWorkspace: workspaces.byAlias[workspaces.defaultAlias],
    workspaces,
    aiProvider: parseProvider(env.AI_PROVIDER),
    claudeModel: env.CLAUDE_MODEL || null,
    claudeExecutable: env.CLAUDE_BIN || "claude",
    scheduledClaudeModel: env.SCHEDULED_CLAUDE_MODEL || "sonnet",
    scheduledClaudeEffort: env.SCHEDULED_CLAUDE_EFFORT || "low",
    claudeFallbackUtilization: parseUtilization(env.CLAUDE_FALLBACK_UTILIZATION),
    claudeMcpConfig: env.CLAUDE_MCP_CONFIG ? path.resolve(env.CLAUDE_MCP_CONFIG) : null,
    claudeLimitStatePath: path.resolve(
      env.CLAUDE_LIMIT_STATE_PATH || path.join(os.homedir(), ".codex", "ai-workmate-claude-limits.json"),
    ),
    claudeRateLimitSnapshotPath: path.resolve(
      env.CLAUDE_RATE_LIMIT_SNAPSHOT || path.join(os.homedir(), ".claude", "rate-limits.json"),
    ),
    codexModel: env.CODEX_MODEL || null,
    codexProfile: env.CODEX_PROFILE || null,
    codexExecutable: env.CODEX_BIN || "codex",
    scheduledCodexModel: env.SCHEDULED_CODEX_MODEL || "gpt-5.6-luna",
    scheduledCodexReasoningEffort: env.SCHEDULED_CODEX_REASONING_EFFORT || "none",
    localBriefingModel: env.LOCAL_BRIEFING_MODEL || "qwen3.5:latest",
    telegramUnrestrictedEnabled: env.TELEGRAM_UNRESTRICTED_ENABLED !== "false",
    sessionStatePath: path.resolve(
      env.SESSION_STATE_PATH || path.join(os.homedir(), ".codex", "telegram-codex-bridge-sessions.json"),
    ),
    memoryStatePath: path.resolve(
      env.MEMORY_STATE_PATH || path.join(os.homedir(), ".codex", "telegram-codex-bridge-memories.json"),
    ),
    scheduleStatePath: path.resolve(
      env.SCHEDULE_STATE_PATH || path.join(os.homedir(), ".codex", "telegram-codex-bridge-schedules.json"),
    ),
    personalOpsStatePath: path.resolve(
      env.PERSONAL_OPS_STATE_PATH || path.join(os.homedir(), ".codex", "ai-workmate-personal-ops.json"),
    ),
    externalStoragePath: env.EXTERNAL_STORAGE_PATH ? path.resolve(env.EXTERNAL_STORAGE_PATH) : null,
    photoBackupPath: env.PHOTO_BACKUP_PATH ? path.resolve(env.PHOTO_BACKUP_PATH) : null,
    operationalMonitoringEnabled: env.OPERATIONAL_MONITORING_ENABLED !== "false",
    transcriptionModelPath: path.resolve(env.TRANSCRIPTION_MODEL_PATH || path.join(process.cwd(), "models", "ggml-base.bin")),
    defaultTelegramTargetChatId: env.DEFAULT_TELEGRAM_TARGET_CHAT_ID || allowedChatIds[0] || null,
    personalBriefingsEnabled: env.PERSONAL_BRIEFINGS_ENABLED !== "false",
    englishStudyEnabled: env.ENGLISH_STUDY_ENABLED !== "false",
    englishStudyHour: englishStudy.hour,
    englishStudyMinute: englishStudy.minute,
    morningBriefHour: morningBrief.hour,
    morningBriefMinute: morningBrief.minute,
    eveningBriefHour: eveningBrief.hour,
    eveningBriefMinute: eveningBrief.minute,
    weeklyReviewHour: weeklyReview.hour,
    weeklyReviewMinute: weeklyReview.minute,
    aiTrendBriefHour: aiTrendBrief.hour,
    aiTrendBriefMinute: aiTrendBrief.minute,
    personalLocation: env.PERSONAL_LOCATION || "서울",
    weatherLatitude: Number.parseFloat(env.WEATHER_LATITUDE || "37.5665"),
    weatherLongitude: Number.parseFloat(env.WEATHER_LONGITUDE || "126.9780"),
    allowedChatIds,
    allowedUserIds,
    jobTimeoutMs: parseInteger(env.JOB_TIMEOUT_MS, DEFAULTS.jobTimeoutMs, "JOB_TIMEOUT_MS"),
    maxLogBytes: parseInteger(env.MAX_LOG_BYTES, DEFAULTS.maxLogBytes, "MAX_LOG_BYTES"),
    pollTimeoutSeconds: parseInteger(
      env.POLL_TIMEOUT_SECONDS,
      DEFAULTS.pollTimeoutSeconds,
      "POLL_TIMEOUT_SECONDS",
    ),
    telegramRequestTimeoutMs: parseInteger(
      env.TELEGRAM_REQUEST_TIMEOUT_MS,
      DEFAULTS.telegramRequestTimeoutMs,
      "TELEGRAM_REQUEST_TIMEOUT_MS",
    ),
    pollRetryMinMs: parseInteger(env.POLL_RETRY_MIN_MS, DEFAULTS.pollRetryMinMs, "POLL_RETRY_MIN_MS"),
    pollRetryMaxMs: parseInteger(env.POLL_RETRY_MAX_MS, DEFAULTS.pollRetryMaxMs, "POLL_RETRY_MAX_MS"),
    pollRestartFailureThreshold: parseInteger(
      env.POLL_RESTART_FAILURE_THRESHOLD,
      DEFAULTS.pollRestartFailureThreshold,
      "POLL_RESTART_FAILURE_THRESHOLD",
    ),
    pollRestartWindowMs: parseInteger(
      env.POLL_RESTART_WINDOW_MS,
      DEFAULTS.pollRestartWindowMs,
      "POLL_RESTART_WINDOW_MS",
    ),
    maxDelegateJobsPerChat: parseInteger(
      env.MAX_DELEGATE_JOBS_PER_CHAT,
      DEFAULTS.maxDelegateJobsPerChat,
      "MAX_DELEGATE_JOBS_PER_CHAT",
    ),
    maxDelegateJobsTotal: parseInteger(
      env.MAX_DELEGATE_JOBS_TOTAL,
      DEFAULTS.maxDelegateJobsTotal,
      "MAX_DELEGATE_JOBS_TOTAL",
    ),
    scheduleMaxFailures: parseInteger(
      env.SCHEDULE_MAX_FAILURES,
      DEFAULTS.scheduleMaxFailures,
      "SCHEDULE_MAX_FAILURES",
    ),
    maxIncomingFileBytes: parseInteger(
      env.MAX_INCOMING_FILE_BYTES,
      DEFAULTS.maxIncomingFileBytes,
      "MAX_INCOMING_FILE_BYTES",
    ),
    dashboardEnabled,
    dashboardHost: env.DASHBOARD_HOST || DEFAULTS.dashboardHost,
    dashboardAllowedHosts: (env.DASHBOARD_ALLOWED_HOSTS || "").split(",").map((row) => row.trim().toLowerCase()).filter(Boolean),
    dashboardPort: parseInteger(env.DASHBOARD_PORT, DEFAULTS.dashboardPort, "DASHBOARD_PORT"),
    tradingDashboardPort: parseInteger(env.TRADING_DASHBOARD_PORT, DEFAULTS.tradingDashboardPort, "TRADING_DASHBOARD_PORT"),
    n8nPort: parseInteger(env.N8N_PORT, DEFAULTS.n8nPort, "N8N_PORT"),
    ollamaPort: parseInteger(env.OLLAMA_PORT, DEFAULTS.ollamaPort, "OLLAMA_PORT"),
    repoChecksEnabled: env.REPO_CHECKS_ENABLED !== "false",
    repoCheckHour: parseHour(env.REPO_CHECK_HOUR, DEFAULTS.repoCheckHour, "REPO_CHECK_HOUR"),
    // Sibling repositories of this checkout, e.g. ~/sources.
    repoCheckRoot: path.resolve(env.REPO_CHECK_ROOT || fileURLToPath(new URL("../..", import.meta.url))),
    harnessLabCli: env.HARNESS_LAB_CLI ? path.resolve(env.HARNESS_LAB_CLI) : null,
    publishCheckPrivateTerms: (env.PUBLISH_CHECK_PRIVATE_TERMS || "").split(",").map((term) => term.trim()).filter(Boolean),
    launchdLabel: env.AI_WORKMATE_LAUNCHD_LABEL || DEFAULTS.launchdLabel,
    restartNoticePath: path.resolve(
      env.RESTART_NOTICE_PATH || path.join(os.homedir(), ".codex", "ai-workmate-restart-notice.json"),
    ),
    denyMode,
  };
}
