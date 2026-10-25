import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { listDocuments, serveDocument } from "./documents.js";
import { compactRepoChecks, runAndStoreRepoChecks, runSingleRepoCheck } from "./repo-checks.js";
import { buildDashboardSnapshot } from "./dashboard.js";
import { handleMessage, splittingTelegram } from "./router.js";
import { N8nManager } from "./n8n-manager.js";
import { TradingManager } from "./trading-manager.js";
import { PortfolioManager } from "./portfolio-manager.js";
import { buildHealthReport } from "./health.js";
import { createCodexLimitReader } from "./codex-rate-limits.js";
import {
  createEmoticonStudio, EMOTICON_CLIENT_JS, EMOTICON_CSS, EMOTICON_MAX_REQUEST_BYTES, EMOTICON_TAB_HTML,
} from "./emoticon-studio.js";

const DASHBOARD_COMMANDS = new Set([
  "/done", "/archive", "/snooze",
  "/brief", "/morning", "/evening", "/weekly-review", "/ai-trends", "/discover", "/status", "/jobs", "/n8n", "/ps", "/schedules", "/delegate", "/workspaces", "/tools", "/tr", "/health", "/inbox", "/preference", "/watches", "/lab", "/ask",
]);

export function startDashboardServer({
  config,
  telegram,
  jobs,
  processes,
  schedules,
  workspaces,
  sessions,
  memories,
  approvals,
  personalOps,
  onJobSettled = null,
  jobResults = createJobResultStore(resolveJobResultsPath(config)),
  repoCheckRunner = runSingleRepoCheck,
  emoticonStudio = config.codexWorkspace
    ? createEmoticonStudio({ config, jobs, workspaces, telegram, onJobSettled })
    : null,
}) {
  if (!config.dashboardEnabled) {
    return null;
  }
  emoticonStudio?.load?.().catch((error) => console.error("Emoticon studio load failed:", error.message));
  jobResults.load?.().catch((error) => console.error("Dashboard result store load failed:", error.message));
  const rechecking = new Set();
  const n8n = new N8nManager({ port: config.n8nPort });
  const trading = new TradingManager({ port: config.tradingDashboardPort });
  const portfolio = new PortfolioManager();
  const readCodexLimits = createCodexLimitReader({ executable: config.codexExecutable });
  let healthCache = { value: null, expiresAt: 0 };

  const server = http.createServer(async (request, response) => {
    // DNS rebinding: a foreign page can reach 127.0.0.1 under its own hostname, so the Host must be known.
    if (!isAllowedHost(request.headers.host, config)) {
      response.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
      response.end("Unknown host");
      return;
    }
    // Reads expose inbox, briefings and results too, so the tailnet-user check covers every route.
    if (!isTailnetUserAllowed(request, config)) {
      sendJson(response, { ok: false, error: "이 Tailscale 계정은 대시보드를 사용할 수 없습니다." }, 403);
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/api/document" && ["GET", "HEAD"].includes(request.method)) {
      await serveDocument(request, response, url, config);
      return;
    }
    if (url.pathname === "/api/dashboard") {
      const snapshot = buildDashboardSnapshot({
        chatId: resolveChatId(url, config),
        jobs,
        processes,
        schedules,
        workspaces,
        personalOps,
        jobResults,
      });
      snapshot.security = { tailnetUsersConfigured: tailnetUsers(config).length > 0 };
      snapshot.services = await inspectServices(config);
      snapshot.documents = await listDocuments(config);
      snapshot.codexRateLimits = await readCodexLimits();
      snapshot.claudeRateLimits = jobs.claudeLimits?.snapshot?.() ?? null;
      snapshot.repoChecks = compactRepoChecksWithAge(personalOps?.getRepoChecks?.(), rechecking);
      snapshot.emoticons = emoticonStudio?.list?.() ?? [];
      if (healthCache.expiresAt <= Date.now()) {
        healthCache = { value: await buildHealthReport(config), expiresAt: Date.now() + 60_000 };
      }
      snapshot.health = healthCache.value;
      sendJson(response, snapshot);
      return;
    }

    // Every state-changing request passes the same origin, host and tailnet-user checks.
    if (request.method === "POST" && !guardPost(request, response, config)) return;

    if (url.pathname === "/api/command" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const result = await executeDashboardCommand({
          command: body.command,
          deliverToTelegram: body.deliverToTelegram !== false,
          config, telegram, jobs, processes, schedules, workspaces, sessions, memories, approvals, personalOps,
          readCodexLimits, onJobSettled, jobResults,
        });
        sendJson(response, result);
      } catch (error) {
        sendJson(response, { ok: false, error: error.message }, 400);
      }
      return;
    }

    if (url.pathname === "/api/emoticon" && request.method === "POST") {
      try {
        if (!emoticonStudio) throw new Error("이모티콘 기능을 사용할 수 없습니다.");
        const { id } = await emoticonStudio.create(await readJsonBody(request, EMOTICON_MAX_REQUEST_BYTES));
        sendJson(response, { ok: true, id });
      } catch (error) {
        sendJson(response, { ok: false, error: error.message }, 400);
      }
      return;
    }

    if (url.pathname === "/api/job-result" && request.method === "GET") {
      const result = findJobResult(url.searchParams.get("id"), { config, jobs, jobResults });
      if (!result) sendJson(response, { ok: false, error: "작업 결과를 찾을 수 없습니다." }, 404);
      else sendJson(response, { ok: true, job: result });
      return;
    }

    if (url.pathname === "/api/schedule-action" && request.method === "POST") {
      await respondWith(response, async () => handleScheduleAction(await readJsonBody(request), { config, schedules }));
      return;
    }

    if (url.pathname === "/api/usage-pause" && request.method === "POST") {
      await respondWith(response, async () => handleUsagePause(await readJsonBody(request), { schedules }));
      return;
    }

    if (url.pathname === "/api/briefing-feedback" && request.method === "POST") {
      await respondWith(response, async () => handleBriefingFeedback(await readJsonBody(request), { config, personalOps }));
      return;
    }

    if (url.pathname === "/api/briefing-resend" && request.method === "POST") {
      await respondWith(response, async () => handleBriefingResend(await readJsonBody(request), { config, telegram, personalOps }));
      return;
    }

    if (url.pathname === "/api/repo-check" && request.method === "POST") {
      await respondWith(response, async () => {
        const { done: _done, ...result } = startRepoRecheck(await readJsonBody(request), { config, personalOps, rechecking, repoCheckRunner });
        return result;
      });
      return;
    }

    if (url.pathname === "/api/repo-checks" && request.method === "POST") {
      try {
        const result = await runAndStoreRepoChecks({ config, personalOps });
        sendJson(response, { ok: true, repoChecks: compactRepoChecks(result) });
      } catch (error) { sendJson(response, { ok: false, error: error.message }, 500); }
      return;
    }

    if (url.pathname === "/api/n8n/workflows" && request.method === "GET") {
      try { sendJson(response, { ok: true, ...await n8n.overview() }); }
      catch (error) { sendJson(response, { ok: false, error: error.message }, 502); }
      return;
    }

    if (url.pathname === "/api/trading" && request.method === "GET") {
      try { sendJson(response, { ok: true, trading: await trading.overview() }); }
      catch (error) { sendJson(response, { ok: false, error: error.message }, 502); }
      return;
    }

    if (url.pathname === "/api/portfolio" && request.method === "GET") {
      try { sendJson(response, { ok: true, portfolio: await portfolio.overview() }); }
      catch (error) { sendJson(response, { ok: false, error: error.message }, 502); }
      return;
    }

    const executionDetails = url.pathname.match(/^\/api\/n8n\/executions\/(\d+)$/);
    if (executionDetails && request.method === "GET") {
      try { sendJson(response, { ok: true, execution: await n8n.failureDetails(executionDetails[1]) }); }
      catch (error) { sendJson(response, { ok: false, error: error.message }, 502); }
      return;
    }
    const retryExecution = url.pathname.match(/^\/api\/n8n\/executions\/(\d+)\/retry$/);
    if (retryExecution && request.method === "POST") {
      try { sendJson(response, { ok: true, execution: await n8n.retryExecution(retryExecution[1]) }); }
      catch (error) { sendJson(response, { ok: false, error: error.message }, 502); }
      return;
    }

    const workflowAction = url.pathname.match(/^\/api\/n8n\/workflows\/([A-Za-z0-9_-]+)\/(publish|unpublish)$/);
    if (workflowAction && request.method === "POST") {
      try {
        const workflow = await n8n.setPublished(workflowAction[1], workflowAction[2] === "publish");
        sendJson(response, { ok: true, workflow });
      } catch (error) { sendJson(response, { ok: false, error: error.message }, 502); }
      return;
    }

    if (url.pathname === "/api/emoticon-file" && request.method === "GET") {
      await serveEmoticonFile(response, emoticonStudio?.resolveFile?.(url.searchParams.get("id"), url.searchParams.get("path")));
      return;
    }

    if (url.pathname === "/assets/markdown-render.js" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(await fs.readFile(new URL("./markdown-render.js", import.meta.url)));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      sendHtml(response, renderDashboardHtml(config));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    const address = server.address();
    console.log(`AI Workmate dashboard: http://${config.dashboardHost}:${address.port}/`);
  });
  return server;
}

