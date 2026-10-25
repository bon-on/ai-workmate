import { getBriefingKind } from "./briefing-quality.js";
import { ENGLISH_STUDY_MARKER } from "./english-study.js";
import { applyLatePrefix } from "./local-briefing.js";
import { scheduleName } from "./schedule-names.js";

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
  runEnglishStudy,
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
    // Built by code and local Ollama: no AI job, so neither the usage pause nor a busy chat blocks it.
    if (entry.prompt.startsWith(ENGLISH_STUDY_MARKER)) {
      await schedules.markStarted(entry.id, now);
      // Not awaited: feeds and the local model can take minutes and must not delay other due entries.
      // A restart mid-build skips that day's lesson (markStarted already ran), like other briefings.
      Promise.resolve()
        .then(() => {
          if (!runEnglishStudy) throw new Error("English study runner is not configured");
          return runEnglishStudy(entry, now);
        })
        .catch((error) => telegram.sendMessage(entry.chatId, `⚠️ 영어 학습 메시지를 만들지 못했습니다: ${error.message}`))
        .catch((error) => console.error("English study failure notice failed:", error.message));
      continue;
    }
    const briefingKind = getBriefingKind(entry.prompt);
    // Morning and evening briefings are built locally, so an AI usage pause must not skip them.
    const isLocalBriefing = Boolean(runLocalBriefing) && ["morning", "evening"].includes(briefingKind);
    if (!isLocalBriefing && schedules.isUsagePaused?.(now)) continue;
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
        `⚠️ 예약 작업 '${scheduleName(entry.prompt)}'(${entry.id})을 시작하지 못했습니다: 작업 공간 ${entry.workspaceAlias}을 찾을 수 없습니다. 1분 뒤 다시 시도합니다.`,
      );
      continue;
    }

    const promptMemories = memories?.listForPrompt?.({
      chatId: entry.chatId,
      workspaceAlias: workspace.alias,
    }) ?? [];
    if (schedules.reserveBriefingAttempt && !await schedules.reserveBriefingAttempt(entry, { now, ignoreUsagePause: isLocalBriefing })) {
      await schedules.markStarted(entry.id, now);
      continue;
    }
    // Persist advancement before slow context collection or process startup.
    // A crash may skip this occurrence, but must not repeatedly spend tokens.
    const isBriefing = Boolean(briefingKind);
    // markStarted mutates the entry, so keep the occurrence time for the late-delivery check.
    const scheduledAt = entry.nextRunAt;
    if (isBriefing) await schedules.markStarted(entry.id, now);
    if (isLocalBriefing) {
      try {
        const built = await runLocalBriefing(entry, briefingKind, now, { scheduledAt });
        const late = applyLatePrefix(typeof built === "string" ? built : built?.summary, scheduledAt, now);
        const job = localJob(entry, workspace, briefingKind, now, "completed", late.text);
        if (late.late) job.late = true;
        if (built?.replyMarkup) job.replyMarkup = built.replyMarkup;
        await onJobSettled(job);
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
        await telegram.sendMessage(entry.chatId, `⚠️ 예약 작업 '${scheduleName(entry.prompt)}' 처리 중 오류가 발생했습니다: ${error.message}`);
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
