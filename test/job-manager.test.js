import test from "node:test";
import assert from "node:assert/strict";
import { JobManager, buildBridgePrompt, buildChildProcessEnv, buildCodexArgs, summarizeProcessOutput } from "../src/job-manager.js";

test("buildChildProcessEnv preserves PATH and makes env-based Node CLIs available", () => {
  const env = buildChildProcessEnv({ PATH: "/usr/bin:/bin", KEEP_ME: "yes" }, "/custom/node/bin/node", "/Users/me");

  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.PATH, "/custom/node/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin:/usr/bin:/bin");
});

test("buildBridgePrompt prevents external telegram delivery attempts", () => {
  const prompt = buildBridgePrompt("사자 이모티콘을 만들어서 텔레그램으로 보내줘");

  assert.match(prompt, /The bridge itself sends messages back to Telegram/);
  assert.match(prompt, /Do not attempt to call Telegram APIs, n8n, webhooks, MCP tools/);
  assert.match(prompt, /Do not claim that you sent anything externally/);
  assert.match(prompt, /Always respond in Korean unless the user explicitly requests another language/);
  assert.match(prompt, /format them with comma thousands separators/);
  assert.match(prompt, /User request:\n사자 이모티콘을 만들어서 텔레그램으로 보내줘/);
});

test("buildBridgePrompt enables configured tools only for explicit operations modes", () => {
  const defaultPrompt = buildBridgePrompt("inspect n8n");
  const operationsPrompt = buildBridgePrompt("inspect n8n", [], "n8n");
  assert.match(defaultPrompt, /Do not attempt to call Telegram APIs, n8n/);
  assert.match(operationsPrompt, /may use configured n8n MCP tools/);
  assert.doesNotMatch(operationsPrompt, /Do not attempt to call Telegram APIs, n8n/);
});

test("buildBridgePrompt adds body-based bullet summary guidance for article requests", () => {
  const prompt = buildBridgePrompt("뉴스 기사 요약이 제목이랑 똑같다. 목록형으로 기사 본문 주요 내용을 요약해줘");

  assert.match(prompt, /do not repeat or lightly paraphrase the title as the summary/i);
  assert.match(prompt, /Base the summary on the body content/i);
  assert.match(prompt, /respond with concise bullet points/i);
});

test("buildBridgePrompt includes saved memories as contextual input", () => {
  const prompt = buildBridgePrompt("이 설정 반영해줘", [
    { id: "mem-1", text: "최종 답변은 한국어로 간결하게 작성" },
  ]);

  assert.match(prompt, /Saved memories for this chat\/workspace:/);
  assert.match(prompt, /- mem-1: 최종 답변은 한국어로 간결하게 작성/);
  assert.match(prompt, /Use the saved memories only when they are relevant/);
});

test("buildCodexArgs includes summary output, workspace, and optional profile settings", () => {
  const args = buildCodexArgs(
    {
      codexModel: "gpt-5.4",
      codexProfile: "test-profile",
    },
    "/tmp/summary.txt",
    "update test",
    "/workspace/project",
  );

  assert.deepEqual(args.slice(0, 9), [
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--sandbox",
    "workspace-write",
    "-C",
    "/workspace/project",
    "-o",
    "/tmp/summary.txt",
  ]);
  assert.equal(args.includes("-m"), true);
  assert.equal(args.includes("gpt-5.4"), true);
  assert.equal(args.includes("-p"), true);
  assert.equal(args.includes("test-profile"), true);
  assert.match(args.at(-1), /User request:\nupdate test/);
});

test("buildCodexArgs uses resume mode for saved sessions", () => {
  const args = buildCodexArgs(
    {
      codexModel: "gpt-5.4",
      codexProfile: "ignored-on-resume",
    },
    "/tmp/summary.txt",
    "continue",
    "/workspace/project",
    "session-123",
  );

  assert.deepEqual(args.slice(0, 6), [
    "exec",
    "resume",
    "--skip-git-repo-check",
    "--json",
    "-o",
    "/tmp/summary.txt",
  ]);
  assert.equal(args.includes("session-123"), true);
  assert.equal(args.includes("-m"), true);
  assert.equal(args.includes("-p"), false);
  assert.match(args.at(-1), /User request:\ncontinue/);
});

test("buildCodexArgs supports a lightweight model and reasoning override for scheduled work", () => {
  const args = buildCodexArgs(
    { codexModel: "gpt-6-astra" },
    "/tmp/summary.txt",
    "brief",
    "/workspace/project",
    null,
    [],
    "default",
    false,
    "gpt-5.6-luna",
    "none",
  );
  assert.equal(args[args.indexOf("-m") + 1], "gpt-5.6-luna");
  assert.ok(args.includes('model_reasoning_effort="none"'));
});

test("buildCodexArgs bypasses approvals and sandbox only for unrestricted Telegram jobs", () => {
  const args = buildCodexArgs(
    {},
    "/tmp/summary.txt",
    "restart n8n",
    "/workspace/project",
    null,
    [],
    "default",
    true,
  );

  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.equal(args.includes("workspace-write"), false);
  assert.match(args.at(-1), /authorized Telegram administrator/);
  assert.doesNotMatch(args.at(-1), /Refuse destructive requests/);
});

test("summarizeProcessOutput converts security compromise json into a friendly message", () => {
  const summary = summarizeProcessOutput(
    '{"type":"SecurityCompromiseError","code":451,"message":"blocked by upstream policy"}',
    1,
  );

  assert.match(summary, /code 451/i);
  assert.doesNotMatch(summary, /SecurityCompromiseError/);
  assert.doesNotMatch(summary, /^\s*\{/);
});

test("summarizeProcessOutput prefers parsed error messages over raw json", () => {
  const summary = summarizeProcessOutput(
    '{"type":"SomeOtherError","message":"upstream model failed validation"}',
    1,
  );

  assert.equal(summary, "upstream model failed validation");
});

test("JobManager lists and filters delegated jobs", () => {
  const manager = new JobManager({});
  manager.allJobs.set("chat-1", {
    jobId: "chat-1",
    kind: "chat",
    chatId: "100",
    startedAt: "2026-06-19T00:00:00.000Z",
  });
  manager.allJobs.set("del-1", {
    jobId: "del-1",
    kind: "delegate",
    chatId: "100",
    startedAt: "2026-06-19T00:01:00.000Z",
  });

  assert.deepEqual(manager.listJobs("100", { kind: "delegate" }).map((job) => job.jobId), ["del-1"]);
});

test("JobManager enforces delegated job limits", async () => {
  const manager = new JobManager({
    maxDelegateJobsPerChat: 1,
    maxDelegateJobsTotal: 10,
  });
  manager.allJobs.set("del-1", {
    jobId: "del-1",
    kind: "delegate",
    chatId: "100",
    status: "running",
    startedAt: "2026-06-19T00:01:00.000Z",
  });

  const result = await manager.startJob({
    chatId: "100",
    userId: "200",
    prompt: "new delegated job",
    workspace: { alias: "default", path: process.cwd() },
    allowConcurrent: true,
    jobKind: "delegate",
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /for this chat/);
});
