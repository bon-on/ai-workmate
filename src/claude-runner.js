import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

// Closest match to `codex exec --sandbox workspace-write`: edits are auto-accepted,
// Bash runs inside Claude Code's sandbox and may not escape it.
const SANDBOX_SETTINGS = {
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
};
const OPERATION_TOOLS = ["WebSearch", "WebFetch"];
const UNKNOWN_RESET_COOLDOWN_MS = 60 * 60 * 1000;
const LIMIT_TEXT = /hit your (?:\w+ )?limit|usage limit|rate limit(?:ed)? (?:reached|exceeded)|limit reached/i;

export function buildClaudeArgs(
  config,
  sessionId = null,
  operationMode = "default",
  unrestricted = false,
  model = null,
  effort = null,
) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  if (unrestricted) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "acceptEdits", "--settings", JSON.stringify(SANDBOX_SETTINGS));
  }

  if (operationMode !== "default") {
    const tools = [...OPERATION_TOOLS];
    if (config.claudeMcpConfig) {
      args.push("--mcp-config", config.claudeMcpConfig);
      tools.push(...readMcpServerNames(config.claudeMcpConfig).map((name) => `mcp__${name}`));
    }
    if (!unrestricted) args.push(`--allowedTools=${tools.join(",")}`);
  }

  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  return args;
}

function readMcpServerNames(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return Object.keys(parsed?.mcpServers || {});
  } catch {
    return [];
  }
}

// Consumes complete stream-json lines; partial lines are kept on the job until the next chunk.
export function consumeClaudeOutput(text, job, { onRateLimit = null } = {}) {
  const buffered = `${job.claudeLineBuffer || ""}${text}`;
  const lines = buffered.split("\n");
  job.claudeLineBuffer = lines.pop();
  for (const line of lines) handleClaudeLine(line, job, onRateLimit);
}

export function flushClaudeOutput(job, { onRateLimit = null } = {}) {
  const rest = job.claudeLineBuffer || "";
  job.claudeLineBuffer = "";
  if (rest.trim()) handleClaudeLine(rest, job, onRateLimit);
}

function handleClaudeLine(line, job, onRateLimit) {
  let parsed;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
    job.sessionId = parsed.session_id;
  }
  if (parsed.type === "rate_limit_event" && parsed.rate_limit_info && typeof parsed.rate_limit_info === "object") {
    job.claudeRateLimit = parsed.rate_limit_info;
    if (parsed.rate_limit_info.status === "rejected") job.claudeRateLimitRejected = true;
    onRateLimit?.(parsed.rate_limit_info);
  }
  if (parsed.type === "result") {
    job.claudeResult = {
      isError: parsed.is_error === true || (typeof parsed.subtype === "string" && parsed.subtype !== "success"),
      text: typeof parsed.result === "string" ? parsed.result : "",
    };
    const usage = parsed.usage;
    if (usage && typeof usage === "object") {
      job.usage = {
        inputTokens: count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
        cachedInputTokens: count(usage.cache_read_input_tokens),
        outputTokens: count(usage.output_tokens),
      };
    }
  }
}

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function isClaudeLimitFailure(job, { exitCode = null, spawnError = null } = {}) {
  if (spawnError) return true;
  if (job.claudeRateLimitRejected && (exitCode !== 0 || job.claudeResult?.isError !== false)) return true;
  return job.claudeResult?.isError === true && LIMIT_TEXT.test(job.claudeResult.text);
}

