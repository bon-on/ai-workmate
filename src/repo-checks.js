import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

// Read-only checks over the repositories next to this workspace: harness drift
// (audit, execution evidence, maintenance review) and publish readiness.
// Findings carry rule, file and line only; matched text never leaves this module.

const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", "DerivedData", "Pods"]);
const BUILD_DIRS = new Set(["dist", "build", ".next", ".build", ".gradle", "target"]);
const MAX_LINE_CHARS = 4096;
const MAX_FILES = 20_000;
const MAX_SCAN_BYTES = 1024 * 1024;
const LARGE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FINDINGS = 50;
const MAINTENANCE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const SECRET_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  // No \b: tokens are often embedded as api.telegram.org/bot<id>:<secret>.
  ["telegram-bot-token", /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/],
];
// Bounded key-name quantifiers keep matching linear on long identifier-like lines.
const SECRET_ASSIGNMENT = /(?:^|[^\w.-])[\w.-]{0,40}?(?:api[_-]?key|secret|token|passw(?:or)?d)[\w.-]{0,40}["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i;
const PLACEHOLDER = /^(?:your|example|changeme|replace|xxx|<)|test|dummy|fake|placeholder|sample|\$\{|process\.env/i;

export function runCommand(file, args, { cwd, timeoutMs = 30_000, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl(file, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error && typeof error.code !== "number" ? error.message : null,
      });
    });
  });
}

export function resolveRepoCheckConfig(config = {}) {
  const root = config.repoCheckRoot || path.dirname(process.cwd());
  return {
    root,
    cli: config.harnessLabCli || path.join(root, "harness-lab", "dist", "index.js"),
    privateTerms: config.publishCheckPrivateTerms || [],
    homeDir: config.homeDir || os.homedir(),
  };
}

export async function discoverRepos(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const repos = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || /^[._]/.test(entry.name)) continue;
    const repoPath = path.join(root, entry.name);
    repos.push({
      name: entry.name,
      path: repoPath,
      harness: await exists(path.join(repoPath, "harness", "manifest.json")),
      git: await exists(path.join(repoPath, ".git")),
    });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runHarnessChecks(repo, { cli, run = runCommand, now = new Date() }) {
  const result = { audit: null, evidence: null, maintenance: null };
  if (!await exists(cli)) {
    result.error = "harness-lab CLI를 찾을 수 없습니다.";
    return result;
  }
  const audit = await run(process.execPath, [cli, "audit", repo.path, "--format", "json"], { cwd: repo.path });
  const auditJson = parseJson(audit.stdout);
  result.audit = auditJson
    ? {
      critical: Number(auditJson.summary?.critical || 0),
      warnings: Number(auditJson.summary?.warnings || 0),
      codes: [...new Set((auditJson.findings || []).map((row) => row.code).filter(Boolean))],
    }
    : { error: summarizeError(audit) };

  const manifest = parseJson(await readText(path.join(repo.path, "harness", "manifest.json")));
  const reportsDir = path.join(repo.path, manifest?.paths?.reportsDir || "out/evidence");
  // Only harness-lab execution evidence; standalone `npm run verify` bundles use another schema.
  const evidenceFile = await newestFile(reportsDir, "checks.json", 3, async (file) => {
    const parsed = parseJson(await readText(file));
    return parsed?.kind === "command-execution" && parsed?.schemaVersion != null;
  });
  if (!evidenceFile) {
    result.evidence = { valid: false, missing: true };
  } else {
    const checked = await run(process.execPath, [cli, "check-evidence", evidenceFile, repo.path], { cwd: repo.path });
    const checkedJson = parseJson(checked.stdout);
    const evidence = parseJson(await readText(evidenceFile));
    result.evidence = checkedJson
      ? {
        valid: checkedJson.valid === true && evidence?.passed !== false,
        passed: evidence?.passed ?? null,
        issues: (checkedJson.issues || []).map(issueCode).slice(0, 5),
        finishedAt: evidence?.finishedAt || null,
        file: path.relative(repo.path, evidenceFile),
      }
      : { valid: false, error: summarizeError(checked) };
  }

  const maintenance = parseJson(await readText(path.join(repo.path, "harness", "maintenance.json")));
  const reviewedAt = maintenance?.reviewedAt || null;
  const ageDays = reviewedAt ? Math.floor((now.getTime() - Date.parse(reviewedAt)) / DAY_MS) : null;
  result.maintenance = { reviewedAt, ageDays, due: ageDays == null || !Number.isFinite(ageDays) || ageDays > MAINTENANCE_DAYS };
  return result;
}

