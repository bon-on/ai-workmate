import os from "node:os";
import { execFileSync } from "node:child_process";
import { evaluateBriefingHistory } from "./briefing-eval.js";

export function buildDashboardSnapshot({
  chatId,
  jobs,
  processes,
  schedules,
  workspaces,
  personalOps,
  now = new Date(),
  uptimeSeconds = process.uptime(),
}) {
  const recentJobs = jobs.listJobs?.(chatId) ?? [];
  const activeJob = jobs.getActiveJob?.(chatId) ?? null;
  const delegateJobs = recentJobs.filter((job) => job.kind === "delegate");
  const runningDelegates = delegateJobs.filter((job) => isLiveStatus(job.status));
  const managedProcesses = processes.list?.(chatId) ?? [];
  const liveProcesses = managedProcesses.filter((entry) => isLiveProcess(entry.status));
  const scheduledJobs = schedules?.list?.(chatId) ?? [];
  const activeWorkspace = workspaces.getActiveWorkspace?.(chatId) ?? null;
  const delegatePool = buildDelegatePool(jobs.config, runningDelegates);
  const personal = personalOps?.summary?.(chatId) ?? { openInbox: 0, inboxByType: {}, watches: 0, watchFailures: 0 };
  const usage = personalOps?.usageSummary?.(chatId, { days: 30, now }) ?? summarizeUsage(recentJobs);
  const briefingQuality = evaluateBriefingHistory(personalOps?.listBriefingHistory?.(chatId, { days: 30, limit: 40, now }) ?? []);
  const recentBriefings = (personalOps?.listBriefingHistory?.(chatId, { days: 14, limit: 8, now }) ?? []).map((row) => ({ id: row.id, kind: row.kind, sentAt: row.sentAt, text: row.text }));
  const inbox = (personalOps?.listInbox?.(chatId, { now }) ?? []).slice(0, 8).map((row) => ({ id: row.id, type: row.type, text: row.text, createdAt: row.createdAt }));
  const preferences = (personalOps?.listPreferences?.(chatId) ?? []).slice(0, 20);
  const experiments = (personalOps?.listExperiments?.(chatId, { includeArchived: true }) ?? []).map((row) => ({
    id: row.id,
    readAt: row.readAt || null,
    parentId: row.parentId || null,
    followupKind: row.followupKind || null,
    type: row.type,
    topic: row.topic,
    status: recentJobs.some(job => job.scheduleId === row.scheduleId && isLiveStatus(job.status)) ? "running"
      : row.status === "queued" && activeJob && scheduledJobs.some(entry => entry.id === row.scheduleId && Date.parse(entry.nextRunAt) <= now.getTime()) ? "waiting" : row.status,
    result: row.result,
    artifacts: row.artifacts,
    scheduleId: row.scheduleId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  }));

  return {
    chatId: String(chatId),
    time: now.toISOString(),
    uptime: formatDuration(Math.floor(uptimeSeconds * 1000)),
    workspace: activeWorkspace,
    system: buildSystemSummary(uptimeSeconds),
    pool: {
      foreground: activeJob ? {
        state: "busy",
        jobId: activeJob.jobId,
        status: activeJob.status,
      } : { state: "idle" },
      delegate: delegatePool,
      processes: {
        running: liveProcesses.length,
        known: managedProcesses.length,
      },
      schedules: {
        active: scheduledJobs.length,
        usagePaused: schedules?.isUsagePaused?.(now) ?? false,
        usagePausedUntil: schedules?.usagePausedUntil ?? null,
      },
    },
    activeJob: activeJob ? summarizeJob(activeJob, now) : null,
    runningDelegates: runningDelegates.slice(0, 5).map((job) => summarizeJob(job, now)),
    recentJobs: mergeRecentJobs(recentJobs, personalOps?.listRecentRuns?.(chatId, { limit: 8 }) ?? [], now),
    processes: managedProcesses.slice(0, 8).map((entry) => summarizeProcess(entry, now)),
    schedules: scheduledJobs.slice(0, 20).map(summarizeSchedule),
    personal,
    usage,
    briefingQuality,
    recentBriefings,
    inbox,
    preferences,
    experiments,
  };
}

