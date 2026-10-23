import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeLimitState, buildClaudeArgs, consumeClaudeOutput, flushClaudeOutput, isClaudeLimitFailure } from "../src/claude-runner.js";
import { JobManager } from "../src/job-manager.js";

const RESET_SECONDS = 4_102_444_800; // 2100-01-01

async function makeFakes(dir, { claudeLines, claudeExit = 0 }) {
  const claudePath = path.join(dir, "fake-claude.mjs");
  const codexPath = path.join(dir, "fake-codex.mjs");
  await fs.writeFile(claudePath, `#!/usr/bin/env node
import fs from "node:fs";
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(path.join(dir, "claude-call.json"))}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
for (const line of ${JSON.stringify(claudeLines)}) process.stdout.write(JSON.stringify(line) + "\\n");
process.exit(${claudeExit});
`);
  await fs.writeFile(codexPath, `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, "codex-call.json"))}, JSON.stringify({ argv }));
fs.writeFileSync(argv[argv.indexOf("-o") + 1], "codex answer");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }) + "\\n");
`);
  await fs.chmod(claudePath, 0o755);
  await fs.chmod(codexPath, 0o755);
  return { claudePath, codexPath };
}

function makeManager(dir, fakes, { claudeLimits = null, aiProvider = "claude" } = {}) {
  return new JobManager({
    aiProvider,
    claudeExecutable: fakes.claudePath,
    codexExecutable: fakes.codexPath,
    scheduledClaudeModel: "sonnet",
    scheduledClaudeEffort: "low",
    scheduledCodexModel: "gpt-5.6-luna",
    scheduledCodexReasoningEffort: "none",
    jobTimeoutMs: 20_000,
    maxLogBytes: 20_000,
  }, { claudeLimits });
}

async function readCall(dir, name) {
  try { return JSON.parse(await fs.readFile(path.join(dir, `${name}-call.json`), "utf8")); }
  catch { return null; }
}

const okLines = [
  { type: "system", subtype: "init", session_id: "claude-sess" },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: RESET_SECONDS }, seven_day: { utilization: 0.1, resetsAt: RESET_SECONDS } } }, session_id: "claude-sess" },
  { type: "result", subtype: "success", is_error: false, result: "claude answer", session_id: "claude-sess", usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 } },
];
const rejectedLines = [
  { type: "system", subtype: "init", session_id: "claude-sess" },
  { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: RESET_SECONDS, rateLimitType: "five_hour", utilization: 1 }, session_id: "claude-sess" },
  { type: "result", subtype: "success", is_error: true, result: "You've hit your limit", session_id: "claude-sess" },
];

test("buildClaudeArgs keeps default jobs sandboxed and grants web tools only in operations modes", () => {
  const args = buildClaudeArgs({}, null, "default", false, "sonnet", "low");
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.deepEqual(settings.sandbox, { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
  assert.equal(args.some((arg) => arg.startsWith("--allowedTools")), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--effort") + 1], "low");

  const research = buildClaudeArgs({}, "sess-1", "research", false);
  assert.equal(research[research.indexOf("--resume") + 1], "sess-1");
  assert.ok(research.includes("--allowedTools=WebSearch,WebFetch"));

  const admin = buildClaudeArgs({}, null, "default", true);
  assert.ok(admin.includes("--dangerously-skip-permissions"));
  assert.equal(admin.includes("--settings"), false);
});

test("buildClaudeArgs passes Claude MCP config and allows its servers in operations modes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-mcp-"));
  const mcpPath = path.join(dir, "mcp.json");
  await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: { n8n_mcp: { command: "true" } } }));
  const args = buildClaudeArgs({ claudeMcpConfig: mcpPath }, null, "n8n", false);
  assert.equal(args[args.indexOf("--mcp-config") + 1], mcpPath);
  assert.ok(args.includes("--allowedTools=WebSearch,WebFetch,mcp__n8n_mcp"));
  assert.equal(buildClaudeArgs({ claudeMcpConfig: mcpPath }, null, "default", false).includes("--mcp-config"), false);
});

test("consumeClaudeOutput handles lines split across chunks", () => {
  const job = { usage: {} };
  const seen = [];
  const text = okLines.map((line) => JSON.stringify(line)).join("\n");
  consumeClaudeOutput(text.slice(0, 50), job, { onRateLimit: (info) => seen.push(info) });
  consumeClaudeOutput(text.slice(50), job, { onRateLimit: (info) => seen.push(info) });
  flushClaudeOutput(job, { onRateLimit: (info) => seen.push(info) });
  assert.equal(job.sessionId, "claude-sess");
  assert.deepEqual(job.claudeResult, { isError: false, text: "claude answer" });
  assert.deepEqual(job.usage, { inputTokens: 15, cachedInputTokens: 100, outputTokens: 7 });
  assert.equal(seen.length, 1);
});