export async function listPublishableFiles(repo, { run = runCommand } = {}) {
  if (repo.git) {
    const listed = await run("git", ["-C", repo.path, "ls-files", "-z", "-co", "--exclude-standard"], { cwd: repo.path });
    if (listed.code !== 0) throw new Error(summarizeError(listed));
    return splitZ(listed.stdout);
  }
  // A throwaway Git dir outside the repo applies .gitignore rules without creating files in it.
  const gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-check-"));
  try {
    const init = await run("git", ["init", "-q", "--bare", gitDir], { cwd: gitDir });
    if (init.code !== 0) throw new Error(summarizeError(init));
    const listed = await run("git", [`--git-dir=${gitDir}`, `--work-tree=${repo.path}`, "ls-files", "-z", "-o", "--exclude-standard"], { cwd: repo.path });
    if (listed.code !== 0) throw new Error(summarizeError(listed));
    return splitZ(listed.stdout);
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true });
  }
}

export async function scanPublishReadiness(repo, { run = runCommand, privateTerms = [], homeDir = os.homedir() } = {}) {
  const result = { files: 0, truncated: false, blockers: [], warnings: [], missing: [] };
  const files = await listPublishableFiles(repo, { run });
  const rootNames = new Set(files.filter((file) => !file.includes("/")).map((file) => file.toLowerCase()));
  if (![...rootNames].some((name) => /^readme(\.|$)/.test(name))) result.missing.push("README");
  if (![...rootNames].some((name) => /^(licen[cs]e|copying)(\.|$)/.test(name))) result.missing.push("LICENSE");
  if (!rootNames.has(".gitignore")) result.missing.push(".gitignore");

  const terms = [homeDir, ...privateTerms].map((term) => String(term || "").trim()).filter((term) => term.length >= 3);
  const reportedDirs = new Set();
  for (const [index, file] of files.entries()) {
    if (index % 200 === 199) await new Promise((resolve) => setImmediate(resolve));
    const segments = file.split("/");
    const base = segments.at(-1);
    // Name rules apply everywhere, including directories whose contents are not scanned.
    if (/^\.env(rc|\..+)?$|\.env$/.test(base) && !/\.(example|sample|template)$/.test(base)) add(result.blockers, { rule: "env-file", file });
    if (/^id_(rsa|dsa|ecdsa|ed25519)$|\.(pem|p12|pfx|key)$/i.test(base)) add(result.blockers, { rule: "key-file", file });

    const skipped = segments.slice(0, -1).find((segment) => DEPENDENCY_DIRS.has(segment) || BUILD_DIRS.has(segment));
    if (skipped) {
      const dir = segments.slice(0, segments.indexOf(skipped) + 1).join("/");
      if (!reportedDirs.has(dir)) {
        reportedDirs.add(dir);
        add(result.warnings, { rule: DEPENDENCY_DIRS.has(skipped) ? "dependency-dir-not-ignored" : "build-dir-not-ignored", file: dir });
      }
      continue;
    }
    if (result.files >= MAX_FILES) { result.truncated = true; break; }
    result.files += 1;

    let stat;
    try { stat = await fs.stat(path.join(repo.path, file)); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > LARGE_FILE_BYTES) { add(result.warnings, { rule: "large-file", file }); continue; }
    if (stat.size > MAX_SCAN_BYTES) continue;
    let buffer;
    try { buffer = await fs.readFile(path.join(repo.path, file)); }
    catch { add(result.warnings, { rule: "unreadable", file }); continue; }
    if (buffer.subarray(0, 8000).includes(0)) continue;
    scanText(buffer.toString("utf8"), file, terms, result);
  }
  return result;
}

function scanText(text, file, terms, result) {
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const at = { file, line: index + 1 };
    const secret = SECRET_RULES.find(([, pattern]) => pattern.test(line));
    if (secret) { add(result.blockers, { rule: secret[0], ...at }); continue; }
    const assignment = line.length <= MAX_LINE_CHARS ? line.match(SECRET_ASSIGNMENT) : null;
    if (assignment && !PLACEHOLDER.test(assignment[1])) { add(result.blockers, { rule: "secret-assignment", ...at }); continue; }
    if (terms[0] && line.includes(terms[0])) { add(result.warnings, { rule: "home-path", ...at }); continue; }
    if (terms.slice(1).some((term) => line.toLowerCase().includes(term.toLowerCase()))) add(result.warnings, { rule: "private-term", ...at });
  }
}

