import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compactRepoChecks, discoverRepos, formatPublishCheck, formatRepoChecks, maybeRunDailyRepoChecks,
  repoCheckBriefingLines, runHarnessChecks, runRepoChecks, scanPublishReadiness,
} from "../src/repo-checks.js";
import { handleMessage } from "../src/router.js";
import { executeDashboardCommand } from "../src/dashboard-server.js";

// Built at runtime so this file never contains a literal token the scanner would flag.
const FAKE_ANTHROPIC = "sk-" + "ant-" + "a1B2".repeat(8);
const FAKE_SECRET_LINE = "api" + "_key = \"" + "Zq9".repeat(8) + "\"";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "repo-checks-test-"));
}

async function write(root, file, content) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

async function listTree(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out.sort();
}

test("discoverRepos lists sibling directories and skips _ and . prefixes", async () => {
  const root = await tempRoot();
  await write(root, "alpha/harness/manifest.json", "{}");
  await write(root, "beta/README.md", "x");
  await write(root, "_backup/README.md", "x");
  await write(root, ".hidden/README.md", "x");
  const repos = await discoverRepos(root);
  assert.deepEqual(repos.map((row) => [row.name, row.harness, row.git]), [["alpha", true, false], ["beta", false, false]]);
});

test("publish scan reports blockers by rule and location without storing matched text, honoring .gitignore", async () => {
  const root = await tempRoot();
  const repo = path.join(root, "app");
  await write(repo, ".gitignore", "ignored.txt\nsecret.env\n");
  await write(repo, "README.md", "# app\n");
  await write(repo, "src/config.js", `const a = 1;\nconst key = "${FAKE_ANTHROPIC}";\n${FAKE_SECRET_LINE}\nconst token = "test-token-placeholder-value";\n`);
  await write(repo, "src/paths.js", "const dir = '/home/someone/projects';\n");
  await write(repo, ".env", "X=1\n");
  await write(repo, ".env.example", "X=\n");
  await write(repo, "ignored.txt", `${FAKE_ANTHROPIC}\n`);
  await write(repo, "node_modules/pkg/index.js", `${FAKE_ANTHROPIC}\n`);
  const before = await listTree(repo);

  const result = await scanPublishReadiness({ name: "app", path: repo, git: false }, { homeDir: "/home/someone", privateTerms: ["someone@example.com"] });

  assert.deepEqual(result.blockers, [
    { rule: "env-file", file: ".env" },
    { rule: "anthropic-key", file: "src/config.js", line: 2 },
    { rule: "secret-assignment", file: "src/config.js", line: 3 },
  ]);
  assert.deepEqual(result.warnings, [
    { rule: "dependency-dir-not-ignored", file: "node_modules" },
    { rule: "home-path", file: "src/paths.js", line: 1 },
  ]);
  assert.deepEqual(result.missing, ["LICENSE"]);
  assert.doesNotMatch(JSON.stringify(result), /a1B2|Zq9/);
  const text = formatPublishCheck({ name: "app", publish: result });
  assert.match(text, /차단 · anthropic-key · src\/config\.js:2/);
  assert.doesNotMatch(text, /a1B2|Zq9/);
  assert.deepEqual(await listTree(repo), before, "scan must not create files in the repository");
});

test("harness checks parse audit, evidence validity and overdue maintenance through the CLI", async () => {
  const root = await tempRoot();
  const repo = path.join(root, "proj");
  const cli = path.join(root, "cli.js");
  await write(root, "cli.js", "");
  await write(repo, "harness/manifest.json", JSON.stringify({ paths: { reportsDir: "reports" } }));
  await write(repo, "harness/maintenance.json", JSON.stringify({ reviewedAt: "2026-08-01T00:00:00Z" }));
  await write(repo, "reports/latest/checks.json", JSON.stringify({ schemaVersion: 1, kind: "command-execution", passed: true, finishedAt: "2026-10-20T00:00:00Z" }));
  const calls = [];
  const run = async (file, args) => {
    calls.push(args.slice(1, 2)[0]);
    if (args[1] === "audit") return { code: 1, stdout: JSON.stringify({ summary: { critical: 1, warnings: 2 }, findings: [{ code: "execution-evidence-invalid" }, { code: "agent-entry-missing" }, { code: "agent-entry-missing" }] }) };
    return { code: 1, stdout: JSON.stringify({ valid: false, issues: [{ code: "source-hash-mismatch" }] }) };
  };
  const result = await runHarnessChecks({ name: "proj", path: repo }, { cli, run, now: new Date("2026-10-22T00:00:00Z") });
  assert.deepEqual(calls, ["audit", "check-evidence"]);
  assert.deepEqual(result.audit, { critical: 1, warnings: 2, codes: ["execution-evidence-invalid", "agent-entry-missing"] });
  assert.equal(result.evidence.valid, false);
  assert.deepEqual(result.evidence.issues, ["source-hash-mismatch"]);
  assert.equal(result.evidence.file, path.join("reports", "latest", "checks.json"));
  assert.equal(result.maintenance.due, true);
  const text = formatRepoChecks({ checkedAt: "2026-10-22T00:00:00Z", repos: [{ name: "proj", harness: true, harnessCheck: result, publish: { blockers: [], warnings: [], missing: [] } }] });
  assert.match(text, /audit 치명 1 · 경고 2/);
  assert.match(text, /검증 증거 무효 \(source-hash-mismatch\)/);
  assert.match(text, /유지보수 리뷰 82일 경과/);
});