test("isClaudeLimitFailure detects rejected limits, limit text and spawn failures only", () => {
  assert.equal(isClaudeLimitFailure({ claudeRateLimitRejected: true, claudeResult: { isError: true, text: "x" } }, { exitCode: 1 }), true);
  assert.equal(isClaudeLimitFailure({ claudeResult: { isError: true, text: "Claude AI usage limit reached" } }, { exitCode: 1 }), true);
  assert.equal(isClaudeLimitFailure({}, { spawnError: new Error("ENOENT") }), true);
  assert.equal(isClaudeLimitFailure({ claudeResult: { isError: true, text: "syntax error in file" } }, { exitCode: 1 }), false);
  assert.equal(isClaudeLimitFailure({ claudeRateLimitRejected: true, claudeResult: { isError: false, text: "ok" } }, { exitCode: 0 }), false);
});

test("ClaudeLimitState persists rejection and utilization-based fallback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-limits-"));
  const statePath = path.join(dir, "limits.json");
  let now = Date.parse("2026-10-21T00:00:00Z");
  const state = new ClaudeLimitState(statePath, { threshold: 0.9, now: () => now });
  await state.load();
  assert.equal(state.shouldFallback().fallback, false);
  assert.equal(state.snapshot().status, "unavailable");

  await state.record({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: now / 1000 + 3600 } } });
  assert.equal(state.shouldFallback().fallback, false);
  assert.equal(state.snapshot().fiveHour.remainingPercent, 50);

  await state.record({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.93, resetsAt: now / 1000 + 7200 });
  assert.match(state.shouldFallback().reason, /seven_day 한도 93%/);

  now += 7201 * 1000;
  assert.equal(state.shouldFallback().fallback, false);
  assert.equal(state.snapshot().weekly.usedPercent, 0);

  await state.markExhausted(null);
  const reloaded = new ClaudeLimitState(statePath, { now: () => now });
  await reloaded.load();
  assert.equal(reloaded.shouldFallback().fallback, true);
  assert.equal(Date.parse(reloaded.snapshot().exhaustedUntil), now + 60 * 60 * 1000);
  now += 60 * 60 * 1000 + 1;
  assert.equal(reloaded.shouldFallback().fallback, false);
});

test("ClaudeLimitState prefers a newer statusline rate-limit snapshot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-limits-snap-"));
  const snapshotPath = path.join(dir, "rate-limits.json");
  const now = Math.floor(Date.now() / 1000) * 1000;
  const state = new ClaudeLimitState(path.join(dir, "limits.json"), { threshold: 0.9, now: () => now, snapshotPath });
  await state.record({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.27, resetsAt: now / 1000 - 3600 } } });

  await fs.writeFile(snapshotPath, JSON.stringify({ five_hour: { used_percentage: 92, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 21, resets_at: now / 1000 + 86400 } }));
  const later = new Date(now + 60_000);
  await fs.utimes(snapshotPath, later, later);
  assert.equal(state.snapshot().fiveHour.usedPercent, 92);
  assert.equal(state.snapshot().weekly.remainingPercent, 79);
  assert.match(state.shouldFallback().reason, /five_hour 한도 92%/);

  await fs.writeFile(snapshotPath, JSON.stringify({ seven_day: { used_percentage: 22, resets_at: now / 1000 + 86400 } }));
  const idle = new Date(now + 90_000);
  await fs.utimes(snapshotPath, idle, idle);
  assert.deepEqual(state.snapshot().fiveHour, { usedPercent: 0, remainingPercent: 100, resetsAt: null, idle: true });
  assert.equal(state.shouldFallback().fallback, false);

  await fs.writeFile(snapshotPath, "not json");
  const newer = new Date(now + 120_000);
  await fs.utimes(snapshotPath, newer, newer);
  assert.equal(state.snapshot().fiveHour.idle, true);
});

test("JobManager runs Claude by default with the bridge prompt on stdin", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-job-"));
  const fakes = await makeFakes(dir, { claudeLines: okLines });
  const limits = new ClaudeLimitState(path.join(dir, "limits.json"));
  const jobs = makeManager(dir, fakes, { claudeLimits: limits });
  const { job } = await jobs.startJob({ chatId: 1, userId: 2, prompt: "안녕", workspace: { alias: "default", path: dir }, modelTier: "scheduled" });
  await job.completion;

  assert.equal(job.provider, "claude");
  assert.equal(job.status, "completed");
  assert.equal(job.summary, "claude answer");
  assert.equal(job.sessionId, "claude-sess");
  assert.equal(job.model, "sonnet");
  const call = await readCall(dir, "claude");
  assert.match(call.stdin, /User request:\n안녕/);
  assert.equal(call.argv.includes("안녕"), false);
  assert.equal(await readCall(dir, "codex"), null);
  await limits.writing;
  assert.equal(limits.snapshot().fiveHour.remainingPercent, 60);
});

