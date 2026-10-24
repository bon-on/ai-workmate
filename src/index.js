import net from "node:net";
import { loadConfig, loadEnvFile } from "./config.js";
import { cleanupStaleJobDirs, JobManager } from "./job-manager.js";
import { createCodexLimitReader } from "./codex-rate-limits.js";
import { ClaudeLimitState } from "./claude-runner.js";
import { ApprovalStore } from "./approval-store.js";
import { ProcessManager } from "./process-manager.js";
import { formatError, PollFailureTracker } from "./poll-recovery.js";
import { handleUpdate } from "./router.js";
import { MemoryStore } from "./memory-store.js";
import { ScheduleStore } from "./schedule-store.js";
import { runDueSchedules } from "./scheduler.js";
import { TelegramSessionStore } from "./session-store.js";
import { TelegramClient } from "./telegram.js";
import { WorkspaceSessionStore } from "./workspaces.js";
import { startDashboardServer } from "./dashboard-server.js";
import { PersonalOpsStore } from "./personal-ops-store.js";
import { runDueWatches } from "./watch-runner.js";
import { ensurePersonalBriefingSchedules } from "./briefings.js";
import { decorateScheduledPrompt } from "./briefing-context.js";
import { createJobSettler } from "./job-settle.js";
import { buildLocalBriefing } from "./local-briefing.js";
import { runEnglishStudy } from "./english-study.js";
import { installLogTimestamps, trimRuntimeLogs } from "./maintenance.js";
import { runOperationalMonitor } from "./operational-monitor.js";
import { maybeRunDailyRepoChecks } from "./repo-checks.js";
import { announceRestart } from "./ops-actions.js";

// Node 24 gives each address family 250ms before trying the next; with no IPv6 route and
// ~300ms to Telegram over IPv4, every connection fails with ETIMEDOUT.
net.setDefaultAutoSelectFamilyAttemptTimeout(1000);
installLogTimestamps();
loadEnvFile();

const config = loadConfig();
const telegram = new TelegramClient(config.telegramBotToken, {
  requestTimeoutMs: config.telegramRequestTimeoutMs,
});
const claudeLimits = new ClaudeLimitState(config.claudeLimitStatePath, {
  threshold: config.claudeFallbackUtilization,
  snapshotPath: config.claudeRateLimitSnapshotPath,
});
const jobs = new JobManager(config, { claudeLimits });
const workspaces = new WorkspaceSessionStore(config.workspaces);
const processes = new ProcessManager();
const sessions = new TelegramSessionStore(config.sessionStatePath);
const memories = new MemoryStore(config.memoryStatePath);
const schedules = new ScheduleStore(config.scheduleStatePath);
const approvals = new ApprovalStore();
const personalOps = new PersonalOpsStore(config.personalOpsStatePath);
const readCodexLimits = createCodexLimitReader({ executable: config.codexExecutable });

const { settleJob } = createJobSettler({ config, telegram, jobs, workspaces, schedules, personalOps, sessions });