export async function runRepoChecks({ config = {}, run = runCommand, now = new Date() } = {}) {
  const settings = resolveRepoCheckConfig(config);
  const repos = [];
  for (const repo of await discoverRepos(settings.root)) {
    const row = { name: repo.name, harness: repo.harness, git: repo.git };
    if (repo.harness) {
      try { row.harnessCheck = await runHarnessChecks(repo, { cli: settings.cli, run, now }); }
      catch (error) { row.harnessCheck = { error: error.message }; }
    }
    try { row.publish = await scanPublishReadiness(repo, { run, privateTerms: settings.privateTerms, homeDir: settings.homeDir }); }
    catch (error) { row.publish = { error: error.message }; }
    repos.push(row);
  }
  return { checkedAt: now.toISOString(), root: settings.root, repos };
}

export async function runSingleRepoCheck(name, { config = {}, run = runCommand, now = new Date() } = {}) {
  const settings = resolveRepoCheckConfig(config);
  const repo = (await discoverRepos(settings.root)).find((row) => row.name === name);
  if (!repo) return null;
  return {
    name: repo.name,
    harness: repo.harness,
    git: repo.git,
    ...(repo.harness ? { harnessCheck: await runHarnessChecks(repo, { cli: settings.cli, run, now }) } : {}),
    publish: await scanPublishReadiness(repo, { run, privateTerms: settings.privateTerms, homeDir: settings.homeDir }),
  };
}

// One short Korean line per problem; an empty array means the repo is clean.
export function repoIssues(row) {
  const issues = [];
  const harness = row.harnessCheck;
  if (harness?.error) issues.push(`하네스 점검 실패: ${harness.error}`);
  if (harness?.audit?.error) issues.push(`audit 실패: ${harness.audit.error}`);
  if (harness?.audit && !harness.audit.error && (harness.audit.critical || harness.audit.warnings)) {
    issues.push(`audit 치명 ${harness.audit.critical} · 경고 ${harness.audit.warnings}${harness.audit.codes.length ? ` (${harness.audit.codes.slice(0, 3).join(", ")})` : ""}`);
  }
  if (harness?.evidence?.missing) issues.push("검증 증거 없음");
  else if (harness?.evidence && !harness.evidence.valid) {
    issues.push(`검증 증거 무효${harness.evidence.passed === false ? " (실패한 실행)" : ""}${harness.evidence.issues?.length ? ` (${harness.evidence.issues.slice(0, 2).join(", ")})` : ""}${harness.evidence.error ? `: ${harness.evidence.error}` : ""}`);
  }
  if (harness?.maintenance?.due) issues.push(harness.maintenance.reviewedAt ? `유지보수 리뷰 ${harness.maintenance.ageDays}일 경과` : "유지보수 리뷰 기록 없음");
  const publish = row.publish;
  if (publish?.error) issues.push(`공개 점검 실패: ${publish.error}`);
  if (publish?.blockers?.length) issues.push(`공개 차단 ${publish.blockers.length}건 (${countRules(publish.blockers)})`);
  if (publish?.warnings?.length) issues.push(`공개 주의 ${publish.warnings.length}건 (${countRules(publish.warnings)})`);
  if (publish?.missing?.length) issues.push(`없음: ${publish.missing.join(", ")}`);
  return issues;
}

// Dashboard payload: issue lines only, no finding locations.
export function compactRepoChecks(result) {
  if (!result?.repos) return null;
  return {
    checkedAt: result.checkedAt,
    repos: result.repos.map((row) => ({ name: row.name, harness: row.harness, git: row.git, issues: repoIssues(row) })),
  };
}

export function formatRepoChecks(result) {
  if (!result?.repos?.length) return "점검할 저장소가 없습니다.";
  const lines = [`🧰 저장소 점검 · ${seoulTime(result.checkedAt)}`];
  for (const row of result.repos) {
    const issues = repoIssues(row);
    lines.push("", `${issues.length ? "⚠️" : "✅"} ${row.name}${row.harness ? " · harness" : ""}${row.git ? " · git" : ""}`);
    lines.push(...(issues.length ? issues.map((issue) => `• ${issue}`) : ["• 이상 없음"]));
  }
  lines.push("", "자세히: /publish-check <저장소>");
  return lines.join("\n");
}