test("JobManager retries on Codex when Claude rejects for rate limits, then routes directly to Codex", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-job-"));
  const fakes = await makeFakes(dir, { claudeLines: rejectedLines, claudeExit: 1 });
  const limits = new ClaudeLimitState(path.join(dir, "limits.json"));
  const jobs = makeManager(dir, fakes, { claudeLimits: limits });
  const { job } = await jobs.startJob({ chatId: 1, userId: 2, prompt: "요약", workspace: { alias: "default", path: dir }, modelTier: "scheduled" });
  await job.completion;

  assert.equal(job.provider, "codex");
  assert.equal(job.fallbackFrom, "claude");
  assert.equal(job.status, "completed");
  assert.equal(job.summary, "codex answer");
  assert.equal(job.sessionId, "codex-thread");
  assert.equal(job.model, "gpt-5.6-luna");
  const codexCall = await readCall(dir, "codex");
  assert.ok(codexCall.argv.includes("workspace-write"));
  assert.equal(codexCall.argv[codexCall.argv.indexOf("-m") + 1], "gpt-5.6-luna");
  assert.equal(Date.parse(limits.snapshot().exhaustedUntil), RESET_SECONDS * 1000);

  await fs.rm(path.join(dir, "claude-call.json"));
  const next = await jobs.startJob({ chatId: 1, userId: 2, prompt: "다음", workspace: { alias: "default", path: dir } });
  await next.job.completion;
  assert.equal(next.job.provider, "codex");
  assert.match(next.job.fallbackReason, /Claude 사용 한도 도달/);
  assert.equal(await readCall(dir, "claude"), null);
});

test("JobManager does not fall back for ordinary Claude failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-job-"));
  const fakes = await makeFakes(dir, {
    claudeLines: [{ type: "result", subtype: "error_during_execution", is_error: true, result: "tool crashed", session_id: "s" }],
    claudeExit: 1,
  });
  const jobs = makeManager(dir, fakes);
  const { job } = await jobs.startJob({ chatId: 1, userId: 2, prompt: "x", workspace: { alias: "default", path: dir } });
  await job.completion;
  assert.equal(job.provider, "claude");
  assert.equal(job.status, "failed");
  assert.equal(job.summary, "tool crashed");
  assert.equal(await readCall(dir, "codex"), null);
});

test("JobManager resumes replies with the session's provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-job-"));
  const fakes = await makeFakes(dir, { claudeLines: okLines });
  const jobs = makeManager(dir, fakes);
  const workspace = { alias: "default", path: dir };

  const legacy = await jobs.startJob({ chatId: 1, userId: 2, prompt: "a", workspace, resumeSession: { sessionId: "old-codex" } });
  await legacy.job.completion;
  assert.equal(legacy.job.provider, "codex");
  assert.deepEqual((await readCall(dir, "codex")).argv.slice(0, 2), ["exec", "resume"]);

  const claude = await jobs.startJob({ chatId: 1, userId: 2, prompt: "b", workspace, resumeSession: { sessionId: "claude-sess", provider: "claude" } });
  await claude.job.completion;
  const argv = (await readCall(dir, "claude")).argv;
  assert.equal(argv[argv.indexOf("--resume") + 1], "claude-sess");
});

test("JobManager starts a new Codex session when a Claude session is blocked by limits", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-job-"));
  const fakes = await makeFakes(dir, { claudeLines: okLines });
  const limits = new ClaudeLimitState(path.join(dir, "limits.json"));
  await limits.markExhausted(RESET_SECONDS);
  const jobs = makeManager(dir, fakes, { claudeLimits: limits });
  const { job } = await jobs.startJob({ chatId: 1, userId: 2, prompt: "c", workspace: { alias: "default", path: dir }, resumeSession: { sessionId: "claude-sess", provider: "claude" } });
  await job.completion;
  assert.equal(job.provider, "codex");
  assert.equal(job.resumeFromSessionId, null);
  assert.equal((await readCall(dir, "codex")).argv[1], "--skip-git-repo-check");
});

test("JobManager keeps n8n operations on Codex without a Claude MCP config and honors AI_PROVIDER=codex", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-job-"));
  const fakes = await makeFakes(dir, { claudeLines: okLines });
  const workspace = { alias: "default", path: dir };
  const n8n = await makeManager(dir, fakes).startJob({ chatId: 1, userId: 2, prompt: "n8n", workspace, operationMode: "n8n" });
  await n8n.job.completion;
  assert.equal(n8n.job.provider, "codex");

  const codexOnly = await makeManager(dir, fakes, { aiProvider: "codex" }).startJob({ chatId: 2, userId: 2, prompt: "x", workspace });
  await codexOnly.job.completion;
  assert.equal(codexOnly.job.provider, "codex");
  assert.equal(codexOnly.job.fallbackReason, null);
  assert.equal(await readCall(dir, "claude"), null);
});
