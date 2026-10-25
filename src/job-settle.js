import { notifyJobResult } from "./router.js";
import { ensureLabReport } from "./documents.js";
import { buildAiUsageReport, formatAiUsageReport } from "./ai-usage-report.js";
import { repoCheckBriefingLines } from "./repo-checks.js";
import { getBriefingKind, validateBriefingOutput, normalizeBriefingFormatting, extractTrendTopics } from "./briefing-quality.js";
import { scheduleName } from "./schedule-names.js";
import { isUsageLimitError } from "./schedule-store.js";
import { resolveUsageReset, describePauseEnd } from "./usage-pause.js";

// Job settlement logic extracted from index.js so it can be tested without
// starting the bridge. Behaviour is unchanged.
export function createJobSettler({ config, telegram, jobs, workspaces, schedules, personalOps, sessions, readCodexLimits = null }) {
  async function settleJob(job) {
    if (job.status === "completed" && getBriefingKind(job.prompt)) {
      job.summary = normalizeBriefingFormatting(job.summary);
    }
    if (job.status === "failed") await pauseOnUsageLimit(job);
    const retry = await retryInvalidBriefing(job);
    if (retry) {
      // The rejected draft still spent tokens; record it so usage reports see the retry.
      try { await personalOps.recordRunMetric(job, { qualityRejected: true }); }
      catch (error) { console.error("Usage metric persistence failed:", error.message); }
      return;
    }
    if (job.status === "completed" && getBriefingKind(job.prompt) === "weekly") {
      job.summary = appendWeeklyReport(job);
    }
    const labId = String(job.prompt || "").match(/\[AI_WORKMATE_LAB:(lab-[a-f0-9]+)\]/i)?.[1];
    if (labId) {
      let labJob = job;
      const experiment = personalOps.experiments?.get?.(labId);
      if (job.status === "completed" && experiment && job.workspacePath) {
        try {
          const report = await ensureLabReport({ root: job.workspacePath, experiment, summary: job.summary, artifacts: job.artifacts || [] });
          labJob = { ...job, artifacts: [...(job.artifacts || []), report.path] };
        } catch (error) { console.error("AI lab report file failed:", error.message); }
      }
      try { await personalOps.recordExperimentResult({ chatId: job.chatId, id: labId, job: labJob }); }
      catch (error) { console.error("AI lab result persistence failed:", error.message); }
    }
    // Dashboard requests may opt out of Telegram delivery; metrics and schedule results still apply.
    // A scheduled run stopped by a usage limit is reported by the pause notice alone (O11).
    const quiet = job.deliverToTelegram === false || (job.usageLimited && job.scheduleId);
    const messageId = quiet ? null : await notifyJobResult(telegram, job, { personalOps });
    if (messageId && job.status === "completed" && getBriefingKind(job.prompt) === "aiTrend") {
      try { await personalOps.recordTrendTopics({ chatId: job.chatId, topics: extractTrendTopics(job.summary) }); }
      catch (error) { console.error("AI trend topic persistence failed:", error.message); }
    }
    try { await personalOps.recordRunMetric(job); }
    catch (error) { console.error("Usage metric persistence failed:", error.message); }
    await recordScheduledJobResult(job);
    if (!messageId || !job.sessionId) {
      return;
    }

    await sessions.rememberBotReply({
      chatId: job.chatId,
      messageId,
      sessionId: job.sessionId,
      workspaceAlias: job.workspaceAlias,
      jobId: job.jobId,
      createdAt: job.finishedAt,
      provider: job.provider,
    });
  }

  // One notice per new pause; extending an active pause stays quiet.
  async function pauseOnUsageLimit(job) {
    const text = `${job.summary}\n${job.lastOutputSnippet || ""}`;
    if (!isUsageLimitError(text)) return;
    // Not the schedule's fault: the pause notice below is the only message (O11).
    job.usageLimited = true;
    const wasPaused = schedules.isUsagePaused?.() ?? false;
    const reset = wasPaused ? {} : await resolveUsageReset(job, { readCodexLimits });
    const applied = await schedules.pauseForUsageLimit(text, new Date(), {
      ...reset,
      chatId: job.chatId,
      scheduleName: job.scheduleId ? scheduleName(job.prompt) : null,
    });
    if (!applied || wasPaused || !job.chatId) return;
    const pause = schedules.getUsagePause?.();
    if (!pause) return;
    try { await telegram.sendMessage(job.chatId, formatUsagePauseNotice(pause)); }
    catch (error) { console.error("Usage pause notice failed:", error.message); }
  }

  async function retryInvalidBriefing(job) {
    const kind = getBriefingKind(job.prompt);
    if (!kind || job.kind === "scheduled-local" || job.status !== "completed" || job.briefingRetryCount >= 1) return false;
    const recentHistory = personalOps.listBriefingHistory(job.chatId, { days: 14, limit: 20 });
    const validation = validateBriefingOutput(job, recentHistory);
    if (validation.valid) return false;
    const workspace = workspaces.getWorkspaceByAlias(job.workspaceAlias);
    if (!workspace) return false;
    if (job.scheduleId && !await schedules.reserveBriefingAttempt(job, { retry: true })) return false;
    if (schedules.isUsagePaused()) return false;
    const correction = `${job.prompt}\n\n이전 초안은 품질 검사에서 다음 문제로 반려되었습니다: ${validation.issues.join(", ")}\n이전 초안:\n${job.summary}\n\n문제를 고쳐 최종 브리핑만 다시 출력하세요.`;
    const started = await jobs.startJob({
      chatId: job.chatId,
      userId: job.userId,
      prompt: correction,
      workspace,
      memories: job.memories,
      scheduleId: job.scheduleId,
      replyToMessageId: job.replyToMessageId,
      operationMode: job.operationMode,
      modelTier: job.modelTier || "scheduled",
    });
    if (!started.accepted) return false;
    started.job.briefingRetryCount = 1;
    started.job.completion.then(settleJob).catch(async (error) => {
      await telegram.sendMessage(job.chatId, `브리핑 재생성 중 오류가 발생했습니다: ${error.message}`);
    });
    return true;
  }

  // Numbers are appended by code so the model cannot misstate them.
  function appendWeeklyReport(job) {
    const sections = [job.summary];
    try {
      sections.push(formatAiUsageReport(buildAiUsageReport({
        personalOps, chatId: job.chatId, days: 7, claudeLimits: jobs.claudeLimits,
      })));
    } catch (error) { console.error("Weekly usage report failed:", error.message); }
    const repoLines = repoCheckBriefingLines(personalOps.getRepoChecks?.());
    if (repoLines.length) sections.push(["🧰 저장소 점검", ...repoLines].join("\n"));
    return sections.join("\n\n");
  }

  async function recordScheduledJobResult(job) {
    if (!job.scheduleId) {
      return;
    }

    if (job.status === "completed") {
      await schedules.recordSuccess(job.scheduleId);
      return;
    }
    if (job.usageLimited) return;

    const updated = await schedules.recordFailure(job.scheduleId, job.summary, {
      maxFailures: config.scheduleMaxFailures,
    });
    if (updated?.disabled) {
      await telegram.sendMessage(
        job.chatId,
        `⛔ 예약 작업 '${scheduleName(updated.prompt)}'(${job.scheduleId})을 ${updated.failureCount}회 연속 실패로 중지했습니다.`,
      );
    }
  }

  return { settleJob, retryInvalidBriefing, recordScheduledJobResult };
}

export function formatUsagePauseNotice(pause) {
  return [
    "⏸ AI 예약 작업을 잠시 멈췄습니다",
    `사유: ${pause.reason}`,
    ...(pause.scheduleName ? [`영향: ${pause.scheduleName}`] : []),
    describePauseEnd(pause),
    "모닝·이브닝 브리핑과 영어 학습은 계속 발송됩니다.",
    "지금 다시 시작하려면 /resume",
  ].join("\n");
}