export function formatPublishCheck(row) {
  const lines = [`🔎 공개 전 점검 · ${row.name}`];
  const issues = repoIssues(row);
  lines.push(...(issues.length ? issues.map((issue) => `• ${issue}`) : ["• 이상 없음"]));
  const findings = [
    ...(row.publish?.blockers || []).map((item) => ["차단", item]),
    ...(row.publish?.warnings || []).map((item) => ["주의", item]),
  ];
  if (findings.length) {
    lines.push("", "위치 (내용은 표시하지 않음)");
    for (const [level, item] of findings.slice(0, 15)) lines.push(`• ${level} · ${item.rule} · ${item.file}${item.line ? `:${item.line}` : ""}`);
    if (findings.length > 15) lines.push(`• 외 ${findings.length - 15}건`);
  }
  if (row.publish?.truncated) lines.push(`• 파일이 많아 처음 ${MAX_FILES}개만 검사했습니다.`);
  return lines.join("\n");
}

export function repoCheckBriefingLines(result, { now = new Date() } = {}) {
  if (!result?.repos?.length) return [];
  const stale = now.getTime() - Date.parse(result.checkedAt) > 2 * DAY_MS;
  const flagged = result.repos.map((row) => [row.name, repoIssues(row)]).filter(([, issues]) => issues.length);
  const lines = flagged.length
    ? flagged.slice(0, 3).map(([name, issues]) => `• ${name} · ${issues[0]}${issues.length > 1 ? ` 외 ${issues.length - 1}건` : ""}`)
    : [`• ${result.repos.length}개 저장소 이상 없음`];
  if (flagged.length > 3) lines.push(`• 외 ${flagged.length - 3}개 저장소 · /repos`);
  if (stale) lines.push(`• 마지막 점검 ${seoulTime(result.checkedAt)} — 최신 결과가 아닙니다.`);
  return lines;
}

let inFlight = null;

// Daily, /repos and dashboard runs share one in-flight run, so results never overwrite each other.
export function runAndStoreRepoChecks({ config, personalOps, runChecks = runRepoChecks, now = new Date() }) {
  inFlight ??= (async () => {
    const result = await runChecks({ config, now });
    await personalOps?.setRepoChecks?.(result);
    return result;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

export async function maybeRunDailyRepoChecks({ config, personalOps, now = new Date(), runChecks = runRepoChecks }) {
  if (!config.repoChecksEnabled || inFlight) return null;
  if (seoulHour(now) < (config.repoCheckHour ?? 7)) return null;
  const last = personalOps.getRepoChecks?.();
  if (last && seoulDate(new Date(last.checkedAt)) === seoulDate(now)) return null;
  return runAndStoreRepoChecks({ config, personalOps, runChecks, now });
}

function add(list, item) {
  if (list.length < MAX_FINDINGS) list.push(item);
}

function countRules(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.rule, (counts.get(item.rule) || 0) + 1);
  return [...counts].map(([rule, count]) => (count > 1 ? `${rule} ${count}` : rule)).join(", ");
}

function issueCode(issue) {
  if (typeof issue === "string") return issue.slice(0, 80);
  return String(issue?.code || issue?.message || "issue").slice(0, 80);
}

async function newestFile(dir, name, depth, accept = async () => true) {
  let newest = null;
  async function walk(current, level) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && level < depth) await walk(full, level + 1);
      else if (entry.isFile() && entry.name === name && await accept(full)) {
        const { mtimeMs } = await fs.stat(full);
        if (!newest || mtimeMs > newest.mtimeMs) newest = { full, mtimeMs };
      }
    }
  }
  await walk(dir, 0);
  return newest?.full ?? null;
}

function splitZ(stdout) {
  return stdout.split("\0").filter(Boolean);
}

function summarizeError(result) {
  return String(result.error || result.stderr || result.stdout || `exit ${result.code}`).trim().split("\n")[0].slice(0, 160);
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function readText(file) {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function seoulDate(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function seoulHour(date) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(date));
}

function seoulTime(iso) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