test("a missing harness-lab CLI is reported as an error, not a clean result", async () => {
  const root = await tempRoot();
  await write(root, "proj/harness/manifest.json", "{}");
  await write(root, "proj/README.md", "x");
  const result = await runRepoChecks({ config: { repoCheckRoot: root, harnessLabCli: path.join(root, "missing.js") } });
  const row = result.repos[0];
  assert.match(row.harnessCheck.error, /harness-lab CLI/);
  assert.equal(compactRepoChecks(result).repos[0].issues[0], "하네스 점검 실패: harness-lab CLI를 찾을 수 없습니다.");
});

test("briefing lines show at most three flagged repos, a clean line, or nothing", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  const flagged = (name) => ({ name, publish: { blockers: [{ rule: "env-file", file: ".env" }], warnings: [], missing: [] } });
  const clean = (name) => ({ name, publish: { blockers: [], warnings: [], missing: [] } });
  assert.deepEqual(repoCheckBriefingLines(null), []);
  assert.deepEqual(repoCheckBriefingLines({ checkedAt: now.toISOString(), repos: [clean("a"), clean("b")] }, { now }), ["• 2개 저장소 이상 없음"]);
  const lines = repoCheckBriefingLines({ checkedAt: now.toISOString(), repos: ["a", "b", "c", "d"].map(flagged) }, { now });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^• a · 공개 차단 1건 \(env-file\)/);
  assert.equal(lines[3], "• 외 1개 저장소 · /repos");
  const stale = repoCheckBriefingLines({ checkedAt: "2026-10-18T00:00:00Z", repos: [clean("a")] }, { now });
  assert.match(stale.at(-1), /최신 결과가 아닙니다/);
});

test("daily repo checks run once per Seoul day after the configured hour", async () => {
  let stored = null;
  let runs = 0;
  const personalOps = { getRepoChecks: () => stored, setRepoChecks: async (value) => { stored = value; } };
  const runChecks = async ({ now }) => { runs += 1; return { checkedAt: now.toISOString(), repos: [] }; };
  const config = { repoChecksEnabled: true, repoCheckHour: 7 };
  assert.equal(await maybeRunDailyRepoChecks({ config, personalOps, runChecks, now: new Date("2026-10-21T21:30:00Z") }), null, "06:30 KST is too early");
  await maybeRunDailyRepoChecks({ config, personalOps, runChecks, now: new Date("2026-10-21T22:10:00Z") });
  await maybeRunDailyRepoChecks({ config, personalOps, runChecks, now: new Date("2026-10-22T05:00:00Z") });
  assert.equal(runs, 1);
  await maybeRunDailyRepoChecks({ config, personalOps, runChecks, now: new Date("2026-10-22T22:05:00Z") });
  assert.equal(runs, 2);
  await maybeRunDailyRepoChecks({ config: { ...config, repoChecksEnabled: false }, personalOps, runChecks, now: new Date("2026-10-24T00:00:00Z") });
  assert.equal(runs, 2);
});

test("/repos stores the result and /publish-check reports locations; neither is a dashboard command", async () => {
  const root = await tempRoot();
  await write(root, "app/README.md", "x");
  await write(root, "app/.env", "X=1\n");
  const sent = [];
  let stored = null;
  const base = {
    config: { allowedChatIds: ["1"], allowedUserIds: ["2"], repoCheckRoot: root },
    telegram: { async sendMessage(chatId, text) { sent.push(text); return { message_id: 1 }; } },
    personalOps: { setRepoChecks: async (value) => { stored = value; } },
  };
  const until = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };
  await handleMessage({ ...base, message: { chat: { id: 1 }, from: { id: 2 }, text: "/repos" } });
  assert.match(sent.at(-1), /점검하는 중입니다/, "the poll loop is not blocked by the scan");
  await until(() => sent.length >= 2);
  assert.equal(stored.repos[0].name, "app");
  assert.match(sent.at(-1), /⚠️ app/);
  assert.match(sent.at(-1), /공개 차단 1건 \(env-file\)/);
  await handleMessage({ ...base, message: { chat: { id: 1 }, from: { id: 2 }, text: "/publish-check app" } });
  await until(() => sent.length >= 3);
  assert.match(sent.at(-1), /차단 · env-file · \.env/);
  await handleMessage({ ...base, message: { chat: { id: 1 }, from: { id: 2 }, text: "/publish-check nope" } });
  await until(() => sent.length >= 4);
  assert.match(sent.at(-1), /찾을 수 없습니다: nope/);
  await assert.rejects(() => executeDashboardCommand({ command: "/repos", config: base.config }), /not available from the dashboard/);
});

