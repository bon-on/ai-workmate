import { getBriefingKind } from "./briefing-quality.js";

const BUSY_RETRY_MS = 60 * 1000;
const runningTicks = new WeakSet();

export async function runDueSchedules({
  schedules,
  jobs,
  workspaces,
  memories,
  telegram,
  onJobSettled,
  decoratePrompt,
  runLocalBriefing,
  now = new Date(),
}) {
  if (runningTicks.has(schedules)) return [];
  runningTicks.add(schedules);
  try {
  const dueEntries = schedules.due(now, { includeWhileUsagePaused: true });
  const startedJobs = [];

  for (const entry of dueEntries) {
    if (entry.prompt.startsWith("[AI_WORKMATE_REMINDER]")) {
      await schedules.markStarted(entry.id, now);
      const reminder = entry.prompt.replace(/^\[AI_WORKMATE_REMINDER\]\s*/, "").trim();
      await telegram.sendMessage(entry.chatId, `⏰ 알림\n${reminder}`);
      continue;
    }
    if (schedules.isUsagePaused?.(now)) continue;
    if (jobs.getActiveJob(entry.chatId)) {
      // Leave its occurrence intact. A busy check must never pull tomorrow's
      // reservation back into today (including entries captured by an old tick).
      continue;
    }

    const workspace = workspaces.getWorkspaceByAlias(entry.workspaceAlias);
    if (!workspace) {
      await schedules.delay(entry.id, BUSY_RETRY_MS, now);
      await telegram.sendMessage(
        entry.chatId,
        `Scheduled job ${entry.id} could not start because workspace ${entry.workspaceAlias} is unavailable.`,
      );
      continue;
    }

    const promptMemories = memories?.listForPrompt?.({
      chatId: entry.chatId,
      workspaceAlias: workspace.alias,
    }) ?? [];
    if (schedules.reserveBriefingAttempt && !await schedules.reserveBriefingAttempt(entry, { now })) {
      await schedules.markStarted(entry.id, now);
      continue;
    }
    // Persist advancement before slow context collection or process startup.
    // A crash may skip this occurrence, but must not repeatedly spend tokens.
    const isBriefing = Boolean(getBriefingKind(entry.prompt));
    if (isBriefing) await schedules.markStarted(entry.id, now);
    const briefingKind = getBriefingKind(entry.prompt);
    if (runLocalBriefing && ["morning", "evening"].includes(briefingKind)) {
      try {
        const summary = await runLocalBriefing(entry, briefingKind, now);
        await onJobSettled(localJob(entry, workspace, briefingKind, now, "completed", summary));
      } catch (error) {
        await onJobSettled(localJob(entry, workspace, briefingKind, now, "failed", `로컬 브리핑 생성 실패: ${error.message}`));
      }
      continue;
    }
    const prompt = decoratePrompt ? await decoratePrompt(entry.prompt, entry) : entry.prompt;
    const started = await jobs.startJob({
      chatId: entry.chatId,
      userId: entry.userId,
      prompt,
      workspace,
      memories: promptMemories,
      scheduleId: entry.id,
      replyToMessageId: null,
      // Same mode as the manual briefing commands, so research briefs may use web tools.
      operationMode: isBriefing ? "brief" : "default",
      modelTier: isBriefing ? "scheduled" : null,
    });

    if (!started.accepted) {
      continue;
    }

    if (!isBriefing) await schedules.markStarted(entry.id, now);
    startedJobs.push(started.job);
    started.job.completion
      .then((job) => onJobSettled(job))
      .catch(async (error) => {
        await telegram.sendMessage(entry.chatId, `Scheduled job failed unexpectedly: ${error.message}`);
      });
  }

  return startedJobs;
  } finally {
    runningTicks.delete(schedules);
  }
}

function localJob(entry, workspace, kind, now, status, summary) {
  return {
    jobId: `local-${kind}-${now.toISOString().slice(0, 10)}`,
    kind: "scheduled-local",
    scheduleId: entry.id,
    chatId: entry.chatId,
    userId: entry.userId,
    prompt: entry.prompt,
    memories: [],
    workspaceAlias: workspace.alias,
    workspacePath: workspace.path,
    sessionId: null,
    resumeFromSessionId: null,
    status,
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: status === "completed" ? 0 : 1,
    summary,
    lastOutputSnippet: "",
    artifacts: [],
    replyToMessageId: null,
  };
}