function buildSystemSummary(uptimeSeconds) {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const memory = systemMemoryUsage(totalMemory, freeMemory);
  const load = os.loadavg();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuCount: os.cpus().length,
    load1: Number(load[0].toFixed(2)),
    load5: Number(load[1].toFixed(2)),
    memoryUsedBytes: memory.usedBytes,
    memoryTotalBytes: totalMemory,
    memoryUsedPercent: memory.usedPercent,
    memoryMetric: memory.metric,
    systemUptime: safeSystemUptime(),
    bridgeUptime: formatDuration(Math.floor(uptimeSeconds * 1000)),
  };
}

function systemMemoryUsage(totalMemory, freeMemory) {
  if (os.platform() === "darwin") {
    try {
      const output = execFileSync("memory_pressure", [], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const freePercent = parseMemoryPressureFreePercent(output);
      if (freePercent !== null) {
        const usedPercent = 100 - freePercent;
        return {
          usedPercent,
          usedBytes: Math.round(totalMemory * usedPercent / 100),
          metric: "pressure",
        };
      }
    } catch {
      // Fall back to the portable free-memory calculation.
    }
  }
  return {
    usedPercent: Math.round(((totalMemory - freeMemory) / totalMemory) * 100),
    usedBytes: totalMemory - freeMemory,
    metric: "physical",
  };
}

export function parseMemoryPressureFreePercent(output) {
  const match = String(output).match(/System-wide memory free percentage:\s*(\d+)%/i);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : null;
}

function safeSystemUptime() {
  try {
    return formatDuration(Math.floor(os.uptime() * 1000));
  } catch {
    return "unavailable";
  }
}

export function formatDashboard(input) {
  const snapshot = buildDashboardSnapshot(input);

  return [
    "AI Workmate Dashboard",
    `Time: ${snapshot.time}`,
    `Bridge: running, uptime ${snapshot.uptime}`,
    snapshot.workspace ? `Workspace: ${snapshot.workspace.alias} (${snapshot.workspace.path})` : null,
    "",
    "Pool",
    `Foreground slot: ${snapshot.pool.foreground.state === "busy" ? `busy (${snapshot.pool.foreground.jobId}, ${snapshot.pool.foreground.status})` : "idle"}`,
    `Delegate pool: ${snapshot.pool.delegate.running} running, total limit ${snapshot.pool.delegate.totalLimitLabel}, chat limit ${snapshot.pool.delegate.chatLimitLabel}`,
    `Managed processes: ${snapshot.pool.processes.running} running / ${snapshot.pool.processes.known} known`,
    `Schedules: ${snapshot.pool.schedules.active} active`,
    `Personal inbox: ${snapshot.personal.openInbox} open | Watches: ${snapshot.personal.watches} (${snapshot.personal.watchFailures} failing)`,
    `Usage (30d): ${snapshot.usage.claudeJobs ?? 0} Claude + ${snapshot.usage.codexJobs ?? snapshot.usage.jobs} Codex + ${snapshot.usage.localJobs ?? 0} local | ${snapshot.usage.inputTokens.toLocaleString("ko-KR")} input | ${snapshot.usage.outputTokens.toLocaleString("ko-KR")} output tokens`,
    `Briefing format check (30d; format only, factual accuracy not evaluated): ${snapshot.briefingQuality.samples} samples | ${snapshot.briefingQuality.averageScore ?? "-"}/100 format score | ${snapshot.briefingQuality.duplicateRecommendations} repeated recommendations`,
    "",
    "Current Work",
    snapshot.activeJob ? formatJobSummary(snapshot.activeJob) : "No active foreground job.",
    snapshot.runningDelegates.length > 0 ? snapshot.runningDelegates.map(formatJobSummary).join("\n") : "No running delegated jobs.",
    "",
    "Recent Jobs",
    snapshot.recentJobs.length > 0 ? snapshot.recentJobs.map(formatJobSummary).join("\n") : "No jobs since the bridge started.",
    "",
    "Processes",
    snapshot.processes.length > 0 ? snapshot.processes.map(formatProcessSummary).join("\n") : "No managed background processes.",
    "",
    "Next Schedules",
    snapshot.schedules.length > 0 ? snapshot.schedules.map(formatScheduleSummary).join("\n") : "No scheduled jobs.",
  ].filter((line) => line !== null).join("\n");
}

function isLiveStatus(status) {
  return status === "queued" || status === "running";
}

function isLiveProcess(status) {
  return status === "running" || status === "stopping";
}

function buildDelegatePool(config, runningDelegates) {
  const totalLimit = config?.maxDelegateJobsTotal;
  const chatLimit = config?.maxDelegateJobsPerChat;
  return {
    running: runningDelegates.length,
    totalLimit: Number.isFinite(totalLimit) ? totalLimit : null,
    chatLimit: Number.isFinite(chatLimit) ? chatLimit : null,
    totalLimitLabel: Number.isFinite(totalLimit) ? String(totalLimit) : "unlimited",
    chatLimitLabel: Number.isFinite(chatLimit) ? String(chatLimit) : "unlimited",
  };
}

function mergeRecentJobs(liveJobs, runs, now) {
  const live = liveJobs.slice(0, 8).map((job) => summarizeJob(job, now));
  const seen = new Set(live.map((job) => job.jobId));
  const persisted = runs.filter((run) => !seen.has(run.id)).map((run) => ({
    jobId: run.id,
    kind: run.kind,
    status: run.status,
    workspaceAlias: run.workspaceAlias ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt,
    age: formatAge(run.startedAt || run.finishedAt, now),
    provider: run.source === "local" ? null : run.source,
    model: run.model ?? null,
    fallbackReason: run.fallbackReason ?? null,
    prompt: summarize(run.title || (run.kind === "scheduled-local" ? "로컬 브리핑" : "(기록 이전 작업)")),
    summary: "",
    usage: null,
    persisted: true,
  }));
  return [...live, ...persisted]
    .sort((a, b) => Date.parse(b.finishedAt || b.startedAt || 0) - Date.parse(a.finishedAt || a.startedAt || 0))
    .slice(0, 8);
}

function summarizeJob(job, now) {
  const age = formatAge(job.startedAt, now);
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    workspaceAlias: job.workspaceAlias,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    age,
    provider: job.provider ?? null,
    model: job.model ?? null,
    fallbackReason: job.provider === "codex" ? job.fallbackReason ?? null : null,
    prompt: summarize(job.prompt),
    summary: summarize(job.summary, 500),
    usage: job.usage ?? null,
  };
}