const abortController = new AbortController();
let nextOffset = null;
let shuttingDown = false;
let scheduleTimer = null;
let watchTimer = null;
let dashboardServer = null;
let maintenanceTimer = null;
let monitorTimer = null;
let pollFailureCount = 0;
const pollFailureTracker = new PollFailureTracker({
  threshold: config.pollRestartFailureThreshold,
  windowMs: config.pollRestartWindowMs,
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error?.stack || error?.message || error);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error?.stack || error?.message || error);
});

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await runMaintenance();
  await sessions.load();
  await claudeLimits.load();
  await memories.load();
  await schedules.load();
  await personalOps.load();
  const createdBriefings = await ensurePersonalBriefingSchedules({ schedules, config });
  if (createdBriefings.length) console.log(`Created ${createdBriefings.length} personal briefing schedule(s).`);
  dashboardServer = startDashboardServer({
    config,
    telegram,
    jobs,
    processes,
    schedules,
    workspaces,
    sessions,
    memories,
    approvals,
    personalOps,
  });
  warnOnWebhookConflict().catch((error) => console.error("Webhook check failed:", error.message));
  console.log(`Telegram AI bridge started (primary engine: ${config.aiProvider}).`);
  announceRestart({ config, telegram }).catch((error) => console.error("Restart notice failed:", error.message));
  scheduleTimer = setInterval(() => {
    runScheduleTick().catch((error) => console.error("Schedule tick error:", error.message));
  }, 30 * 1000);
  runScheduleTick().catch((error) => console.error("Schedule tick error:", error.message));
  watchTimer = setInterval(() => {
    runWatchTick().catch((error) => console.error("Watch tick error:", error.message));
  }, 60 * 1000);
  runWatchTick().catch((error) => console.error("Watch tick error:", error.message));
  monitorTimer = setInterval(() => {
    runMonitorTick().catch((error) => console.error("Operational monitor error:", error.message));
  }, 15 * 60 * 1000);
  runMonitorTick().catch((error) => console.error("Operational monitor error:", error.message));

  while (!shuttingDown) {
    try {
      const updates = await telegram.getUpdates({
        offset: nextOffset,
        timeoutSeconds: config.pollTimeoutSeconds,
        requestTimeoutMs: config.telegramRequestTimeoutMs,
        signal: abortController.signal,
      });

      if (pollFailureCount > 0) {
        console.log(`Telegram polling recovered after ${pollFailureCount} failure(s).`);
        pollFailureCount = 0;
      }

      for (const update of updates) {
        nextOffset = update.update_id + 1;
        await handleUpdate({
          update,
          config,
          telegram,
          jobs,
          workspaces,
          processes,
          sessions,
          memories,
          schedules,
          approvals,
          personalOps,
          onJobSettled: async (job) => {
            await settleJob(job);
          },
          readCodexLimits,
        });
      }
    } catch (error) {
      if (shuttingDown) {
        break;
      }

      pollFailureCount += 1;
      const recovery = pollFailureTracker.recordFailure();
      const retryMs = computeRetryDelayMs(pollFailureCount, config);
      console.error(
        `Polling error (${pollFailureCount}, ${recovery.count}/${config.pollRestartFailureThreshold} in recovery window): ${formatError(error)}. Retrying in ${Math.round(retryMs / 1000)}s.`,
      );

      if (recovery.shouldRestart) console.error("Telegram polling remains unstable; keeping local schedules and dashboard alive while retrying.");

      await sleep(retryMs);
    }
  }
}

async function runMaintenance() {
  const [trimmed, removed] = await Promise.all([trimRuntimeLogs(), cleanupStaleJobDirs()]);
  if (trimmed.length || removed) console.log(`Maintenance: trimmed ${trimmed.length} log(s), removed ${removed} stale job director${removed === 1 ? "y" : "ies"}.`);
  if (!maintenanceTimer) {
    maintenanceTimer = setInterval(() => runMaintenance().catch((error) => console.error("Maintenance error:", error.message)), 6 * 60 * 60 * 1000);
    maintenanceTimer.unref?.();
  }
}

async function runWatchTick() {
  if (!shuttingDown) await runDueWatches({ store: personalOps, telegram });
}

async function runMonitorTick() {
  if (shuttingDown) return;
  await runOperationalMonitor({ config, schedules, personalOps, telegram });
  await maybeRunDailyRepoChecks({ config, personalOps })
    .catch((error) => console.error("Repository checks failed:", error.message));
}

async function runScheduleTick() {
  if (shuttingDown) {
    return;
  }

  await runDueSchedules({
    schedules,
    jobs,
    workspaces,
    memories,
    telegram,
    onJobSettled: settleJob,
    decoratePrompt: (prompt, entry) => decorateScheduledPrompt(prompt, {
      config, chatId: entry.chatId, personalOps, schedules,
    }),
    runLocalBriefing: (entry, kind, now) => buildLocalBriefing({
      kind, config, chatId: entry.chatId, personalOps, schedules, now,
    }),
    runEnglishStudy: (entry, now) => runEnglishStudy({
      telegram, chatId: entry.chatId, personalOps, config, now,
    }),
  });
}

async function warnOnWebhookConflict() {
  try {
    const webhook = await telegram.getWebhookInfo();
    if (webhook.url) {
      console.warn(
        `Webhook is currently set: ${webhook.url}. Long polling via getUpdates will not work until it is deleted.`,
      );
    }
  } catch (error) {
    console.warn(`Failed to inspect webhook state: ${error.message}`);
  }
}

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
  }
  if (watchTimer) clearInterval(watchTimer);
  if (monitorTimer) clearInterval(monitorTimer);
  if (dashboardServer) {
    dashboardServer.close();
  }
  abortController.abort();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelayMs(failureCount, config) {
  const min = config.pollRetryMinMs;
  const max = config.pollRetryMaxMs;
  const exponential = min * 2 ** Math.min(failureCount - 1, 8);
  const capped = Math.min(max, exponential);
  const jitter = Math.floor(Math.random() * Math.min(1000, capped * 0.2));
  return capped + jitter;
}
