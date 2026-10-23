import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { filterRecentMetrics } from "./ai-usage-report.js";

const INBOX_TYPES = new Set(["task", "read", "idea", "document", "journal", "request"]);

export class PersonalOpsStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.version = 7;
    this.inbox = new Map();
    this.watches = new Map();
    this.briefings = new Map();
    this.preferences = new Map();
    this.runMetrics = new Map();
    this.alerts = new Map();
    this.experiments = new Map();
    this.trendTopics = [];
    this.repoChecks = null;
    this.saveQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      if (![1, 2, 3, 4, 5, 6, this.version].includes(parsed?.version)) return;
      this.inbox = new Map((parsed.inbox ?? []).filter(validInbox).map((row) => [row.id, row]));
      this.watches = new Map((parsed.watches ?? []).filter(validWatch).map((row) => [row.id, row]));
      this.briefings = new Map((parsed.briefings ?? []).filter(validBriefing).map((row) => [row.id, row]));
      this.preferences = new Map((parsed.preferences ?? []).filter(validPreference).map((row) => [row.id, row]));
      this.runMetrics = new Map((parsed.runMetrics ?? []).filter(validRunMetric).map((row) => [row.id, row]));
      this.alerts = new Map((parsed.alerts ?? []).filter(validAlert).map((row) => [row.key, row]));
      this.experiments = new Map((parsed.experiments ?? []).filter(validExperiment).map((row) => [row.id, row]));
      this.trendTopics = (parsed.trendTopics ?? []).filter((row) => row?.chatId && row?.title && row?.sentAt);
      this.repoChecks = parsed.repoChecks?.checkedAt && Array.isArray(parsed.repoChecks.repos) ? parsed.repoChecks : null;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async addInbox({ chatId, type = "idea", text, source = "telegram", now = new Date() }) {
    const normalizedType = INBOX_TYPES.has(type) ? type : "idea";
    const entry = {
      id: `in-${randomUUID().slice(0, 6)}`,
      chatId: String(chatId),
      type: normalizedType,
      text: String(text).trim(),
      source,
      status: "open",
      snoozedUntil: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (!entry.text) throw new Error("Inbox text is required.");
    this.inbox.set(entry.id, entry);
    await this.#save();
    return entry;
  }

  listInbox(chatId, { includeClosed = false, now = new Date() } = {}) {
    return [...this.inbox.values()]
      .filter((row) => row.chatId === String(chatId))
      .filter((row) => includeClosed || row.status === "open")
      .filter((row) => !row.snoozedUntil || Date.parse(row.snoozedUntil) <= now.getTime())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async updateInbox({ chatId, id, status, snoozedUntil = null, now = new Date() }) {
    const entry = this.inbox.get(id);
    if (!entry || entry.chatId !== String(chatId)) return null;
    entry.status = status;
    entry.snoozedUntil = snoozedUntil;
    entry.updatedAt = now.toISOString();
    await this.#save();
    return entry;
  }

  async addWatch({ chatId, userId, workspaceAlias, url, label, intervalMs = 60 * 60 * 1000, now = new Date() }) {
    const entry = {
      id: `wa-${randomUUID().slice(0, 6)}`,
      chatId: String(chatId),
      userId: String(userId),
      workspaceAlias,
      url: String(url),
      label: String(label || url).trim().slice(0, 160),
      intervalMs,
      nextCheckAt: now.toISOString(),
      lastHash: null,
      lastChangedAt: null,
      lastCheckedAt: null,
      lastError: null,
      failureCount: 0,
      createdAt: now.toISOString(),
    };
    if (!validWatch(entry)) throw new Error("Invalid watch entry.");
    this.watches.set(entry.id, entry);
    await this.#save();
    return entry;
  }

  listWatches(chatId = null) {
    return [...this.watches.values()]
      .filter((row) => chatId === null || row.chatId === String(chatId))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  dueWatches(now = new Date()) {
    return this.listWatches().filter((row) => Date.parse(row.nextCheckAt) <= now.getTime());
  }

  async updateWatch(id, updates, now = new Date()) {
    const entry = this.watches.get(id);
    if (!entry) return null;
    Object.assign(entry, updates, { lastCheckedAt: now.toISOString() });
    entry.nextCheckAt = new Date(now.getTime() + entry.intervalMs).toISOString();
    await this.#save();
    return entry;
  }

  async removeWatch({ chatId, id }) {
    const entry = this.watches.get(id);
    if (!entry || entry.chatId !== String(chatId)) return null;
    this.watches.delete(id);
    await this.#save();
    return entry;
  }

  summary(chatId) {
    const inbox = this.listInbox(chatId);
    const watches = this.listWatches(chatId);
    return {
      openInbox: inbox.length,
      inboxByType: Object.fromEntries([...INBOX_TYPES].map((type) => [type, inbox.filter((row) => row.type === type).length])),
      watches: watches.length,
      watchFailures: watches.filter((row) => row.failureCount > 0).length,
      preferences: this.listPreferences(chatId).length,
      experiments: this.listExperiments(chatId).filter((row) => !["archived", "discarded"].includes(row.status)).length,
      readyExperiments: this.listExperiments(chatId).filter((row) => row.status === "completed" && !row.readAt).length,
    };
  }

  async addExperiment({ chatId, type = "research", topic, workspaceAlias, scheduleId = null, parentId = null, followupKind = null, now = new Date() }) {
    const entry = {
      id: `lab-${randomUUID().slice(0, 6)}`,
      chatId: String(chatId),
      type: type === "build" ? "build" : "research",
      topic: String(topic || "").trim().slice(0, 1000),
      workspaceAlias: String(workspaceAlias || "default"),
      scheduleId,
      jobId: null,
      parentId,
      followupKind,
      readAt: null,
      status: "queued",
      result: "",
      artifacts: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
    };
    if (!entry.topic) throw new Error("Experiment topic is required.");
    this.experiments.set(entry.id, entry);
    await this.#save();
    return entry;
  }

  listExperiments(chatId, { includeArchived = false } = {}) {
    return [...this.experiments.values()]
      .filter((row) => row.chatId === String(chatId))
      .filter((row) => includeArchived || !["archived", "discarded"].includes(row.status))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async linkExperimentSchedule({ chatId, id, scheduleId, now = new Date() }) {
    const entry = this.experiments.get(id);
    if (!entry || entry.chatId !== String(chatId)) return null;
    entry.scheduleId = scheduleId;
    entry.updatedAt = now.toISOString();
    await this.#save();
    return entry;
  }

  async recordExperimentResult({ chatId, id, job, now = new Date() }) {
    const entry = this.experiments.get(id);
    if (!entry || entry.chatId !== String(chatId)) return null;
    entry.jobId = job.jobId || null;
    entry.status = job.status === "completed" ? "completed" : "failed";
    entry.result = String(job.summary || "").slice(0, 12000);
    entry.artifacts = (job.artifacts || []).map((item) => typeof item === "string" ? item : item.path).filter(Boolean).slice(0, 20);
    entry.updatedAt = now.toISOString();
    entry.completedAt = now.toISOString();
    await this.#save();
    return entry;
  }

  async setExperimentStatus({ chatId, id, status, now = new Date() }) {
    if (!["queued", "completed", "failed", "archived", "discarded"].includes(status)) return null;
    const entry = this.experiments.get(id);
    if (!entry || entry.chatId !== String(chatId)) return null;
    entry.status = status;
    entry.updatedAt = now.toISOString();
    await this.#save();
    return entry;
  }

  async markExperimentRead({ chatId, id }) {
    const entry = this.experiments.get(id);
    if (!entry || entry.chatId !== String(chatId) || entry.status !== "completed") return null;
    entry.readAt = new Date().toISOString();
    await this.#save();
    return entry;
  }

  async addPreference({ chatId, type, text, now = new Date() }) {
    const normalizedType = type === "like" ? "like" : "avoid";
    const normalizedText = String(text || "").trim();
    if (!normalizedText) throw new Error("Preference text is required.");
    const duplicate = this.listPreferences(chatId).find((row) => row.type === normalizedType && row.text === normalizedText);
    if (duplicate) return duplicate;
    const entry = { id: `pr-${randomUUID().slice(0, 6)}`, chatId: String(chatId), type: normalizedType, text: normalizedText.slice(0, 500), createdAt: now.toISOString() };
    this.preferences.set(entry.id, entry);
    await this.#save();
    return entry;
  }

  listPreferences(chatId) {
    return [...this.preferences.values()]
      .filter((row) => row.chatId === String(chatId))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async removePreference({ chatId, id }) {
    const entry = this.preferences.get(id);
    if (!entry || entry.chatId !== String(chatId)) return null;
    this.preferences.delete(id);
    await this.#save();
    return entry;
  }

  async recordRunMetric(job, { qualityRejected = false } = {}) {
    const entry = {
      id: String(job.jobId),
      chatId: String(job.chatId),
      kind: job.kind || "chat",
      status: job.status,
      source: job.kind === "scheduled-local" ? "local" : job.provider === "claude" ? "claude" : "codex",
      model: job.model || null,
      title: runTitle(job.prompt),
      workspaceAlias: job.workspaceAlias || null,
      fallbackReason: job.provider === "codex" ? job.fallbackReason || null : null,
      inputTokens: Number(job.usage?.inputTokens || 0),
      cachedInputTokens: Number(job.usage?.cachedInputTokens || 0),
      outputTokens: Number(job.usage?.outputTokens || 0),
      qualityRejected,
      briefingRetry: Number(job.briefingRetryCount || 0) > 0,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || new Date().toISOString(),
    };
    this.runMetrics.set(entry.id, entry);
    const rows = [...this.runMetrics.values()].sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
    for (const row of rows.slice(1000)) this.runMetrics.delete(row.id);
    await this.#save();
    return entry;
  }

  // Finished runs survive bridge restarts, unlike the in-memory job list.
  listRecentRuns(chatId, { limit = 8 } = {}) {
    return [...this.runMetrics.values()]
      .filter((row) => row.chatId === String(chatId))
      .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
      .slice(0, limit);
  }

  listRunMetrics(chatId, { days = 7, now = new Date() } = {}) {
    return filterRecentMetrics([...this.runMetrics.values()], chatId, { days, now });
  }

  usageSummary(chatId, { days = 30, now = new Date() } = {}) {
    const rows = this.listRunMetrics(chatId, { days, now });
    return rows.reduce((summary, row) => {
      summary.jobs += 1;
      summary[{ local: "localJobs", claude: "claudeJobs" }[row.source] || "codexJobs"] += 1;
      summary.failures += row.status === "completed" ? 0 : 1;
      summary.fallbacks += row.source === "codex" && row.fallbackReason ? 1 : 0;
      summary.qualityRetries += row.qualityRejected ? 1 : 0;
      summary.inputTokens += row.inputTokens;
      summary.cachedInputTokens += row.cachedInputTokens;
      summary.outputTokens += row.outputTokens;
      return summary;
    }, { periodDays: days, jobs: 0, localJobs: 0, claudeJobs: 0, codexJobs: 0, failures: 0, fallbacks: 0, qualityRetries: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  }

  getRepoChecks() {
    return this.repoChecks;
  }

  async setRepoChecks(result) {
    this.repoChecks = result;
    await this.#save();
    return result;
  }

  async reserveAlert(key, { cooldownMs = 12 * 60 * 60 * 1000, now = new Date() } = {}) {
    const existing = this.alerts.get(key);
    if (existing && now.getTime() - Date.parse(existing.sentAt) < cooldownMs) return false;
    this.alerts.set(key, { key, sentAt: now.toISOString() });
    await this.#save();
    return true;
  }

  activitySummary(chatId, { days = 7, now = new Date() } = {}) {
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    const entries = [...this.inbox.values()]
      .filter((row) => row.chatId === String(chatId))
      .filter((row) => Math.max(Date.parse(row.createdAt) || 0, Date.parse(row.updatedAt) || 0) >= cutoff)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const completed = entries.filter((row) => row.status === "done");
    const archived = entries.filter((row) => row.status === "archive");
    const open = this.listInbox(chatId, { now });
    return {
      periodDays: days,
      created: entries.filter((row) => (Date.parse(row.createdAt) || 0) >= cutoff).length,
      completed: completed.length,
      archived: archived.length,
      snoozed: [...this.inbox.values()].filter((row) => row.chatId === String(chatId)
        && row.status === "open" && row.snoozedUntil && Date.parse(row.snoozedUntil) > now.getTime()).length,
      stillOpen: open.length,
      completedItems: completed.slice(0, 20).map(compactInbox),
      archivedItems: archived.slice(0, 10).map(compactInbox),
      recentlyUpdatedOpen: open.filter((row) => (Date.parse(row.updatedAt) || 0) >= cutoff).slice(0, 20).map(compactInbox),
    };
  }

  async recordBriefing({ chatId, kind, text, recommendations = [], now = new Date() }) {
    const entry = {
      id: `br-${randomUUID().slice(0, 8)}`,
      chatId: String(chatId),
      kind,
      text: String(text || "").slice(0, 4000),
      recommendations: recommendations.map((item) => String(item).slice(0, 500)).slice(0, 6),
      feedback: null,
      recommendationFeedback: {},
      sentAt: now.toISOString(),
    };
    this.briefings.set(entry.id, entry);
    this.#trimBriefings();
    await this.#save();
    return entry;
  }

  // AI trend items already sent, so the next radar can skip them.
  async recordTrendTopics({ chatId, topics = [], now = new Date() }) {
    const rows = topics.filter((topic) => topic?.title).map((topic) => ({
      chatId: String(chatId),
      title: String(topic.title).slice(0, 200),
      url: topic.url ? String(topic.url).slice(0, 500) : null,
      sentAt: now.toISOString(),
    }));
    if (!rows.length) return;
    this.trendTopics = [...this.trendTopics, ...rows].slice(-100);
    await this.#save();
  }

  listTrendTopics(chatId, { days = 14, now = new Date() } = {}) {
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    return this.trendTopics.filter((row) => row.chatId === String(chatId) && Date.parse(row.sentAt) >= cutoff);
  }

  listBriefingHistory(chatId, { days = 30, limit = 40, now = new Date() } = {}) {
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    return [...this.briefings.values()]
      .filter((row) => row.chatId === String(chatId) && Date.parse(row.sentAt) >= cutoff)
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
      .slice(0, limit);
  }

  async setBriefingFeedback({ chatId, id, feedback, recommendationIndex = null }) {
    const entry = this.briefings.get(id);
    if (!entry || entry.chatId !== String(chatId) || !["interest", "done", "skip"].includes(feedback)) return null;
    if (recommendationIndex !== null) {
      const index = Number(recommendationIndex);
      if (!Number.isInteger(index) || index < 0 || index >= entry.recommendations.length) return null;
      entry.recommendationFeedback = { ...(entry.recommendationFeedback || {}), [index]: feedback };
    } else {
      entry.feedback = feedback;
    }
    entry.feedbackAt = new Date().toISOString();
    await this.#save();
    return entry;
  }

  #trimBriefings() {
    const rows = [...this.briefings.values()].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
    for (const row of rows.slice(200)) this.briefings.delete(row.id);
  }

  async #save() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const payload = {
      version: this.version,
      inbox: [...this.inbox.values()],
      watches: [...this.watches.values()],
      briefings: [...this.briefings.values()],
      preferences: [...this.preferences.values()],
      runMetrics: [...this.runMetrics.values()],
      alerts: [...this.alerts.values()],
      experiments: [...this.experiments.values()],
      trendTopics: this.trendTopics,
      repoChecks: this.repoChecks,
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const write = this.saveQueue.then(async () => {
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, serialized, "utf8");
      await fs.rename(temporary, this.statePath);
    });
    this.saveQueue = write.catch(() => {});
    await write;
  }
}

function compactInbox(row) {
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function parseInboxType(value) {
  const aliases = { "할일": "task", "읽기": "read", "아이디어": "idea", "문서": "document", "일기": "journal", "요청": "request" };
  return INBOX_TYPES.has(value) ? value : aliases[value] ?? null;
}

function validInbox(row) {
  return row && typeof row.id === "string" && typeof row.chatId === "string" && INBOX_TYPES.has(row.type) && typeof row.text === "string";
}

function validWatch(row) {
  return row && typeof row.id === "string" && typeof row.chatId === "string" && typeof row.userId === "string" &&
    typeof row.workspaceAlias === "string" && typeof row.url === "string" && typeof row.label === "string" &&
    Number.isInteger(row.intervalMs) && row.intervalMs >= 5 * 60 * 1000 && typeof row.nextCheckAt === "string";
}

function validBriefing(row) {
  return row && typeof row.id === "string" && typeof row.chatId === "string" && typeof row.kind === "string" &&
    typeof row.text === "string" && Array.isArray(row.recommendations) && typeof row.sentAt === "string";
}

function validPreference(row) {
  return row && typeof row.id === "string" && typeof row.chatId === "string"
    && ["like", "avoid"].includes(row.type) && typeof row.text === "string";
}

function validRunMetric(row) {
  return row && typeof row.id === "string" && typeof row.chatId === "string"
    && ["local", "claude", "codex"].includes(row.source) && typeof row.finishedAt === "string";
}

function validAlert(row) { return row && typeof row.key === "string" && typeof row.sentAt === "string"; }

function validExperiment(row) {
  return row && typeof row.id === "string" && typeof row.chatId === "string"
    && ["research", "build"].includes(row.type) && typeof row.topic === "string"
    && typeof row.workspaceAlias === "string" && typeof row.status === "string";
}

function runTitle(prompt) {
  const lines = String(prompt || "").split("\n").map((line) => line.replace(/^\[AI_WORKMATE_[A-Z_]+(?::[\w-]+)?\]\s*/, "").trim()).filter(Boolean);
  return (lines[0] || "").slice(0, 120) || null;
}