export async function executeDashboardCommand({
  command, config, telegram, jobs, processes, schedules, workspaces, sessions, memories, approvals, personalOps,
  readCodexLimits = null, onJobSettled = null, jobResults = null, deliverToTelegram = true,
}) {
  const text = String(command ?? "").trim();
  const name = text.split(/\s+/, 1)[0].toLowerCase();
  if (!DASHBOARD_COMMANDS.has(name)) {
    throw new Error("This command is not available from the dashboard.");
  }
  if (name === "/n8n" && text === "/n8n") {
    throw new Error("n8n 요청 내용을 입력하세요.");
  }

  const chatId = config.allowedChatIds[0] ?? "dashboard";
  const userId = config.allowedUserIds[0] ?? "dashboard";
  const messages = [];
  const approverId = config.allowedUserIds[0];
  async function sendDashboardMessage(_chatId, message, extra = {}) {
    // Approval buttons only work in Telegram, so they are forwarded there instead of being dropped.
    if (extra?.reply_markup) {
      if (approverId && config.allowedChatIds[0]) {
        await telegram.sendMessage(chatId, message, extra);
        messages.push(`${message}\n\n→ 승인 버튼을 텔레그램으로 보냈습니다. 텔레그램에서 승인하세요.`);
      } else {
        messages.push(`${message}\n\n→ 승인이 필요한 요청입니다. ALLOWED_USER_IDS가 없어 대시보드 요청은 승인할 수 없으니 텔레그램에서 직접 요청하세요.`);
      }
      return { message_id: null };
    }
    messages.push(String(message));
    return { message_id: null };
  }
  // A Proxy keeps the Telegram client's prototype methods (sendDocument, ...) bound to the real instance.
  const dashboardTelegram = new Proxy(telegram ?? {}, {
    get(target, property) {
      if (property === "sendMessage") return sendDashboardMessage;
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const routedText = name === "/ask" ? text.slice(4).trim() : text;
  if (!routedText) throw new Error("요청 내용을 입력하세요.");
  // "/ask" is for natural-language requests; a command after it would bypass DASHBOARD_COMMANDS.
  if (name === "/ask" && routedText.startsWith("/")) throw new Error("This command is not available from the dashboard.");
  await handleMessage({
    message: { chat: { id: chatId }, from: { id: userId }, text: routedText },
    requestSource: "dashboard",
    config,
    telegram: dashboardTelegram,
    jobs,
    workspaces,
    processes,
    sessions,
    memories,
    schedules,
    approvals,
    personalOps,
    onJobSettled: async (job) => {
      if (!job) return;
      // The bridge's settleJob records metrics, sessions and schedule results; Telegram delivery is opt-out per request.
      if (deliverToTelegram === false) job.deliverToTelegram = false;
      try {
        if (onJobSettled) await onJobSettled(job);
      } finally {
        if (job.summary) messages.push(String(job.summary));
        if (job.summary && jobResults?.record) {
          await jobResults.record(job).catch((error) => console.error("Dashboard result persistence failed:", error.message));
        }
      }
    },
    readCodexLimits,
  });
  const activeJob = jobs.getActiveJob?.(chatId);
  return { ok: true, messages, jobId: ["/done", "/archive", "/snooze", "/inbox", "/lab"].includes(name) ? null : activeJob?.jobId ?? null };
}

function guardPost(request, response, config) {
  if (!isSameOrigin(request, config)) {
    sendJson(response, { ok: false, error: "Cross-origin request rejected." }, 403);
    return false;
  }
  if (!isTailnetUserAllowed(request, config)) {
    sendJson(response, { ok: false, error: "이 Tailscale 계정은 대시보드 명령을 실행할 수 없습니다." }, 403);
    return false;
  }
  return true;
}

function tailnetUsers(config = {}) {
  return (config.dashboardTailnetUsers || []).map((row) => String(row).trim().toLowerCase()).filter(Boolean);
}

// With DASHBOARD_TAILNET_USERS set, a request through a MagicDNS name must come from a listed Tailscale login.
// tailscale serve sets Tailscale-User-Login itself and strips a client-supplied copy.
export function isTailnetUserAllowed(request, config = {}) {
  const users = tailnetUsers(config);
  if (!users.length) return true;
  let hostname;
  try {
    hostname = new URL(`http://${request.headers.host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  // The Host is client-controlled, so any sign of the tailscale serve proxy also requires a listed login.
  const headers = request.headers;
  const remote = String(request.socket?.remoteAddress || "127.0.0.1").replace(/^::ffff:/, "");
  const proxied = hostname.endsWith(".ts.net")
    || !["127.0.0.1", "::1"].includes(remote)
    || ["tailscale-user-login", "tailscale-user-name", "x-forwarded-for", "x-forwarded-host"].some((name) => headers[name] !== undefined);
  if (!proxied) return true;
  const login = String(request.headers["tailscale-user-login"] || "").trim().toLowerCase();
  return Boolean(login) && users.includes(login);
}

async function respondWith(response, handler) {
  try {
    const { status = 200, ...body } = await handler();
    sendJson(response, body, status);
  } catch (error) {
    sendJson(response, { ok: false, error: error.message }, 400);
  }
}

function dashboardChatId(config) {
  return String(config.allowedChatIds?.[0] ?? "dashboard");
}

const SCHEDULE_ACTIONS = {
  run: { method: "runNow", message: "곧 실행됩니다." },
  skip: { method: "skipNext", message: "다음 실행을 한 번 건너뜁니다." },
  remove: { method: "remove", message: "예약 작업을 삭제했습니다." },
};

export async function handleScheduleAction(body, { config, schedules, now = new Date() }) {
  const id = String(body?.id ?? "").trim();
  const action = SCHEDULE_ACTIONS[body?.action];
  if (!id || !action || !Object.hasOwn(SCHEDULE_ACTIONS, body.action)) return { status: 400, ok: false, error: "id와 action(run, skip, remove)이 필요합니다." };
  if (typeof schedules?.[action.method] !== "function") return { status: 501, ok: false, error: "이 작업을 지원하지 않습니다." };
  const chatId = dashboardChatId(config);
  const result = action.method === "remove"
    ? await schedules.remove({ chatId, id })
    : await schedules[action.method](id, { chatId, now });
  if (!result) return { status: 404, ok: false, error: "예약 작업을 찾을 수 없습니다." };
  if (result.removed) return { ok: true, action: body.action, message: "한 번만 실행되는 예약이라 삭제했습니다." };
  const paused = body.action === "run" && schedules.getUsagePause?.(now);
  return { ok: true, action: body.action, message: paused ? `${action.message} AI가 필요한 작업은 일시정지가 풀린 뒤 실행됩니다.` : action.message };
}

export async function handleUsagePause(body, { schedules }) {
  if (body?.action !== "clear") return { status: 400, ok: false, error: "action은 clear만 지원합니다." };
  if (typeof schedules?.clearUsagePause !== "function") return { status: 501, ok: false, error: "일시 중지 해제를 지원하지 않습니다." };
  await schedules.clearUsagePause();
  return { ok: true, message: "AI 예약 작업을 다시 실행합니다." };
}

const BRIEFING_FEEDBACK = { up: "interest", down: "skip", interest: "interest", skip: "skip", done: "done" };

export async function handleBriefingFeedback(body, { config, personalOps }) {
  const id = String(body?.id ?? "").trim();
  const feedback = Object.hasOwn(BRIEFING_FEEDBACK, body?.feedback) ? BRIEFING_FEEDBACK[body.feedback] : null;
  if (!id || !feedback) return { status: 400, ok: false, error: "id와 feedback(up, down)이 필요합니다." };
  if (typeof personalOps?.setBriefingFeedback !== "function") return { status: 501, ok: false, error: "피드백 저장을 지원하지 않습니다." };
  const entry = await personalOps.setBriefingFeedback({ chatId: dashboardChatId(config), id, feedback });
  if (!entry) return { status: 404, ok: false, error: "브리핑을 찾을 수 없습니다." };
  return { ok: true, feedback };
}

export async function handleBriefingResend(body, { config, telegram, personalOps, now = new Date() }) {
  const id = String(body?.id ?? "").trim();
  if (!id) return { status: 400, ok: false, error: "id가 필요합니다." };
  const chatId = config.allowedChatIds?.[0];
  if (!chatId || typeof telegram?.sendMessage !== "function") return { status: 400, ok: false, error: "텔레그램 채팅이 설정되지 않았습니다." };
  const entry = (personalOps?.listBriefingHistory?.(chatId, { days: 30, limit: 200, now }) ?? []).find((row) => row.id === id);
  if (!entry?.text) return { status: 404, ok: false, error: "브리핑을 찾을 수 없습니다." };
  await splittingTelegram(telegram).sendMessage(chatId, entry.text);
  return { ok: true, message: "텔레그램으로 다시 보냈습니다." };
}

// Runs one repository check in the background and merges it into the stored result.
export function startRepoRecheck(body, { config, personalOps, rechecking, repoCheckRunner = runSingleRepoCheck, now = () => new Date() }) {
  const name = String(body?.name ?? "").trim();
  const stored = personalOps?.getRepoChecks?.();
  if (!name || !stored?.repos?.some((row) => row.name === name)) return { status: 404, ok: false, error: "점검 기록에 없는 저장소입니다." };
  if (rechecking.has(name)) return { status: 202, ok: true, running: true };
  rechecking.add(name);
  const done = (async () => {
    try {
      const startedAt = now();
      const fresh = await repoCheckRunner(name, { config, now: startedAt });
      const latest = personalOps.getRepoChecks?.();
      if (!fresh || !latest?.repos) return;
      const row = { ...fresh, checkedAt: startedAt.toISOString() };
      await personalOps.setRepoChecks({ ...latest, repos: latest.repos.map((entry) => entry.name === name ? row : entry) });
    } catch (error) {
      console.error(`Repository recheck failed (${name}):`, error.message);
    } finally {
      rechecking.delete(name);
    }
  })();
  return { status: 202, ok: true, started: true, done };
}

export function compactRepoChecksWithAge(result, rechecking = new Set()) {
  const compact = compactRepoChecks(result);
  if (!compact) return null;
  compact.repos = compact.repos.map((row, index) => ({
    ...row,
    checkedAt: result.repos[index]?.checkedAt || result.checkedAt,
    rechecking: rechecking.has(row.name),
  }));
  return compact;
}

function isFinishedStatus(status) {
  return !["queued", "running"].includes(status);
}

export function findJobResult(rawId, { config, jobs, jobResults }) {
  const id = String(rawId ?? "");
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(id)) return null;
  const chatId = dashboardChatId(config);
  const live = jobs?.getJob?.(chatId, id);
  if (live && isFinishedStatus(live.status) && live.summary) return jobResultRecord(live);
  const stored = jobResults?.get?.(id);
  return stored && stored.chatId === chatId ? stored : null;
}

function jobResultRecord(job, maxChars = 30_000) {
  return {
    jobId: String(job.jobId),
    chatId: String(job.chatId),
    kind: job.kind || "chat",
    status: job.status,
    provider: job.provider ?? null,
    model: job.model ?? null,
    prompt: String(job.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    summary: String(job.summary ?? "").slice(0, maxChars),
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? new Date().toISOString(),
  };
}

function resolveJobResultsPath(config = {}) {
  if (config.dashboardResultsPath) return config.dashboardResultsPath;
  if (config.personalOpsStatePath) return path.join(path.dirname(config.personalOpsStatePath), "ai-workmate-dashboard-results.json");
  return null;
}

// Full results of dashboard requests, kept so they stay viewable after a refresh or bridge restart.
export function createJobResultStore(filePath, { limit = 100 } = {}) {
  const entries = new Map();
  let loaded = null;
  let queue = Promise.resolve();
  async function save() {
    if (!filePath) return;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, results: [...entries.values()] }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  }
  const store = {
    load() {
      loaded ??= (async () => {
        if (!filePath) return;
        try {
          const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
          for (const row of parsed.results || []) {
            if (row?.jobId && !entries.has(String(row.jobId))) entries.set(String(row.jobId), row);
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      })();
      return loaded;
    },
    get(id) {
      return entries.get(String(id)) ?? null;
    },
    async record(job) {
      // Saving before the file is read would drop older results.
      await store.load().catch(() => {});
      const row = jobResultRecord(job);
      entries.set(row.jobId, row);
      const ordered = [...entries.values()].sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
      for (const old of ordered.slice(limit)) entries.delete(old.jobId);
      queue = queue.catch(() => {}).then(save);
      await queue;
      return row;
    },
  };
  return store;
}

function isSameOrigin(request, config = {}) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.host && isAllowedHost(request.headers.host, config);
  } catch {
    return false;
  }
}

// Loopback names, Tailscale MagicDNS names (tailscale serve) and DASHBOARD_ALLOWED_HOSTS.
export function isAllowedHost(hostHeader, config = {}) {
  if (!hostHeader) return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return true;
  // MagicDNS names are managed by Tailscale and cannot be rebound to this machine's loopback.
  if (hostname.endsWith(".ts.net")) return true;
  return (config.dashboardAllowedHosts ?? []).includes(hostname);
}

function readJsonBody(request, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) request.destroy(new Error("Request is too large."));
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid JSON.")); }
    });
    request.on("error", reject);
  });
}

async function inspectServices(config) {
  const definitions = [
    { id: "ai-workmate", name: "AI Workmate", port: config.dashboardPort, description: "작업, 일정, 프로세스와 Mac 상태" },
    { id: "trading", name: "Trading", port: config.tradingDashboardPort ?? 8000, description: "트레이딩 대시보드" },
    { id: "n8n", name: "n8n", port: config.n8nPort ?? 5678, description: "워크플로우 편집 및 실행 관리" },
  ];
  return Promise.all(definitions.map(async (service) => ({
    ...service,
    status: await canConnect(service.port) ? "online" : "offline",
  })));
}

function canConnect(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function resolveChatId(url, config) {
  return url.searchParams.get("chatId") || config.allowedChatIds[0] || "default";
}

const EMOTICON_CONTENT_TYPES = { ".png": "image/png", ".webp": "image/webp", ".zip": "application/zip", ".txt": "text/plain; charset=utf-8" };

async function serveEmoticonFile(response, filePath) {
  let data = null;
  try {
    if (filePath) data = await fs.readFile(filePath);
  } catch {
    data = null;
  }
  if (!data) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  const headers = { "content-type": EMOTICON_CONTENT_TYPES[extension] || "application/octet-stream", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" };
  if (extension === ".zip") headers["content-disposition"] = `attachment; filename="${path.basename(filePath)}"`;
  response.writeHead(200, headers);
  response.end(data);
}

function sendJson(response, data, statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

export function renderDashboardHtml(config) {
  const chatId = escapeHtml(config.allowedChatIds[0] || "");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Workmate 대시보드</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #18202a;
      --muted: #657083;
      --line: #d9dee7;
      --accent: #167a72;
      --warn: #b45f06;
      --bad: #b3261e;
      --ok: #257942;
      --idle: #5b6575;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .wrap { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; }
    .topbar {
      min-height: 70px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0; }
    .codex-limit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 0 12px; }
    .codex-limit-card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
    .codex-limit-card h3 { margin: 0 0 4px; font-size: 13px; }
    .codex-limit-value { font-size: 18px; font-weight: 700; line-height: 1.3; color: var(--accent); }
    .codex-limit-card.low .codex-limit-value { color: var(--warn); }
    .codex-limit-card.depleted .codex-limit-value { color: var(--bad); }
    .codex-limit-card progress { display: block; width: 100%; height: 6px; margin: 6px 0; accent-color: var(--accent); }
    .codex-limit-card.low progress { accent-color: var(--warn); }
    .codex-limit-card.depleted progress { accent-color: var(--bad); }
    .codex-limit-updated { padding: 6px 12px; }
    @media (max-width: 600px) { .codex-limit-grid { grid-template-columns: 1fr; } }
    .meta { color: var(--muted); font-size: 13px; }
    main { padding: 22px 0 34px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric, .section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 14px 16px; min-height: 86px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .value { margin-top: 8px; font-size: 20px; font-weight: 700; overflow-wrap: anywhere; }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(320px, .65fr);
      gap: 14px;
    }
    .section { overflow: hidden; }
    .section h2 {
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 14px;
      letter-spacing: 0;
    }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid #edf0f4;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th { color: var(--muted); font-size: 12px; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .stack { display: grid; gap: 14px; }
    .empty { padding: 16px; color: var(--muted); }
    .pill {
      display: inline-block;
      min-width: 72px;
      padding: 3px 8px;
      border-radius: 999px;
      background: #eef2f5;
      color: var(--idle);
      font-size: 12px;
      text-align: center;
      white-space: nowrap;
    }
    .running, .queued { background: #e9f6f4; color: var(--accent); }
    .completed, .exited { background: #eaf5ee; color: var(--ok); }
    .failed, .cancelled { background: #fdecea; color: var(--bad); }
    .stopping { background: #fff4e4; color: var(--warn); }
    .prompt { color: var(--muted); }
    .service-grid, .command-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; padding: 12px; }
    .service-card, .command-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; color: inherit; text-decoration: none; }
    .service-card:hover { border-color: var(--accent); }
    .service-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 700; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); display: inline-block; }
    .dot.online { background: var(--ok); }
    .command-card code { display: block; margin-bottom: 5px; color: var(--accent); font-weight: 700; }
    button.command-card { background: var(--panel); text-align: left; font: inherit; cursor: pointer; }
    button.command-card:hover { border-color: var(--accent); }
    .command-output { margin: 0 12px 12px; padding: 12px; min-height: 54px; white-space: pre-wrap; background: #f2f5f7; border-radius: 8px; overflow-wrap: anywhere; }
    .system-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; padding: 14px; }
    .workflow-list { padding: 0 12px 12px; }
    .workflow-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid #edf0f4; }
    .workflow-row:last-child { border-bottom: 0; }
    .action { border: 1px solid var(--line); background: white; border-radius: 7px; padding: 7px 10px; cursor: pointer; }
    .action.publish { color: var(--ok); border-color: #9dcbaa; }
    .action.unpublish { color: var(--bad); border-color: #e2aaa6; }
    .execution-list { padding: 0 12px 12px; }
    .hero-grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 14px; margin-bottom: 14px; }
    .attention-list { padding: 12px; display: grid; gap: 8px; }
    .attention { padding: 10px 12px; border-radius: 8px; background: #fff4e4; color: #7c4608; border: 1px solid #f1cf9b; }
    .attention.good { background: #eaf5ee; color: var(--ok); border-color: #b6d9c1; }
    .today-grid, .trading-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 12px; }
    .mini { border: 1px solid var(--line); border-radius: 8px; padding: 10px; min-width: 0; }
    .mini strong { display: block; font-size: 18px; margin-top: 4px; overflow-wrap: anywhere; }
    button.mini { font: inherit; color: inherit; text-align: left; background: var(--panel); cursor: pointer; }
    button.mini.selected { border-color: var(--accent); background: #e9f6f4; }
    button.mini .hint { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
    .portfolio-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 12px; }
    .portfolio-table { width: 100%; border-collapse: collapse; }
    .portfolio-table th, .portfolio-table td { padding: 10px 12px; border-top: 1px solid var(--line); text-align: right; white-space: nowrap; }
    .portfolio-table th:first-child, .portfolio-table td:first-child { text-align: left; }
    .portfolio-table th { color: var(--muted); font-size: 12px; }
    .portfolio-table td::before { display: none; }
    .positive { color: var(--bad); }
    .negative { color: #2563a5; }
    .table-scroll { overflow-x: auto; }
    .ask-form { display: flex; gap: 8px; padding: 12px; }
    .ask-form textarea { flex: 1; min-height: 72px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 10px; font: inherit; }
    .ask-form button { align-self: center; cursor: pointer; }
    .tabs { position: sticky; top: 0; z-index: 10; display: flex; gap: 6px; padding: 10px 0; background: var(--bg); overflow-x: auto; }
    .tab { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 8px 14px; white-space: nowrap; cursor: pointer; }
    .tab.active { border-color: var(--accent); background: #e9f6f4; color: var(--accent); font-weight: 700; }
    .tab-panel[hidden], .command-output[hidden] { display: none; }
    .quick-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; }
    .quick-actions button { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 9px 12px; cursor: pointer; }
    .quick-actions button:hover { border-color: var(--accent); color: var(--accent); }
    .simple-list { display: grid; gap: 0; }
    .simple-row { padding: 11px 14px; border-bottom: 1px solid #edf0f4; }
    .simple-row:last-child { border-bottom: 0; }
    .lab-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
    .lab-actions button { min-height:44px; border:1px solid var(--line); background:white; border-radius:7px; padding:10px 14px; font:inherit; cursor:pointer; }
    .lab-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:12px 14px; border-bottom:1px solid var(--line); }
    .lab-header h2 { padding:0; border-bottom:0; }
    .lab-header .action { min-height:44px; padding:10px 14px; font:inherit; }
    .lab-description { margin:0; padding:14px; color:var(--muted); line-height:1.6; }
    .doc-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .doc-actions .doc-link, .lab-actions .doc-link { min-height: 40px; padding: 8px 16px; border: 0; border-radius: 7px; background: var(--accent); color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .doc-actions a { min-height: 40px; display: inline-flex; align-items: center; padding: 8px 12px; border: 1px solid var(--line); border-radius: 7px; background: white; color: var(--text); text-decoration: none; }
    .doc-file { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
    .doc-viewer { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: center; background: rgba(15, 23, 32, 0.45); }
    .doc-viewer[hidden] { display: none; }
    .doc-viewer-panel { display: flex; flex-direction: column; width: min(880px, 100%); height: 100%; background: var(--panel); }
    .doc-viewer-bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); padding-top: max(10px, env(safe-area-inset-top)); }
    .doc-viewer-bar strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .doc-viewer-bar .action { min-height: 40px; text-decoration: none; color: var(--text); display: inline-flex; align-items: center; }
    .doc-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 16px 18px 40px; font-size: 16px; line-height: 1.7; overflow-wrap: anywhere; }
    .doc-body h1 { font-size: 22px; } .doc-body h2 { font-size: 19px; margin-top: 24px; } .doc-body h3 { font-size: 17px; }
    .doc-body pre { overflow-x: auto; padding: 10px; background: #f2f5f7; border-radius: 7px; font-size: 13px; line-height: 1.5; }
    .doc-body code { background: #f2f5f7; border-radius: 4px; padding: 1px 4px; font-size: 0.9em; }
    .doc-body pre code { padding: 0; background: none; }
    .doc-body blockquote { margin: 12px 0; padding: 2px 12px; border-left: 3px solid var(--line); color: var(--muted); }
    .doc-body ul, .doc-body ol { padding-left: 22px; } .doc-body li.md-nested { margin-left: 18px; }
    .doc-body .md-table { overflow-x: auto; } .doc-body table { border-collapse: collapse; font-size: 14px; } .doc-body th, .doc-body td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
    .doc-body a { color: var(--accent); }
    @media (min-width: 821px) { .doc-viewer-panel { margin: 24px 0; height: calc(100% - 48px); border-radius: 10px; overflow: hidden; } }
    .briefing-full { max-height: 60vh; }
    .lab-actions button[aria-pressed="true"] { border-color: var(--accent); background: #e9f6f4; color: var(--accent); }
    .overdue { color: var(--bad); font-weight: 700; }
    .doc-viewer-bar .action[hidden] { display: none; }
    .lab-result { margin-top:8px; padding:9px; background:#f2f5f7; border-radius:7px; white-space:pre-wrap; max-height:220px; overflow:auto; }
    .inline-form { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; padding: 12px; }
    .inline-form input, .inline-form select { min-width: 0; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; background: white; }
    .ask-form button, .inline-form button { border: 0; border-radius: 8px; padding: 9px 14px; background: var(--accent); color: white; font-weight: 700; }
    .last-updated { text-align: right; padding: 8px 0 14px; color: var(--muted); font-size: 12px; }
    .dashboard-title { display: flex; align-items: end; justify-content: space-between; gap: 12px; padding-top: 24px; }
    .dashboard-title h1 { font-size: 24px; }
    .dashboard-title p { margin: 4px 0 0; color: var(--muted); }
    @media (max-width: 820px) {
      .topbar { align-items: flex-start; flex-direction: column; padding: 16px 0; }
      .metrics, .grid, .hero-grid, .service-grid, .command-grid, .system-list { grid-template-columns: 1fr; }
      .today-grid, .trading-grid, .portfolio-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ask-form { flex-direction: column; }
      .ask-form button { align-self: stretch; }
      .lab-header { align-items:stretch; flex-direction:column; }
      .inline-form { grid-template-columns: 1fr; }
      .portfolio-table, .portfolio-table tbody, .portfolio-table tr, .portfolio-table td { display: block; width: 100%; }
      .portfolio-table thead { display: none; }
      .portfolio-table { border-collapse: separate; padding: 0 12px 12px; }
      .portfolio-table tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 8px; margin-top: 10px; overflow: hidden; }
      .portfolio-table td { box-sizing: border-box; min-width: 0; padding: 10px 12px; border: 0; border-top: 1px solid var(--line); text-align: right; white-space: normal; overflow-wrap: anywhere; }
      .portfolio-table td:first-child { grid-column: 1 / -1; border-top: 0; text-align: left; background: #f7f9fa; }
      .portfolio-table td::before { content: attr(data-label); display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 400; }
      .portfolio-table td:first-child::before { display: none; }
    }
${EMOTICON_CSS}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="dashboard-title"><div><h1>AI Workmate</h1><p>오늘의 선택과 자동화를 한곳에서 관리합니다.</p></div></div>
    <nav class="tabs" aria-label="대시보드 화면">
      <button class="tab active" data-tab="today">오늘</button><button class="tab" data-tab="lab">AI 실험실</button><button class="tab" data-tab="automation">자동화</button><button class="tab" data-tab="emoticon">이모티콘</button><button class="tab" data-tab="trading">트레이딩</button><button class="tab" data-tab="system">시스템</button><button class="tab" data-tab="settings">설정</button>
    </nav>
    <div id="lastUpdated" class="last-updated">불러오는 중…</div>

    <div class="tab-panel" data-panel="today">
      <section id="statusLine" class="section" style="margin-bottom:14px" hidden><h2>확인 필요</h2><div id="statusItems" class="attention-list"></div></section>
      <section class="section" style="margin-bottom:14px"><h2>AI Workmate에게 요청</h2><form id="askForm"><div class="ask-form"><textarea id="askInput" aria-label="AI Workmate에게 요청할 내용" placeholder="질문이나 작업을 요청하세요. 예: 로컬 LLM 평가 방법을 조사해줘"></textarea><button id="askSubmit" type="submit">실행</button></div><label style="display:block;padding:0 12px 6px"><input id="askTelegram" type="checkbox" checked> 텔레그램으로도 받기</label><label style="display:block;padding:0 12px 12px"><input id="askResearch" type="checkbox"> 조사 보고서로 남기기</label><p class="meta" style="padding:0 12px">선택하면 조사 결과를 AI 실험실에 기록하고 실습·구현·추가 조사로 이어갈 수 있습니다.</p></form><pre id="askOutput" class="command-output" aria-live="polite" hidden>요청 결과가 여기에 표시됩니다.</pre></section>
      <section class="hero-grid"><div class="section"><h2>결과와 결정</h2><div id="attention" class="attention-list"><div class="empty">불러오는 중…</div></div></div><div class="section"><h2>오늘</h2><div id="today" class="today-grid"><div class="empty">불러오는 중…</div></div></div></section>
      <section class="section" style="margin-bottom:14px"><h2>할 일 · Inbox</h2><form id="inboxForm" class="inline-form"><select id="inboxType" aria-label="기록 종류"><option value="task">할 일</option><option value="idea">아이디어</option><option value="read">읽기</option></select><input id="inboxText" aria-label="할 일 내용" placeholder="빠르게 기록할 내용"><button>추가</button></form><pre id="quickOutput" class="command-output" hidden>Inbox 처리 결과가 여기에 표시됩니다.</pre><div id="inbox" class="simple-list"></div></section>
      <section class="grid"><div class="section"><h2>최근 브리핑</h2><div id="briefings" class="simple-list"></div></div><div class="section"><h2>다음 일정</h2><div id="nextSchedules"></div></div></section>
      <section class="grid" style="margin-top:14px"><div class="section"><h2>Claude 사용 한도</h2><div id="claudeLimits" aria-live="polite"><div class="empty">불러오는 중…</div></div></div><div class="section"><h2>Codex 사용 한도 · 폴백</h2><div id="codexLimits" aria-live="polite"><div class="empty">불러오는 중…</div></div></div></section>
    </div>

    <div class="tab-panel" data-panel="lab" hidden>
      <section class="section" style="margin-bottom:14px"><h2>문서함</h2><p class="lab-description">보고서와 작성한 문서를 열거나 다운로드하세요.</p><div id="documents" class="simple-list"></div></section>
      <section class="section" style="margin-bottom:14px"><div class="lab-header"><h2>조사 보고서와 후속 작업</h2><button id="newResearch" class="action" type="button">새 조사 요청</button></div><p class="lab-description">보고서를 읽고 실습·구현·추가 조사로 이어가세요. 새 요청은 오늘 화면의 요청창을 이용합니다.</p><pre id="labOutput" class="command-output" hidden>후속 작업 처리 결과가 여기에 표시됩니다.</pre></section>
      <section class="section"><h2>실험 대기열과 결과</h2><div id="experiments" class="simple-list"><div class="empty">불러오는 중…</div></div></section>
    </div>

    <div class="tab-panel" data-panel="automation" hidden>
      <section class="grid"><div class="section"><h2>n8n 워크플로</h2><div id="workflowList" class="workflow-list"><div class="empty">불러오는 중…</div></div></div><div class="stack"><div class="section"><h2>최근 실패한 자동화 · 최대 5건</h2><div id="failureList" class="execution-list"></div></div><div class="section"><h2>최근 자동화</h2><div id="executionList" class="execution-list"></div></div></div></section>
      <section class="section" style="margin-top:14px"><h2>예약 작업</h2><div id="schedules"></div></section><section class="section" style="margin-top:14px"><h2>최근 AI 작업</h2><div id="recentJobs"></div></section><section class="section" style="margin-top:14px"><h2>관리 프로세스</h2><div id="processes"></div></section>
    </div>

    <div class="tab-panel" data-panel="trading" hidden><section class="section" style="margin-bottom:14px"><h2>오늘의 dry-run</h2><div id="trading" class="trading-grid"><div class="empty">불러오는 중…</div></div><div id="tradingDetail"></div><div id="tradingPositions"></div></section><section class="section"><h2>내 보유자산</h2><div id="portfolio"><div class="empty">불러오는 중…</div></div></section></div>

    <div class="tab-panel" data-panel="system" hidden><section class="section"><h2>Mac mini와 서비스</h2><div id="services"></div><div id="system"></div></section><section id="storageSection" class="section" style="margin-top:14px"><h2>저장소와 사진 백업</h2><div id="storage" class="system-list"></div></section><section class="section" style="margin-top:14px"><div class="lab-header"><h2>코드 저장소 점검</h2><button id="runRepoChecks" class="action" type="button">지금 점검</button></div><p class="lab-description">하네스 audit·검증 증거·유지보수 리뷰와 GitHub 공개 전 차단 항목을 읽기 전용으로 확인합니다. 매일 아침 자동 실행됩니다.</p><div id="repoChecks" class="simple-list"><div class="empty">불러오는 중…</div></div></section></div>

    <div class="tab-panel" data-panel="settings" hidden><section class="section" style="margin-bottom:14px"><h2>접근 보안</h2><div id="securityNotice" class="attention-list"><div class="empty">불러오는 중…</div></div></section><section class="section"><h2>추천 선호</h2><div id="preferences" class="simple-list"></div><form id="preferenceForm" class="inline-form"><select id="preferenceType"><option value="like">선호</option><option value="avoid">피하기</option></select><input id="preferenceText" placeholder="예: 평일 장거리 외출 추천"><button>저장</button></form></section><section class="section" style="margin-top:14px"><h2>사용량과 품질</h2><div id="quality" class="today-grid"></div></section><details class="section" style="margin-top:14px"><summary style="padding:14px;font-weight:700;cursor:pointer">고급 명령</summary><div id="commands" class="command-grid"></div><pre id="commandOutput" class="command-output">명령을 선택하세요.</pre></details></div>
    ${EMOTICON_TAB_HTML}
  </main>
  <div id="docViewer" class="doc-viewer" hidden><div class="doc-viewer-panel" role="dialog" aria-modal="true" aria-labelledby="docViewerTitle"><div class="doc-viewer-bar"><button id="docViewerClose" class="action" type="button">닫기</button><strong id="docViewerTitle"></strong><a id="docViewerDownload" class="action" href="#">다운로드</a></div><article id="docViewerBody" class="doc-body"></article></div></div>
  <script>
    const defaultChatId = "${chatId}";
    const params = new URLSearchParams(window.location.search);
    if (!params.get("chatId") && defaultChatId) params.set("chatId", defaultChatId);

    const latest = { dashboard: null, n8n: null, trading: null };
    const loading = new Set();
    async function loadJson(key, url, renderFn) {
      if (loading.has(key)) return;
      loading.add(key);
      try {
        const response = await fetch(url, { cache: "no-store" });
        const data = await response.json();
        latest[key] = data;
        renderFn(data);
        if (latest.dashboard) renderOperations(latest.dashboard, latest.n8n, latest.trading);
        document.getElementById("lastUpdated").textContent = "마지막 갱신 " + new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } finally { loading.delete(key); }
    }
    const loadDashboard = () => loadJson("dashboard", "/api/dashboard?" + params.toString(), render);
    const loadN8n = () => loadJson("n8n", "/api/n8n/workflows", renderN8n);
    const loadTrading = () => loadJson("trading", "/api/trading", renderTrading);
    async function loadPortfolio() {
      if (loading.has("portfolio")) return;
      loading.add("portfolio");
      try { const response = await fetch("/api/portfolio", { cache: "no-store" }); renderPortfolio(await response.json()); }
      finally { loading.delete("portfolio"); }
    }

    function renderN8n(data) {
      const workflows = document.getElementById("workflowList");
      const executions = document.getElementById("executionList");
      const failures = document.getElementById("failureList");
      if (!data.ok) {
        workflows.innerHTML = '<div class="empty">' + escapeText(data.error) + '</div>';
        executions.innerHTML = '<div class="empty">n8n 연결 필요</div>';
        failures.innerHTML = '<div class="empty">n8n 연결 필요</div>';
        return;
      }
      workflows.innerHTML = data.workflows.length ? data.workflows.map(row =>
        '<div class="workflow-row"><div><strong>' + escapeText(row.name) + '</strong><div class="meta">' + badge(row.active ? "published" : "draft") + ' · ' + escapeText(formatTime(row.updatedAt)) + '</div></div><button class="action ' + (row.active ? "unpublish" : "publish") + '" data-workflow="' + escapeText(row.id) + '" data-action="' + (row.active ? "unpublish" : "publish") + '">' + (row.active ? "게시 중지" : "게시") + '</button></div>'
      ).join("") : '<div class="empty">워크플로우가 없습니다.</div>';
      executions.innerHTML = data.executions.length ? groupExecutions(data.executions).map(group =>
        '<div class="workflow-row"><div><strong>' + escapeText(group.workflowName) + '</strong><div class="meta">최근 ' + escapeText(formatTime(group.latest)) + (group.count > 1 ? ' · ' + group.count + '회 (' + escapeText(formatTime(group.earliest)) + '부터)' : '') + '</div></div>' + badge(group.status) + '</div>'
      ).join("") : '<div class="empty">최근 실행이 없습니다.</div>';
      failures.innerHTML = data.failures.length ? data.failures.map(row =>
        '<div class="workflow-row"><div><strong>' + escapeText(row.workflowName) + '</strong><div class="meta">#' + escapeText(row.id) + ' · ' + escapeText(formatTime(row.startedAt)) + '</div><button class="action" data-detail="' + escapeText(row.id) + '">오류 상세</button></div><button class="action publish" data-retry="' + escapeText(row.id) + '">재시도</button></div>'
      ).join("") : '<div class="attention good">최근 실패한 자동화가 없습니다.</div>';
    }

    // Minute-level workflows would otherwise fill the list with identical rows.
    function groupExecutions(rows) {
      const groups = new Map();
      for (const row of rows) {
        const key = row.workflowName + "\\u0000" + row.status;
        const group = groups.get(key) || { workflowName: row.workflowName, status: row.status, count: 0, latest: row.startedAt, earliest: row.startedAt };
        group.count += 1;
        if (String(row.startedAt) > String(group.latest)) group.latest = row.startedAt;
        if (String(row.startedAt) < String(group.earliest)) group.earliest = row.startedAt;
        groups.set(key, group);
      }
      return [...groups.values()].sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
    }

    function renderTrading(data) {
      const target = document.getElementById("trading");
      const positionsTarget = document.getElementById("tradingPositions");
      if (!data.ok) { target.innerHTML = '<div class="empty">' + escapeText(data.error) + '</div>'; positionsTarget.innerHTML = ""; return; }
      const row = data.trading;
      target.innerHTML = metric("당일 손익", formatWon(row.pnl)) + metricButton("orders", "주문", row.orders + "건") + metric("포지션", row.positions + "개") + metricButton("candidates", "후보", row.selectedCandidates + "개") + metric("현금", formatWon(row.cash)) + metricButton("trades", "승/패", row.wins + " / " + row.losses) + metric("전략", row.strategyMode) + metric("실거래 준비", row.liveReady ? "READY" : "대기");
      renderTradingDetail(row);
      const positions = row.openPositions || [];
      if (!positions.length) {
        positionsTarget.innerHTML = '<div class="empty">현재 trading 시스템이 보유한 종목이 없습니다.</div>';
        return;
      }
      const positionRows = positions.map(position => {
        const rate = Number(position.returnRate || 0);
        const tone = rate > 0 ? "positive" : rate < 0 ? "negative" : "";
        const details = [position.symbol, position.quantity + "주", position.mode, position.heldDays + "일 보유"].filter(Boolean).join(" · ");
        return '<tr><td><strong>' + escapeText(position.name) + '</strong><div class="meta">' + escapeText(details) + '</div></td>' +
          '<td data-label="진입가">' + formatWon(position.entryPrice) + '</td><td data-label="현재가">' + formatWon(position.currentPrice) + '</td><td data-label="평가금액">' + formatWon(position.marketValue) + '</td>' +
          '<td data-label="평가손익" class="' + tone + '">' + formatSignedWon(position.profitLoss) + '</td><td data-label="수익률" class="' + tone + '">' + formatRate(rate) + '</td></tr>';
      }).join("");
      positionsTarget.innerHTML = '<div class="table-scroll"><table class="portfolio-table"><thead><tr><th>거래 종목</th><th>진입가</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>' + positionRows + '</tbody></table></div>';
    }

    function renderPortfolio(data) {
      const target = document.getElementById("portfolio");
      if (!data.ok) { target.innerHTML = '<div class="empty">' + escapeText(data.error) + '</div>'; return; }
      const portfolio = data.portfolio;
      const summary = portfolio.summary;
      const rows = portfolio.holdings.map(row => {
        const rate = row.returnRate === null ? null : Number(row.returnRate);
        const tone = rate === null ? "" : rate > 0 ? "positive" : rate < 0 ? "negative" : "";
        const details = [row.category, row.symbol, row.quantity ? row.quantity + "주" : null].filter(Boolean).join(" · ");
        return '<tr><td><strong>' + escapeText(row.name) + '</strong><div class="meta">' + escapeText(details) + '</div></td>' +
          '<td data-label="평균 매입가">' + (row.averagePrice === null ? "-" : formatWon(row.averagePrice)) + '</td><td data-label="현재가">' + (row.valuation === "manual" ? "수동 평가" : row.currentPrice === null ? "조회 불가" : formatWon(row.currentPrice)) + '</td>' +
          '<td data-label="평가금액">' + (row.marketValue === null ? "-" : formatWon(row.marketValue)) + '</td><td data-label="평가손익" class="' + tone + '">' + (row.profitLoss === null ? "-" : formatSignedWon(row.profitLoss)) + '</td>' +
          '<td data-label="수익률" class="' + tone + '">' + (rate === null ? "-" : formatRate(rate)) + '</td></tr>';
      }).join("");
      target.innerHTML = '<div class="portfolio-summary">' + metric("총 매수금액", formatWon(summary.costBasis)) + metric("평가금액", formatWon(summary.marketValue)) + metric("평가손익", formatSignedWon(summary.profitLoss)) + metric("수익률", formatRate(summary.returnRate)) + '</div>' +
        '<div class="table-scroll"><table class="portfolio-table"><thead><tr><th>종목</th><th>평균 매입가</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (summary.priced < summary.total ? '<div class="empty">현재가 미조회 종목은 총 평가에서 매수금액으로 계산했습니다.</div>' : '');
    }

    function renderOperations(dashboard, n8nData, tradingData) {
      const ready = (dashboard.experiments || []).filter(row => row.status === "completed" && !row.readAt);
      const decisions = ready.slice(0, 3).map(row => '<div class="attention good"><strong>실험 결과 준비</strong><br>' + escapeText(row.topic) + '</div>');
      document.getElementById("attention").innerHTML = decisions.join("") || '<div class="attention good">결정을 기다리는 결과가 없습니다. 맡길 작은 실험을 추가해보세요.</div>';
      const next = dashboard.schedules?.[0];
      const queued = (dashboard.experiments || []).filter(row => row.status === "queued").length;
      document.getElementById("today").innerHTML = metric("결과 준비", ready.length + "건") + metric("실험 대기", queued + "건") + metric("읽기·할 일", (dashboard.personal?.openInbox || 0) + "건") + metric("다음 자동화", next ? formatTime(next.nextRunAt) : "-");
      document.getElementById("quality").innerHTML = metric("Claude 작업", (dashboard.usage?.claudeJobs || 0) + "건") + metric("Codex 작업 · 폴백", (dashboard.usage?.codexJobs || 0) + "건 · " + (dashboard.usage?.fallbacks || 0) + "건") + metric("실패 · 품질 재시도", (dashboard.usage?.failures || 0) + "건 · " + (dashboard.usage?.qualityRetries || 0) + "건") + metric("로컬 작업", (dashboard.usage?.localJobs || 0) + "건") + metric("입력 토큰", formatInteger(dashboard.usage?.inputTokens || 0)) + renderBriefingHealth(dashboard);
    }
    // Delivery and feedback health replaces the format score; the score stays only as a fallback.
    function renderBriefingHealth(dashboard) {
      const health = dashboard.briefingHealth;
      if (!health) return metric("브리핑 형식 검사 · 사실 정확성 미평가", dashboard.briefingQuality?.averageScore == null ? "-" : dashboard.briefingQuality.averageScore + "/100");
      const rate = Number(health.feedbackRate || 0);
      const percent = Math.round(rate <= 1 ? rate * 100 : rate);
      return metric("브리핑 · 최근 " + (health.days || 14) + "일", (health.briefings || 0) + "건 · 지연 " + (health.lateDeliveries || 0) + "건") +
        metric("추천 피드백", (health.feedbackCount || 0) + "건 · " + percent + "%") + metric("로컬 브리핑 실패", (health.localFailures || 0) + "건");
    }

    let tradingDetailKey = null;
    function metricButton(key, label, value) {
      const selected = tradingDetailKey === key;
      return '<button type="button" class="mini' + (selected ? ' selected' : '') + '" data-trading-detail="' + key + '" aria-expanded="' + selected + '"><span class="label">' + escapeText(label) + '</span><strong>' + escapeText(value) + '</strong><span class="hint">' + (selected ? '종목 닫기' : '종목 보기') + '</span></button>';
    }
    function renderTradingDetail(row) {
      const target = document.getElementById("tradingDetail");
      const stock = item => '<strong>' + escapeText(item.name) + '</strong><div class="meta">' + escapeText(item.symbol) + '</div>';
      const time = value => value ? escapeText(new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })) : "-";
      const views = {
        orders: { title: "주문 종목", items: row.orderList || [], head: ["종목", "시각", "구분", "수량·가격", "상태"],
          cells: item => [stock(item), time(item.ts), escapeText(item.side), escapeText(item.quantity + "주 · " + formatWon(item.price)), escapeText(item.status) + (item.message && item.message !== item.status ? '<div class="meta">' + escapeText(item.message) + '</div>' : '')] },
        trades: { title: "청산 종목", items: row.tradeList || [], head: ["종목", "진입", "청산", "손익", "사유"],
          cells: item => [stock(item), time(item.entryAt), time(item.exitAt), '<span class="' + (item.profitLoss > 0 ? "positive" : item.profitLoss < 0 ? "negative" : "") + '">' + formatSignedWon(item.profitLoss) + '</span>', escapeText(item.reason)] },
        candidates: { title: "선정 후보", items: row.candidateList || [], head: ["종목", "출처", "점수", "등락률", "가격"],
          cells: item => [stock(item), escapeText(item.source), item.score == null ? "-" : escapeText(Number(item.score).toFixed(2)), formatRate(item.changeRate), formatWon(item.price)] },
      };
      const view = views[tradingDetailKey];
      if (!view) { target.innerHTML = ""; return; }
      if (!view.items.length) { target.innerHTML = '<div class="empty">' + view.title + '이 없습니다.</div>'; return; }
      const rows = view.items.map(item => '<tr>' + view.cells(item).map((cell, index) => '<td' + (index ? ' data-label="' + view.head[index] + '"' : '') + '>' + cell + '</td>').join("") + '</tr>').join("");
      target.innerHTML = '<div class="meta" style="padding:4px 12px 0">' + view.title + ' · ' + view.items.length + '건 표시</div><div class="table-scroll"><table class="portfolio-table"><thead><tr>' + view.head.map(label => '<th>' + label + '</th>').join("") + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
    document.getElementById("trading").addEventListener("click", event => {
      const button = event.target.closest("button[data-trading-detail]");
      if (!button) return;
      tradingDetailKey = tradingDetailKey === button.dataset.tradingDetail ? null : button.dataset.tradingDetail;
      if (latest.trading?.ok) renderTrading(latest.trading);
    });

    function metric(label, value) { return '<div class="mini"><span class="label">' + escapeText(label) + '</span><strong>' + escapeText(value) + '</strong></div>'; }
    function formatWon(value) {
      const number = Number(value || 0);
      const wholeWon = Number.isFinite(number) ? Math.trunc(number) : 0;
      return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(wholeWon) + "원";
    }

    function formatInteger(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.trunc(number).toLocaleString("ko-KR") : "0";
    }
    function formatSignedWon(value) { const number = Number(value || 0); return (number > 0 ? "+" : "") + formatWon(number); }
    function formatRate(value) { const number = Number(value || 0); return (number > 0 ? "+" : "") + number.toFixed(2) + "%"; }

    document.getElementById("workflowList").addEventListener("click", async event => {
      const button = event.target.closest("button[data-workflow]");
      if (!button) return;
      const action = button.dataset.action;
      const actionLabel = action === "publish" ? "게시" : "게시 중지";
      if (!window.confirm(button.closest(".workflow-row").querySelector("strong").textContent + "을(를) " + actionLabel + " 할까요?")) return;
      button.disabled = true;
      button.textContent = "처리 중…";
      try {
        const response = await fetch("/api/n8n/workflows/" + encodeURIComponent(button.dataset.workflow) + "/" + action, { method: "POST" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "처리 실패");
        await loadN8n();
      } catch (error) { window.alert(error.message); button.disabled = false; button.textContent = actionLabel; }
    });

    document.getElementById("failureList").addEventListener("click", async event => {
      const detailButton = event.target.closest("button[data-detail]");
      if (detailButton) {
        try {
          const response = await fetch("/api/n8n/executions/" + detailButton.dataset.detail);
          const data = await response.json();
          if (!data.ok) throw new Error(data.error);
          const e = data.execution;
          window.alert("실행 #" + e.id + " · " + e.node + "\\nHTTP " + (e.httpCode || "-") + "\\n" + e.message + "\\n" + e.description);
        } catch (error) { window.alert(error.message); }
        return;
      }
      const button = event.target.closest("button[data-retry]");
      if (!button || !window.confirm("실패한 실행 #" + button.dataset.retry + "을 재시도할까요?")) return;
      button.disabled = true;
      button.textContent = "처리 중…";
      try {
        const response = await fetch("/api/n8n/executions/" + button.dataset.retry + "/retry", { method: "POST" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "재시도 실패");
        window.alert("실행 #" + data.execution.id + "으로 재시도했습니다.");
        await loadN8n();
      } catch (error) { window.alert(error.message); button.disabled = false; button.textContent = "재시도"; }
    });

    function formatTime(value) {
      if (!value) return "-";
      return new Date(value).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    function renderCodexLimits(limits, targetId = "codexLimits", footer = "1분 간격 자동 조회") {
      const target = document.getElementById(targetId);
      const cards = [["5시간 · 5h", limits?.fiveHour], ["주간 · 7일", limits?.weekly]].map(([label, row]) => {
        if (limits?.status !== "available" || !row) return '<div class="codex-limit-card"><h3>' + label + '</h3><div class="empty">한도 조회 불가</div><div class="meta">한도 정보가 제공되지 않았습니다.</div></div>';
        const reset = row.resetsAt ? new Date(row.resetsAt) : null;
        // A window past its reset (or not started yet) is unused until the next request opens a new one.
        const idle = row.idle === true || Boolean(reset && reset.getTime() <= Date.now());
        const remaining = idle ? 100 : row.remainingPercent;
        const resetLabel = reset ? reset.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + " KST" : "정보 없음";
        const tone = remaining === 0 ? " depleted" : remaining <= 20 ? " low" : "";
        return '<div class="codex-limit-card' + tone + '"><h3>' + label + '</h3><div class="codex-limit-value">' + remaining + '% 남음</div>' +
          '<progress max="100" value="' + remaining + '" aria-label="' + label + ' 남은 한도">' + remaining + '%</progress>' +
          (idle ? '<div class="meta">리셋됨 · 다음 사용 때 새 창 시작</div>' : '<div class="meta">사용률 ' + row.usedPercent + '%</div><div class="meta">리셋 · ' + resetLabel + '</div>') + '</div>';
      }).join("");
      const fallback = limits?.exhaustedUntil ? '<div class="meta codex-limit-updated">한도 도달 · ' + formatTime(limits.exhaustedUntil) + '까지 Codex로 실행</div>' : '';
      target.innerHTML = '<div class="codex-limit-grid">' + cards + '</div>' + fallback + '<div class="meta codex-limit-updated">' + footer + ' · 마지막 조회 ' + formatTime(limits?.checkedAt) + '</div>';
    }

    function render(data) {
      availableDocuments = data.documents || [];
      document.getElementById("documents").innerHTML = availableDocuments.map(file => '<div class="simple-row"><strong>' + escapeText(file.name) + '</strong><div class="meta">' + escapeText(file.path) + ' · ' + escapeText(formatTime(file.modifiedAt)) + '</div><div class="lab-actions">' + documentActions(file) + '</div></div>').join("") || '<div class="empty">저장된 문서가 없습니다.</div>';
      renderCodexLimits(data.claudeRateLimits, "claudeLimits", "Claude 작업과 Claude Code 세션 기준");
      renderCodexLimits(data.codexRateLimits);
      document.getElementById("services").innerHTML = renderServices(data.services || []);
      document.getElementById("system").innerHTML = renderSystem(data.system);
      document.getElementById("commands").innerHTML = renderCommands();
      setHtmlKeepingOpen(document.getElementById("briefings"), renderBriefings((data.recentBriefings || []).slice(0, 5)), "data-briefing-id");
      const statusHtml = renderStatusLine(data);
      document.getElementById("statusItems").innerHTML = statusHtml;
      document.getElementById("statusLine").hidden = !statusHtml;
      document.getElementById("securityNotice").innerHTML = renderSecurityNotice(data.security);
      document.getElementById("inbox").innerHTML = renderInbox(data.inbox || []);
      document.getElementById("preferences").innerHTML = renderPreferences(data.preferences || []);
      updateExperiments(data.experiments || []);
      document.getElementById("nextSchedules").innerHTML = renderSchedules((data.schedules || []).slice(0, 3));
      document.getElementById("schedules").innerHTML = renderSchedules(data.schedules || [], true);
      document.getElementById("recentJobs").innerHTML = renderJobs(data.recentJobs || [], "최근 AI 작업이 없습니다.");
      document.getElementById("processes").innerHTML = renderProcesses(data.processes || []);
      document.getElementById("storage").innerHTML = renderStorage(data.health);
      document.getElementById("storageSection").hidden = Boolean(data.health) && !data.health.storage?.configured && !data.health.photoBackup?.configured;
      document.getElementById("repoChecks").innerHTML = renderRepoChecks(data.repoChecks);
      setHtmlKeepingOpen(document.getElementById("emoticons"), renderEmoticons(data.emoticons || []), "data-emoticon-id");
      [document.getElementById("commandOutput"), document.getElementById("askOutput"), document.getElementById("quickOutput"), document.getElementById("labOutput")].forEach(output => updateJobOutput(output, data));
    }

    function renderBriefings(rows) {
      if (!rows.length) return '<div class="empty">최근 브리핑이 없습니다.</div>';
      const labels = { morning: "모닝", evening: "이브닝", weekly: "주간", aiTrend: "AI 트렌드" };
      return rows.map(row => '<div class="simple-row" data-briefing-id="' + escapeText(row.id) + '"><details><summary style="cursor:pointer"><strong>' + escapeText(labels[row.kind] || row.kind) + '</strong><span class="meta"> · ' + escapeText(formatTime(row.sentAt)) + ' · 펼쳐서 전체 보기</span><div class="meta">' + escapeText(briefingPreview(row.text)) + '</div></summary><div class="lab-result briefing-full">' + escapeText(row.text) + '</div></details>' +
        '<div class="lab-actions"><button type="button" data-briefing-action="up" aria-label="도움이 됐어요" aria-pressed="' + (row.feedback === "interest") + '">👍</button><button type="button" data-briefing-action="down" aria-label="별로였어요" aria-pressed="' + (row.feedback === "skip") + '">👎</button><button type="button" data-briefing-action="resend">다시 보내기</button></div></div>').join("");
    }
    function briefingPreview(text) {
      const lines = String(text || "").split("\\n").map(line => line.trim()).filter(Boolean).slice(1);
      const bullets = lines.filter(line => /^[•\\-*]\\s*/.test(line)).map(line => line.replace(/^[•\\-*]\\s*/, ""));
      return (bullets.length ? bullets : lines).slice(0, 2).join(" · ");
    }
    function renderInbox(rows) {
      if (!rows.length) return '<div class="empty">열린 항목이 없습니다.</div>';
      const types = { task: "할 일", idea: "아이디어", read: "읽기", note: "메모" };
      return rows.map(row => {
        const waiting = row.daysWaiting == null ? formatTime(row.createdAt) : row.daysWaiting === 0 ? "오늘 추가" : row.daysWaiting + "일째";
        const due = row.dueLabel ? ' · <span class="' + (row.overdue ? "overdue" : "") + '">마감 ' + escapeText(row.dueLabel) + (row.overdue ? " (지남)" : "") + '</span>' : '';
        return '<div class="simple-row" data-inbox-id="' + escapeText(row.id) + '"><strong>' + escapeText(row.text) + '</strong><div class="meta">' + escapeText(types[row.type] || row.type) + ' · ' + escapeText(waiting) + due + '</div><div class="lab-actions"><button data-inbox-action="done">완료</button><button data-inbox-action="snooze" title="24시간 뒤에 다시 표시">미루기</button><button data-inbox-action="archive">보관</button></div></div>';
      }).join("");
    }
    function setHtmlKeepingOpen(container, html, key) {
      if (container.renderedHtml === html) return;
      const open = new Set(Array.from(container.querySelectorAll("[" + key + "]")).filter(row => row.querySelector("details")?.open).map(row => row.getAttribute(key)));
      container.innerHTML = html;
      container.renderedHtml = html;
      container.querySelectorAll("[" + key + "]").forEach(row => {
        const details = row.querySelector("details");
        if (details && open.has(row.getAttribute(key))) details.open = true;
      });
    }
    function renderStatusLine(data) {
      const items = [];
      const pause = data.usagePause;
      if (pause) {
        items.push('<div class="attention"><strong>AI 예약 작업 일시 중지</strong> · ' + escapeText((pause.untilLabel || formatTime(pause.until)) + "까지") + (pause.reason ? '<br>' + escapeText(pause.reason) : '') +
          '<div class="meta">로컬 브리핑과 영어 학습은 계속 보냅니다.</div><div class="lab-actions"><button type="button" data-usage-pause="clear">해제</button></div></div>');
      }
      (data.failingSchedules || []).forEach(row => items.push('<div class="attention" data-schedule-id="' + escapeText(row.id) + '"><strong>' + escapeText(row.name) + ' 실패' + (row.failureCount ? ' ' + escapeText(row.failureCount) + '회' : '') + '</strong><br>' + escapeText(row.lastError) +
        '<div class="lab-actions"><button type="button" data-schedule-action="run">지금 실행</button></div></div>'));
      return items.join("");
    }
    function renderSecurityNotice(security) {
      if (!security) return '';
      return security.tailnetUsersConfigured
        ? '<div class="attention good">Tailscale 주소로는 DASHBOARD_TAILNET_USERS에 등록된 계정만 명령을 실행할 수 있습니다.</div>'
        : '<div class="attention"><strong>DASHBOARD_TAILNET_USERS가 설정되지 않았습니다.</strong><br>같은 tailnet의 모든 기기가 이 대시보드에서 명령을 실행할 수 있습니다. .env에 허용할 Tailscale 로그인을 쉼표로 구분해 지정하세요.</div>';
    }
    function updateExperiments(rows) {
      const container = document.getElementById("experiments");
      const archived = rows.filter(row => ["archived", "discarded"].includes(row.status));
      const html = renderExperiments(rows.filter(row => !["archived", "discarded"].includes(row.status))) +
        (archived.length ? '<h2>보관함 · ' + archived.length + '건</h2>' + renderExperiments(archived) : '');
      if (container.renderedExperiments === html) return;
      const state = new Map(Array.from(container.querySelectorAll("[data-lab-id]"), row => [row.dataset.labId, {
        open: row.querySelector("details")?.open || false,
        scrollTop: row.querySelector(".lab-result")?.scrollTop || 0,
      }]));
      container.innerHTML = html;
      container.renderedExperiments = html;
      container.querySelectorAll("[data-lab-id]").forEach(row => {
        const previous = state.get(row.dataset.labId);
        if (!previous) return;
        const details = row.querySelector("details");
        const result = row.querySelector(".lab-result");
        if (details) details.open = previous.open;
        if (result) result.scrollTop = previous.scrollTop;
      });
    }
    function renderExperiments(rows) {
      if (!rows.length) return '<div class="empty">아직 실험이 없습니다. 떠오른 아이디어를 바로 맡겨보세요.</div>';
      const labels = { queued:"예약 대기", running:"실행 중", waiting:"앞 작업 완료 대기", completed:"결과 준비", failed:"실패", archived:"보관", discarded:"폐기" };
      return rows.map(row => '<div class="simple-row" data-lab-id="' + escapeText(row.id) + '"><div><strong>' + escapeText(row.topic) + '</strong> <span class="pill ' + escapeText(row.status) + '">' + escapeText(labels[row.status] || row.status) + '</span></div><div class="meta">' + escapeText(row.id) + ' · ' + escapeText(formatTime(row.updatedAt)) + '</div>' +
        (row.result ? '<details><summary class="meta" style="cursor:pointer;margin-top:8px">요약 보기</summary><div class="lab-result">' + escapeText(row.result) + '</div></details>' : '') + renderDocumentLinks(documentsForText(row.result, row.artifacts)) +
        (row.parentId ? '<div class="meta">원본 보고서: ' + escapeText(row.parentId) + ' · ' + escapeText(row.followupKind) + '</div>' : '') +
        (rows.some(child => child.parentId === row.id) ? '<div class="meta">후속 작업: ' + rows.filter(child => child.parentId === row.id).map(child => escapeText(child.topic)).join(' · ') + '</div>' : '') +
        '<div class="lab-actions">' + (["archived", "discarded"].includes(row.status) ? '<button data-lab-action="restore">보관함에서 복원</button>' : row.status === "completed" ?
          (row.readAt ? '<span class="meta">읽음</span>' : '<button data-lab-action="read">읽음 처리</button>') + '<button data-lab-action="practice">실습하기</button><button data-lab-action="implement">구현 맡기기</button><button data-lab-action="research">추가 조사</button><button data-lab-action="archive">보관</button>' : row.status === "failed" ? '<button data-lab-action="archive">보관</button>' : '') + '</div></div>').join("");
    }
    function renderPreferences(rows) { return rows.length ? rows.map(row => '<div class="simple-row"><strong>' + escapeText(row.type === "avoid" ? "피하기" : "선호") + '</strong> · ' + escapeText(row.text) + '<div class="meta">' + escapeText(row.id) + '</div></div>').join("") : '<div class="empty">저장된 추천 선호가 없습니다.</div>'; }
    function renderStorage(health) {
      if (!health) return '<div class="empty">저장소 상태를 불러오는 중입니다.</div>';
      const storage = health.storage || {};
      const photos = health.photoBackup || {};
      // Checks that were never configured are hidden instead of shown as "not configured".
      const rows = [];
      if (storage.configured) rows.push('<div><span class="label">외장 SSD</span><div>' + escapeText(storage.ok ? storage.path + " · " + formatBytes(storage.availableBytes) + " 여유" : storage.error) + '</div></div>');
      if (photos.configured) rows.push('<div><span class="label">사진 원본 백업</span><div>' + escapeText(photos.ok ? (photos.latestModifiedAt ? "최근 파일 " + formatTime(photos.latestModifiedAt) : "폴더 비어 있음") : photos.error) + '</div></div>');
      return rows.join("") || '<div class="meta">설정된 저장소 점검이 없습니다.</div>';
    }

    function renderRepoChecks(result) {
      if (!result?.repos?.length) return '<div class="empty">아직 점검 기록이 없습니다. 지금 점검을 눌러 보세요.</div>';
      return result.repos.map(row => {
        const checkedAt = row.checkedAt || result.checkedAt;
        const checkedTime = Date.parse(checkedAt);
        const stale = !Number.isFinite(checkedTime) || Date.now() - checkedTime > 24 * 60 * 60 * 1000;
        return '<div class="simple-row" data-repo-name="' + escapeText(row.name) + '"><div><strong>' + escapeText(row.name) + '</strong> <span class="pill ' + (row.issues.length ? 'failed' : 'completed') + '">' + escapeText(row.issues.length ? '확인 필요 ' + row.issues.length : '이상 없음') + '</span>' + (stale ? ' <span class="pill stopping">오래됨</span>' : '') + '</div>' +
          (row.issues.length ? '<div class="meta">' + row.issues.map(escapeText).join('<br>') + '</div>' : '') +
          '<div class="meta">' + escapeText([row.harness ? 'harness' : 'harness 없음', row.git ? 'git' : 'git 아님', '점검 ' + formatTime(checkedAt)].join(' · ')) + '</div>' +
          (row.rechecking ? '<div class="lab-actions"><span class="meta">재점검 중…</span></div>' : stale ? '<div class="lab-actions"><button type="button" data-repo-recheck="' + escapeText(row.name) + '">재점검</button></div>' : '') + '</div>';
      }).join('') +
        '<div class="meta" style="padding:8px 12px">마지막 점검 ' + escapeText(formatTime(result.checkedAt)) + ' · 파일 위치는 Telegram /publish-check 저장소이름</div>';
    }

    let availableDocuments = [];
    const viewableDocument = /\.(md|txt|csv)$/i;
    function documentActions(file) {
      const open = viewableDocument.test(file.name)
        ? '<button type="button" class="doc-link" data-doc-view="' + escapeText(file.url) + '" data-doc-name="' + escapeText(file.name) + '">보기</button>'
        : '<a target="_blank" rel="noopener" href="' + escapeText(file.url) + '">열기</a>';
      return '<span class="doc-actions">' + open + '<a href="' + escapeText(file.url + '&download=1') + '">다운로드</a></span>';
    }
    function renderDocumentLinks(files) {
      return files.length ? '<div class="lab-actions">' + files.map(file => '<span class="doc-file"><span>📄 ' + escapeText(file.name) + '</span>' + documentActions(file) + '</span>').join('') + '</div>' : '';
    }

    function documentsForText(text, artifacts = []) {
      const content = String(text || '') + ' ' + artifacts.map(item => typeof item === 'string' ? item : item.path).join(' ');
      return availableDocuments.filter(file => content.includes(file.path) || content.includes(file.absolutePath));
    }
    function statusLabel(status) {
      const labels = { completed: "완료", failed: "실패", running: "실행 중", queued: "대기", waiting: "대기", cancelled: "취소", canceled: "취소", exited: "종료", stopping: "중지 중", crashed: "비정상 종료", published: "게시됨", draft: "초안", success: "성공", error: "오류", new: "새 실행", online: "온라인", offline: "오프라인" };
      return labels[status] || status;
    }
    function updateJobOutput(output, data) {
      const jobId = output.dataset.jobId;
      if (jobId) {
        const job = [data.activeJob, ...data.runningDelegates, ...data.recentJobs].filter(Boolean).find(row => row.jobId === jobId);
        if (job?.status === "completed" || job?.status === "failed" || job?.status === "cancelled") {
          output.textContent = jobId + " · " + statusLabel(job.status) + "\\n\\n" + job.summary;
          output.insertAdjacentHTML("beforeend", renderDocumentLinks(documentsForText(job.summary)));
          if (job.summaryTruncated) output.insertAdjacentHTML("beforeend", '<div class="lab-actions"><button type="button" class="action" data-job-result="' + escapeText(jobId) + '">전체 결과 보기</button></div>');
          delete output.dataset.jobId;
        } else if (job) {
          output.textContent = jobId + " · " + statusLabel(job.status) + "…";
        }
      }
    }

    function renderServices(rows) {
      const host = window.location.hostname;
      return '<div class="service-grid">' + rows.map(row => {
        const href = row.id === "ai-workmate" ? "/" : row.id === "n8n" ? "#workflowList" : "http://" + host + ":" + row.port + "/";
        return '<a class="service-card" href="' + escapeText(href) + '"><div class="service-title"><span>' + escapeText(row.name) + '</span><span><i class="dot ' + escapeText(row.status) + '"></i> ' + escapeText(statusLabel(row.status)) + '</span></div><div class="meta">' + escapeText(row.description) + ' · :' + escapeText(row.port) + '</div></a>';
      }).join("") + '</div>';
    }

    function renderSystem(system) {
      if (!system) return "";
      return '<div class="system-list"><div><span class="label">호스트</span><div>' + escapeText(system.hostname) + '</div></div><div><span class="label">플랫폼</span><div>' + escapeText(system.platform) + '</div></div><div><span class="label">CPU</span><div>' + escapeText(system.cpuCount) + '코어 · 부하 ' + escapeText(system.load1) + ' / ' + escapeText(system.load5) + '</div></div><div><span class="label">' + (system.memoryMetric === "pressure" ? "메모리 압력" : "메모리") + '</span><div>' + escapeText(formatBytes(system.memoryUsedBytes)) + ' / ' + escapeText(formatBytes(system.memoryTotalBytes)) + ' (' + escapeText(system.memoryUsedPercent) + '%)</div></div><div><span class="label">Mac 가동 시간</span><div>' + escapeText(system.systemUptime) + '</div></div><div><span class="label">브리지 가동 시간</span><div>' + escapeText(system.bridgeUptime) + '</div></div></div>';
    }

    function renderCommands() {
      const commands = [
        ["/morning", "맞춤 모닝 브리핑"], ["/evening", "맞춤 이브닝 브리핑"], ["/weekly-review", "주간 생활 리뷰"], ["/ai-trends", "오늘의 AI 트렌드"], ["/discover", "오늘의 새 추천"], ["/status", "현재 작업 상태"], ["/jobs", "최근 작업 목록"],
        ["/n8n <요청>", "n8n 워크플로우 조회·진단·수정"], ["/ps", "관리 중인 서버"], ["/schedules", "예약 작업"],
        ["/delegate <요청>", "병렬 작업 시작"], ["/workspaces", "작업공간 목록"], ["/tools", "사용 가능한 도구"],
        ["/tr <보유|설정|매도>", "트레이딩 보유·설정·매도 제어"],
        ["/health", "서비스·외장 저장소 상태"], ["/inbox", "개인 수신함"], ["/watches", "웹 감시 목록"],
        ["/lab now <주제>", "바로 리서치 실행"],
      ];
      return commands.map(row => '<button type="button" class="command-card" data-command="' + escapeText(row[0]) + '"><code>' + escapeText(row[0]) + '</code><span class="meta">' + escapeText(row[1]) + '</span></button>').join("");
    }

    document.getElementById("commands").addEventListener("click", async event => {
      const button = event.target.closest("button[data-command]");
      if (!button) return;
      let command = button.dataset.command;
      if (command.includes("<")) {
        const request = window.prompt(command + "에 사용할 요청을 입력하세요.");
        if (!request) return;
        command = command.replace(/<[^>]+>/, request);
      }
      await runDashboardCommand(command, document.getElementById("commandOutput"));
    });

    document.querySelector(".tabs").addEventListener("click", event => {
      const button = event.target.closest("button[data-tab]");
      if (!button) return;
      document.querySelectorAll(".tab").forEach(row => row.classList.toggle("active", row === button));
      document.querySelectorAll(".tab-panel").forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
      history.replaceState(null, "", "#" + button.dataset.tab);
    });
    const initialTab = location.hash.slice(1);
    if (initialTab) document.querySelector('.tab[data-tab="' + CSS.escape(initialTab) + '"]')?.click();

    document.querySelector(".quick-actions")?.addEventListener("click", async event => {
      const button = event.target.closest("button[data-quick]");
      if (button) await runDashboardCommand(button.dataset.quick, document.getElementById("quickOutput"));
    });

    document.getElementById("inboxForm").addEventListener("submit", async event => {
      event.preventDefault();
      const input = document.getElementById("inboxText");
      const text = input.value.trim();
      if (!text) return;
      await runDashboardCommand("/inbox add " + document.getElementById("inboxType").value + " " + text, document.getElementById("quickOutput"));
      input.value = "";
      await loadDashboard();
    });
    document.getElementById("inbox").addEventListener("click", async event => {
      const button = event.target.closest("button[data-inbox-action]");
      if (!button) return;
      const id = button.closest("[data-inbox-id]").dataset.inboxId;
      await runDashboardCommand("/" + button.dataset.inboxAction + " " + id, document.getElementById("quickOutput"));
      await loadDashboard();
    });

    document.getElementById("preferenceForm").addEventListener("submit", async event => {
      event.preventDefault();
      const input = document.getElementById("preferenceText");
      const text = input.value.trim();
      if (!text) return;
      await runDashboardCommand("/preference add " + document.getElementById("preferenceType").value + " " + text, document.getElementById("commandOutput"));
      input.value = "";
      await loadDashboard();
    });

    document.getElementById("askForm").addEventListener("submit", async event => {
      event.preventDefault();
      const request = document.getElementById("askInput").value.trim();
      const button = document.getElementById("askSubmit");
      if (!request || button.disabled) return;
      button.disabled = true;
      try {
        const command = (document.getElementById("askResearch").checked ? "/lab now " : "/ask ") + request;
        await runDashboardCommand(command, document.getElementById("askOutput"), { deliverToTelegram: document.getElementById("askTelegram")?.checked !== false });
        await loadDashboard();
      } finally { button.disabled = false; }
    });
    document.getElementById("newResearch").addEventListener("click", () => {
      document.querySelector('.tab[data-tab="today"]').click();
      document.getElementById("askResearch").checked = true;
      document.getElementById("askInput").focus();
    });
    document.getElementById("experiments").addEventListener("click", async event => {
      const button = event.target.closest("button[data-lab-action]");
      if (!button) return;
      const id = button.closest("[data-lab-id]").dataset.labId;
      let command = "/lab " + button.dataset.labAction + " " + id;
      if (["practice", "implement", "research"].includes(button.dataset.labAction)) {
        const selection = window.prompt("보고서에서 진행할 항목과 원하는 결과를 입력하세요. 등록하면 다음 실행 순서에 시작합니다.");
        if (!selection?.trim()) return;
        command += " " + selection.trim();
      }
      button.disabled = true;
      await runDashboardCommand(command, document.getElementById("labOutput"));
      button.disabled = false;
      await loadDashboard();
    });

    document.getElementById("runRepoChecks").addEventListener("click", async event => {
      const button = event.currentTarget;
      const target = document.getElementById("repoChecks");
      button.disabled = true;
      button.textContent = "점검 중…";
      try {
        const response = await fetch("/api/repo-checks", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "점검 실패");
        target.innerHTML = renderRepoChecks(data.repoChecks);
      } catch (error) {
        target.innerHTML = '<div class="empty">' + escapeText(error.message) + '</div>';
      } finally {
        button.disabled = false;
        button.textContent = "지금 점검";
      }
    });

    async function runDashboardCommand(command, output, options) {
      output.hidden = false;
      output.textContent = command.replace(/^\\/ask\\s+/, "") + " 실행 중…";
      try {
        const response = await fetch("/api/command", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ command }, options || {})),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "명령 실행 실패");
        output.dataset.jobId = data.jobId || "";
        output.textContent = data.messages.join("\\n\\n") || (data.jobId ? "작업 " + data.jobId + " 실행 중…" : "완료");
      } catch (error) { output.textContent = error.message; }
    }

    async function postAction(url, body) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "처리하지 못했습니다.");
      return data;
    }
    async function handleScheduleClick(event) {
      const button = event.target.closest("button[data-schedule-action]");
      if (button) {
        const action = button.dataset.scheduleAction;
        const id = button.closest("[data-schedule-id]").dataset.scheduleId;
        if (action === "remove" && !window.confirm("이 예약 작업을 삭제할까요?")) return;
        button.disabled = true;
        try { await postAction("/api/schedule-action", { id, action }); await loadDashboard(); }
        catch (error) { window.alert(error.message); }
        finally { button.disabled = false; }
        return;
      }
      const pauseButton = event.target.closest("button[data-usage-pause]");
      if (!pauseButton) return;
      if (!window.confirm("AI 예약 작업 일시 중지를 해제할까요? 한도가 남아 있지 않으면 다시 실패할 수 있습니다.")) return;
      pauseButton.disabled = true;
      try { await postAction("/api/usage-pause", { action: "clear" }); await loadDashboard(); }
      catch (error) { window.alert(error.message); }
      finally { pauseButton.disabled = false; }
    }
    document.getElementById("schedules").addEventListener("click", handleScheduleClick);
    document.getElementById("statusItems").addEventListener("click", handleScheduleClick);
    document.getElementById("briefings").addEventListener("click", async event => {
      const button = event.target.closest("button[data-briefing-action]");
      if (!button) return;
      const id = button.closest("[data-briefing-id]").dataset.briefingId;
      const action = button.dataset.briefingAction;
      if (action === "resend" && !window.confirm("이 브리핑을 텔레그램으로 다시 보낼까요?")) return;
      button.disabled = true;
      try {
        if (action === "resend") {
          await postAction("/api/briefing-resend", { id });
          button.textContent = "보냄";
        } else {
          await postAction("/api/briefing-feedback", { id, feedback: action });
          await loadDashboard();
        }
      } catch (error) { window.alert(error.message); }
      finally { button.disabled = false; }
    });
    document.getElementById("repoChecks").addEventListener("click", async event => {
      const button = event.target.closest("button[data-repo-recheck]");
      if (!button) return;
      button.disabled = true;
      button.textContent = "재점검 중…";
      try { await postAction("/api/repo-check", { name: button.dataset.repoRecheck }); }
      catch (error) { window.alert(error.message); button.disabled = false; button.textContent = "재점검"; }
    });
    document.addEventListener("click", event => {
      const button = event.target.closest?.("[data-job-result]");
      if (!button) return;
      event.preventDefault();
      openJobResult(button.dataset.jobResult);
    });

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return "-";
      return (bytes / 1073741824).toFixed(1) + " GB";
    }

    function renderJobs(rows, emptyText) {
      if (!rows.length) return '<div class="empty">' + escapeText(emptyText) + '</div>';
      const kinds = { chat: "대화", delegate: "위임", scheduled: "예약", "scheduled-local": "로컬 브리핑", emoticon: "이모티콘" };
      return '<table><thead><tr><th style="width:96px">작업</th><th style="width:86px">종류</th><th style="width:104px">상태</th><th style="width:120px">엔진</th><th>요청</th><th style="width:104px">시각</th></tr></thead><tbody>' +
        rows.map(row => '<tr><td>' + escapeText(row.jobId) + (row.hasResult ? '<br><button type="button" class="action" data-job-result="' + escapeText(row.jobId) + '">결과 보기</button>' : '') + '</td><td>' + escapeText(kinds[row.kind] || row.kind) + '</td><td>' + badge(row.status) + '</td><td>' + renderEngine(row) + '</td><td class="prompt">' + escapeText(row.prompt) + '</td><td>' + escapeText(formatTime(row.finishedAt || row.startedAt)) + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function renderEngine(row) {
      if (!row.provider) return '<span class="meta">-</span>';
      const name = row.provider === "claude" ? "Claude" : "Codex";
      return escapeText(name) + (row.model ? '<br><span class="meta">' + escapeText(row.model) + '</span>' : '') +
        (row.fallbackReason ? '<br><span class="meta" title="' + escapeText(row.fallbackReason) + '">폴백 · ' + escapeText(row.fallbackReason) + '</span>' : '');
    }

    function renderProcesses(rows) {
      if (!rows.length) return '<div class="empty">관리 중인 백그라운드 프로세스가 없습니다.</div>';
      return '<table><thead><tr><th>프로세스</th><th>상태</th><th>명령</th></tr></thead><tbody>' +
        rows.map(row => '<tr><td>' + escapeText(row.processId) + '<br><span class="meta">PID ' + escapeText(row.pid ?? "?") + " | " + escapeText(row.age) + '</span></td><td>' + badge(row.status) + '</td><td class="prompt">' + escapeText(row.command) + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function renderSchedules(rows, withActions) {
      if (!rows.length) return '<div class="empty">예약 작업이 없습니다.</div>';
      const actions = '<div class="lab-actions"><button type="button" data-schedule-action="run">지금 실행</button><button type="button" data-schedule-action="skip">한 번 건너뛰기</button><button type="button" data-schedule-action="remove">삭제</button></div>';
      return '<div class="simple-list">' + rows.map(row => '<div class="simple-row" data-schedule-id="' + escapeText(row.id) + '"><strong>' + escapeText(row.name || scheduleName(row.prompt)) + '</strong><div>' + escapeText(row.nextRunLabel || formatTime(row.nextRunAt)) + '</div><div class="meta">' + escapeText(row.repeatLabel || scheduleRepeat(row.repeat)) + (row.failureCount ? ' · 실패 ' + escapeText(row.failureCount) + '회' : '') + '</div>' +
        (row.lastError ? '<div class="meta">최근 오류: ' + escapeText(row.lastError) + '</div>' : '') + (withActions ? actions : '') + '</div>').join("") + '</div>';
    }

    function scheduleName(prompt) {
      const value = String(prompt || "");
      if (value.includes("MORNING_BRIEF")) return "모닝 브리핑";
      if (value.includes("EVENING_BRIEF")) return "이브닝 브리핑";
      if (value.includes("WEEKLY_REVIEW")) return "주간 리뷰";
      if (value.includes("AI_TREND_BRIEF")) return "AI 트렌드";
      if (value.includes("ENGLISH_STUDY")) return "영어 학습";
      if (value.includes("AI_WORKMATE_REMINDER")) return "개인 알림 · " + value.replace(/^\\[AI_WORKMATE_REMINDER\\]\\s*/, "").slice(0, 42);
      if (value.includes("AI_WORKMATE_NATURAL_SCHEDULE")) {
        const request = value.match(/요청:\\s*([^\\n]+)/)?.[1] || "예약된 AI 작업";
        return "AI 예약 · " + request.slice(0, 42);
      }
      return value.replace(/^\\[[^\\]]+\\]\\s*/, "").slice(0, 60) || "예약 작업";
    }
    function scheduleRepeat(value) {
      const match = String(value || "").match(/^every (\\d+)d (\\d+)h$/);
      if (match && match[1] === "1" && match[2] === "0") return "매일";
      if (match && match[1] === "7" && match[2] === "0") return "매주";
      return value === "one-time" ? "한 번" : value;
    }

    function badge(status) {
      return '<span class="pill ' + escapeText(status) + '">' + escapeText(statusLabel(status)) + '</span>';
    }

    function escapeText(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    let markdownModule = null;
    let viewerReturnFocus = null;
    function showViewer(name, downloadUrl) {
      const viewer = document.getElementById("docViewer");
      const body = document.getElementById("docViewerBody");
      const download = document.getElementById("docViewerDownload");
      viewerReturnFocus = document.activeElement;
      document.getElementById("docViewerTitle").textContent = name;
      download.hidden = !downloadUrl;
      if (downloadUrl) download.href = downloadUrl;
      body.innerHTML = '<div class="empty">불러오는 중…</div>';
      viewer.hidden = false;
      document.body.style.overflow = "hidden";
      if (!history.state?.docViewer) history.pushState({ docViewer: true }, "", location.href);
      document.getElementById("docViewerClose").focus();
      return body;
    }
    async function openJobResult(jobId) {
      const body = showViewer("작업 결과 · " + jobId, null);
      try {
        const response = await fetch("/api/job-result?id=" + encodeURIComponent(jobId), { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "작업 결과를 찾을 수 없습니다.");
        markdownModule ??= await import("/assets/markdown-render.js");
        body.innerHTML = '<p class="meta">' + escapeText(statusLabel(data.job.status) + " · " + formatTime(data.job.finishedAt) + " · " + data.job.prompt) + '</p>' + markdownModule.renderMarkdown(data.job.summary);
        body.scrollTop = 0;
      } catch (error) {
        body.innerHTML = '<div class="empty">' + escapeText(error.message) + '</div>';
      }
    }
    async function openDocumentViewer(url, name) {
      const body = showViewer(name, url + "&download=1");
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("문서를 찾을 수 없습니다.");
        const text = await response.text();
        if (/\.md$/i.test(name)) {
          markdownModule ??= await import("/assets/markdown-render.js");
          body.innerHTML = markdownModule.renderMarkdown(text);
        } else {
          body.innerHTML = '<pre>' + escapeText(text) + '</pre>';
        }
        body.scrollTop = 0;
      } catch (error) {
        body.innerHTML = '<div class="empty">' + escapeText(error.message) + '</div>';
      }
    }
    function closeDocumentViewer({ fromHistory = false } = {}) {
      const viewer = document.getElementById("docViewer");
      if (viewer.hidden) return;
      viewer.hidden = true;
      document.body.style.overflow = "";
      if (!fromHistory && history.state?.docViewer) history.back();
      viewerReturnFocus?.focus?.();
    }
    document.addEventListener("click", event => {
      const button = event.target.closest?.("[data-doc-view]");
      if (!button) return;
      event.preventDefault();
      openDocumentViewer(button.dataset.docView, button.dataset.docName);
    });
    document.getElementById("docViewerClose").addEventListener("click", () => closeDocumentViewer());
    document.getElementById("docViewer").addEventListener("click", event => { if (event.target.id === "docViewer") closeDocumentViewer(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") closeDocumentViewer(); });
    window.addEventListener("popstate", () => closeDocumentViewer({ fromHistory: true }));

    Promise.all([loadDashboard(), loadN8n(), loadTrading(), loadPortfolio()]).catch(error => {
      document.getElementById("services").innerHTML = '<div class="empty">' + escapeText(error.message) + '</div>';
    });
${EMOTICON_CLIENT_JS}
    setInterval(loadDashboard, 5000);
    setInterval(loadN8n, 30000);
    setInterval(loadTrading, 30000);
    setInterval(loadPortfolio, 300000);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}