test("dashboard repo-check endpoint rejects cross-origin posts and stores a same-origin run", async () => {
  const { startDashboardServer } = await import("../src/dashboard-server.js");
  const root = await tempRoot();
  await write(root, "app/README.md", "x");
  let stored = null;
  const server = startDashboardServer({
    config: { dashboardEnabled: true, dashboardHost: "127.0.0.1", dashboardPort: 0, repoCheckRoot: root, allowedChatIds: ["1"] },
    personalOps: { setRepoChecks: async (value) => { stored = value; } },
  });
  await new Promise((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rejected = await fetch(`${base}/api/repo-checks`, { method: "POST", headers: { origin: "http://evil.example" } });
    assert.equal(rejected.status, 403);
    assert.equal(stored, null);
    const accepted = await fetch(`${base}/api/repo-checks`, { method: "POST", headers: { origin: base } });
    const body = await accepted.json();
    assert.equal(body.ok, true);
    assert.equal(body.repoChecks.repos[0].name, "app");
    assert.deepEqual(body.repoChecks.repos[0].issues, ["없음: LICENSE, .gitignore"]);
    assert.equal(stored.repos[0].name, "app");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("name rules cover build directories, which are flagged when not ignored; long lines and unreadable files do not break the scan", async () => {
  const root = await tempRoot();
  const repo = path.join(root, "app");
  await write(repo, "README.md", "x");
  await write(repo, "build/.env", "X=1\n");
  await write(repo, "dist/server.pem", "x");
  await write(repo, "src/build/config.js", `${FAKE_ANTHROPIC}\n`);
  await write(repo, ".envrc", "export X=1\n");
  await write(repo, "data/blob.json", "a".repeat(200_000) + "\n");
  await write(repo, "bot.yml", "bot_token: 123456789:AA" + "b".repeat(32) + "-\n");
  await write(repo, "flow.js", "url: 'https://api.telegram.org/bot123456789:AA" + "c".repeat(33) + "/sendMessage'\n");
  await write(repo, "locked.txt", "x");
  await fs.chmod(path.join(repo, "locked.txt"), 0o000);
  const started = Date.now();
  const result = await scanPublishReadiness({ name: "app", path: repo, git: false }, { homeDir: "/home/nobody" });
  await fs.chmod(path.join(repo, "locked.txt"), 0o644);
  assert.ok(Date.now() - started < 2000, "long identifier lines must not backtrack");
  const rules = (items) => items.map((row) => `${row.rule}:${row.file}`).sort();
  assert.deepEqual(rules(result.blockers), [
    "env-file:.envrc", "env-file:build/.env", "key-file:dist/server.pem", "telegram-bot-token:bot.yml", "telegram-bot-token:flow.js",
  ]);
  assert.deepEqual(rules(result.warnings).filter((row) => !row.startsWith("unreadable")), [
    "build-dir-not-ignored:build", "build-dir-not-ignored:dist", "build-dir-not-ignored:src/build",
  ]);
  if (process.getuid?.() !== 0) assert.ok(result.warnings.some((row) => row.rule === "unreadable" && row.file === "locked.txt"));
});

test("evidence check uses harness-lab execution evidence, not a newer standalone verify bundle", async () => {
  const root = await tempRoot();
  const repo = path.join(root, "proj");
  const cli = path.join(root, "cli.js");
  await write(root, "cli.js", "");
  await write(repo, "harness/manifest.json", "{}");
  await write(repo, "out/evidence/harness-latest/checks.json", JSON.stringify({ schemaVersion: 1, kind: "command-execution", passed: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await write(repo, "out/evidence/verify-abc/checks.json", JSON.stringify({ checks: [] }));
  const checked = [];
  const run = async (file, args) => {
    if (args[1] === "audit") return { code: 0, stdout: JSON.stringify({ summary: {}, findings: [] }) };
    checked.push(args[2]);
    return { code: 0, stdout: JSON.stringify({ valid: true, issues: [] }) };
  };
  const result = await runHarnessChecks({ name: "proj", path: repo }, { cli, run });
  assert.deepEqual(checked, [path.join(repo, "out/evidence/harness-latest/checks.json")]);
  assert.equal(result.evidence.valid, true);
});

test("concurrent manual and daily runs share one in-flight run", async () => {
  const { runAndStoreRepoChecks } = await import("../src/repo-checks.js");
  let runs = 0;
  const writes = [];
  const personalOps = { getRepoChecks: () => null, setRepoChecks: async (value) => { writes.push(value); } };
  const runChecks = async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { checkedAt: new Date().toISOString(), repos: [] }; };
  const config = { repoChecksEnabled: true, repoCheckHour: 0 };
  const [manual, daily] = await Promise.all([
    runAndStoreRepoChecks({ config, personalOps, runChecks }),
    maybeRunDailyRepoChecks({ config, personalOps, runChecks }),
  ]);
  assert.equal(runs, 1);
  assert.equal(writes.length, 1);
  assert.equal(daily, null);
  assert.ok(manual);
});