export class ClaudeLimitState {
  constructor(statePath, { threshold = 0.95, now = Date.now, snapshotPath = null } = {}) {
    this.statePath = statePath;
    this.snapshotPath = snapshotPath;
    this.snapshotMtimeMs = 0;
    this.threshold = threshold;
    this.now = now;
    this.state = { exhaustedUntil: null, windows: {}, checkedAt: null };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fsPromises.readFile(this.statePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        this.state = {
          exhaustedUntil: typeof parsed.exhaustedUntil === "string" ? parsed.exhaustedUntil : null,
          windows: parsed.windows && typeof parsed.windows === "object" ? parsed.windows : {},
          checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : null,
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  record(info) {
    const windows = { ...this.state.windows };
    for (const [name, row] of Object.entries(info?.unifiedWindows || {})) {
      const window = normalizeWindow(row?.utilization, row?.resetsAt);
      if (window) windows[name] = window;
    }
    if (typeof info?.rateLimitType === "string") {
      const window = normalizeWindow(info.utilization, info.resetsAt);
      if (window) windows[info.rateLimitType] = window;
    }
    this.state = { ...this.state, windows, checkedAt: new Date(this.now()).toISOString() };
    if (info?.status === "rejected") return this.markExhausted(info.resetsAt);
    return this.#save();
  }

  markExhausted(resetsAtSeconds = null) {
    const reset = Number(resetsAtSeconds) * 1000;
    const until = Number.isFinite(reset) && reset > this.now() ? reset : this.now() + UNKNOWN_RESET_COOLDOWN_MS;
    const current = Date.parse(this.state.exhaustedUntil) || 0;
    this.state = { ...this.state, exhaustedUntil: new Date(Math.max(until, current)).toISOString() };
    return this.#save();
  }

  shouldFallback() {
    this.#mergeSnapshot();
    const now = this.now();
    if (Date.parse(this.state.exhaustedUntil) > now) {
      return { fallback: true, reason: "Claude 사용 한도 도달", until: this.state.exhaustedUntil };
    }
    for (const [name, window] of Object.entries(this.state.windows)) {
      if (window.utilization >= this.threshold && Date.parse(window.resetsAt) > now) {
        return { fallback: true, reason: `Claude ${name} 한도 ${Math.round(window.utilization * 100)}% 사용`, until: window.resetsAt };
      }
    }
    return { fallback: false, reason: null, until: null };
  }

  // Same shape as createCodexLimitReader results so status and dashboard can share rendering.
  snapshot() {
    this.#mergeSnapshot();
    const toRow = (window) => {
      if (!window) return null;
      const idle = !window.resetsAt || Date.parse(window.resetsAt) <= this.now();
      const usedPercent = idle ? 0 : Math.round(window.utilization * 100);
      return { usedPercent, remainingPercent: 100 - usedPercent, resetsAt: idle ? null : window.resetsAt, idle };
    };
    const fiveHour = toRow(this.state.windows.five_hour);
    const weekly = toRow(this.state.windows.seven_day);
    return {
      status: fiveHour || weekly ? "available" : "unavailable",
      fiveHour,
      weekly,
      exhaustedUntil: Date.parse(this.state.exhaustedUntil) > this.now() ? this.state.exhaustedUntil : null,
      checkedAt: this.state.checkedAt,
    };
  }

  // The account is shared with interactive Claude Code sessions, whose statusline
  // reports rate limits for free. Use that file when it is newer than the last job event.
  #mergeSnapshot() {
    if (!this.snapshotPath) return;
    let mtimeMs;
    let parsed;
    try {
      mtimeMs = fs.statSync(this.snapshotPath).mtimeMs;
      if (mtimeMs <= this.snapshotMtimeMs) return;
      parsed = JSON.parse(fs.readFileSync(this.snapshotPath, "utf8"));
    } catch {
      return;
    }
    this.snapshotMtimeMs = mtimeMs;
    if (mtimeMs <= (Date.parse(this.state.checkedAt) || 0)) return;
    const windows = { ...this.state.windows };
    for (const name of ["five_hour", "seven_day"]) {
      const row = parsed?.[name];
      // Claude Code omits a window that has not started since its last reset.
      const window = row ? normalizeWindow(Number(row.used_percentage) / 100, row.resets_at) : { utilization: 0, resetsAt: null };
      if (window) windows[name] = window;
    }
    this.state = { ...this.state, windows, checkedAt: new Date(mtimeMs).toISOString() };
  }

  #save() {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fsPromises.mkdir(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmp, payload, "utf8");
      await fsPromises.rename(tmp, this.statePath);
    });
    return this.writing;
  }
}

function normalizeWindow(utilization, resetsAt) {
  const used = Number(utilization);
  const reset = Number(resetsAt) * 1000;
  if (!Number.isFinite(used) || !Number.isFinite(reset)) return null;
  return { utilization: Math.min(1, Math.max(0, used)), resetsAt: new Date(reset).toISOString() };
}
