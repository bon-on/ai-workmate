import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loadConfig validates required fields", () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN is required/);
});

test("loadConfig parses id lists and defaults", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    CODEX_WORKSPACE: "/tmp/workspace",
    ALLOWED_CHAT_IDS: "1,2",
    ALLOWED_USER_IDS: "3",
  });

  assert.deepEqual(config.allowedChatIds, ["1", "2"]);
  assert.deepEqual(config.allowedUserIds, ["3"]);
  assert.equal(config.jobTimeoutMs, 1800000);
  assert.equal(config.denyMode, "reply");
  assert.equal(config.telegramRequestTimeoutMs, 45000);
  assert.equal(config.pollRetryMinMs, 2000);
  assert.equal(config.pollRetryMaxMs, 60000);
  assert.equal(config.pollRestartFailureThreshold, 6);
  assert.equal(config.pollRestartWindowMs, 300000);
  assert.equal(config.maxDelegateJobsPerChat, 2);
  assert.equal(config.maxDelegateJobsTotal, 4);
  assert.equal(config.scheduleMaxFailures, 3);
  assert.equal(config.dashboardEnabled, true);
  assert.equal(config.dashboardPort, 8766);
  assert.equal(config.dashboardHost, "127.0.0.1");
  assert.equal(config.telegramUnrestrictedEnabled, true);
  assert.equal(config.tradingDashboardPort, 8000);
  assert.equal(config.n8nPort, 5678);
  assert.equal(config.ollamaPort, 11434);
  assert.equal(config.personalBriefingsEnabled, true);
  assert.equal(config.morningBriefHour, 8);
  assert.equal(config.eveningBriefHour, 20);
  assert.equal(config.eveningBriefMinute, 0);
  assert.equal(config.aiTrendBriefHour, 12);
  assert.equal(config.personalLocation, "서울");
  assert.equal(config.weatherLatitude, 37.5665);
  assert.equal(config.weatherLongitude, 126.978);
  assert.match(config.sessionStatePath, /telegram-codex-bridge-sessions\.json$/);
  assert.match(config.memoryStatePath, /telegram-codex-bridge-memories\.json$/);
  assert.match(config.scheduleStatePath, /telegram-codex-bridge-schedules\.json$/);
  assert.match(config.personalOpsStatePath, /ai-workmate-personal-ops\.json$/);
  assert.equal(config.externalStoragePath, null);
  assert.equal(config.photoBackupPath, null);
  assert.equal(config.operationalMonitoringEnabled, true);
});

test("loadConfig defaults to Claude with Codex fallback settings", () => {
  const base = { TELEGRAM_BOT_TOKEN: "token", CODEX_WORKSPACE: "/tmp/workspace", ALLOWED_CHAT_IDS: "1" };
  const config = loadConfig(base);
  assert.equal(config.aiProvider, "claude");
  assert.equal(config.claudeExecutable, "claude");
  assert.equal(config.scheduledClaudeModel, "sonnet");
  assert.equal(config.scheduledClaudeEffort, "low");
  assert.equal(config.claudeFallbackUtilization, 0.95);
  assert.equal(config.claudeMcpConfig, null);
  assert.equal(loadConfig({ ...base, AI_PROVIDER: "Codex" }).aiProvider, "codex");
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: "gemini" }), /AI_PROVIDER/);
  assert.throws(() => loadConfig({ ...base, CLAUDE_FALLBACK_UTILIZATION: "95" }), /CLAUDE_FALLBACK_UTILIZATION/);
});

test("REPO_CHECK_HOUR accepts 0..23 and rejects other values", async () => {
  const { loadConfig } = await import("../src/config.js");
  const base = { TELEGRAM_BOT_TOKEN: "x", ALLOWED_CHAT_IDS: "1", CODEX_WORKSPACE: "/tmp" };
  assert.equal(loadConfig({ ...base, REPO_CHECK_HOUR: "0" }).repoCheckHour, 0);
  assert.equal(loadConfig(base).repoCheckHour, 7);
  assert.throws(() => loadConfig({ ...base, REPO_CHECK_HOUR: "24" }), /0 to 23/);
});

test("launchd label defaults to a neutral name and an empty value falls back to it", () => {
  const base = { TELEGRAM_BOT_TOKEN: "token", CODEX_WORKSPACE: "/tmp/workspace", ALLOWED_CHAT_IDS: "1" };
  assert.equal(loadConfig(base).launchdLabel, "com.ai-workmate.bridge");
  assert.equal(loadConfig({ ...base, AI_WORKMATE_LAUNCHD_LABEL: "" }).launchdLabel, "com.ai-workmate.bridge");
  assert.equal(loadConfig({ ...base, AI_WORKMATE_LAUNCHD_LABEL: "com.example.bridge" }).launchdLabel, "com.example.bridge");
});