function summarizeUsage(jobs) {
  return jobs.reduce((total, job) => {
    if (!job.usage) return total;
    total.jobs += 1;
    total.inputTokens += Number(job.usage.inputTokens || 0);
    total.cachedInputTokens += Number(job.usage.cachedInputTokens || 0);
    total.outputTokens += Number(job.usage.outputTokens || 0);
    return total;
  }, { jobs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
}

function summarizeProcess(entry, now) {
  const age = formatAge(entry.startedAt, now);
  return {
    processId: entry.processId,
    status: entry.status,
    workspaceAlias: entry.workspaceAlias,
    pid: entry.pid ?? null,
    startedAt: entry.startedAt,
    age,
    command: entry.command,
  };
}

function summarizeSchedule(entry) {
  const repeat = entry.intervalMs ? `every ${formatDuration(entry.intervalMs)}` : "one-time";
  return {
    id: entry.id,
    workspaceAlias: entry.workspaceAlias,
    nextRunAt: entry.nextRunAt,
    repeat,
    failureCount: entry.failureCount ?? 0,
    prompt: summarize(entry.prompt),
  };
}

function formatJobSummary(job) {
  return `${job.jobId} | ${job.kind} | ${job.status} | ${job.workspaceAlias} | ${job.age} | ${job.prompt}`;
}

function formatProcessSummary(entry) {
  return `${entry.processId} | ${entry.status} | ${entry.workspaceAlias} | PID ${entry.pid ?? "?"} | ${entry.age} | ${entry.command}`;
}

function formatScheduleSummary(entry) {
  const failures = entry.failureCount ? ` | failures ${entry.failureCount}` : "";
  return `${entry.id} | ${entry.workspaceAlias} | ${entry.nextRunAt} | ${entry.repeat}${failures} | ${entry.prompt}`;
}

function formatAge(isoString, now) {
  const timestamp = Date.parse(isoString);
  if (!Number.isFinite(timestamp)) {
    return "unknown age";
  }

  return `${formatDuration(now.getTime() - timestamp)} ago`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function summarize(prompt, maxLength = 90) {
  const compact = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact || "(empty)";
  }

  return `${compact.slice(0, maxLength - 3)}...`;
}
