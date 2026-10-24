import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildDashboardSnapshot, parseMemoryPressureFreePercent } from "../src/dashboard.js";
import { renderDashboardHtml, executeDashboardCommand } from "../src/dashboard-server.js";

test("dashboard completes inbox items without attaching an unrelated running job", async () => {
  let updated;
  const result = await executeDashboardCommand({
    command: "/done in-test",
    config: { allowedChatIds: ["100"], allowedUserIds: ["200"] },
    telegram: {}, jobs: { getActiveJob: () => ({ jobId: "unrelated" }) },
    workspaces: { getActiveWorkspace: () => ({ alias: "default", path: "/tmp" }) },
    personalOps: { async updateInbox(input) { updated = input; return { id: input.id }; } },
  });
  assert.equal(updated.id, "in-test");
  assert.equal(updated.status, "done");
  assert.equal(result.jobId, null);
  assert.match(result.messages[0], /Updated in-test/);
});

test("rendered dashboard script parses and formats schedule labels", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  const functions = script.slice(script.indexOf("    function scheduleName("), script.indexOf("    function badge("));
  const context = vm.createContext({});
  vm.runInContext(functions, context);
  assert.equal(context.scheduleName("[AI_WORKMATE_REMINDER]\n약 복용"), "개인 알림 · 약 복용");
  assert.equal(context.scheduleName("[AI_WORKMATE_NATURAL_SCHEDULE]\n설명\n요청: AI 뉴스"), "AI 예약 · AI 뉴스");
  assert.equal(context.scheduleName("[CUSTOM] 확인"), "확인");
  assert.equal(context.scheduleName("[AI_WORKMATE_ENGLISH_STUDY_V1]\n영어 학습: 뉴스 기사 단어·예문·복습 (로컬 생성)"), "영어 학습");
  assert.equal(context.scheduleRepeat("every 1d 0h"), "매일");
});

test("parseMemoryPressureFreePercent reads the macOS free percentage", () => {
  assert.equal(parseMemoryPressureFreePercent("System-wide memory free percentage: 74%\n"), 74);
  assert.equal(parseMemoryPressureFreePercent("unavailable"), null);
  assert.equal(parseMemoryPressureFreePercent("System-wide memory free percentage: 101%"), null);
});

test("dashboard separates operational failures from decisions and requests immediate research", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.match(html, /\/lab now /);
  assert.doesNotMatch(html, /오늘 밤 AI에게 맡기기|\/lab tonight|최근 24시간 n8n 실패/);
  assert.match(html, /오류 상세/);
  assert.match(html, /최근 실패한 자동화 · 최대 5건/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fn = script.slice(script.indexOf("    function renderOperations("), script.indexOf("    function ", script.indexOf("    function renderOperations(") + 15));
  const elements = {};
  const context = vm.createContext({ document: { getElementById: id => elements[id] ||= {} }, metric: () => "", escapeText: x => x, formatInteger: String, formatTime: String });
  vm.runInContext(fn, context);
  context.renderOperations({ experiments: [{ status: "completed", topic: "연구 결과" }], services: [{ status: "offline", name: "n8n" }] }, { ok: true, failures: [{ startedAt: new Date().toISOString() }] }, {});
  assert.match(elements.attention.innerHTML, /연구 결과/);
  assert.doesNotMatch(elements.attention.innerHTML, /n8n|offline|실패/);
});

test("dashboard truncates fractional won amounts while leaving rates separate", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.match(html, /Math\.trunc\(number\)/);
  assert.match(html, /maximumFractionDigits: 0/);
  assert.match(html, /number\.toFixed\(2\) \+ "%"/);
});

test("unified request form defaults to general work and optionally records research", async () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.equal((html.match(/id="askForm"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="labForm"|id="labQuickForm"/);
  assert.match(html, /id="askResearch" type="checkbox">/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const block = script.slice(script.indexOf('    document.getElementById("askForm").addEventListener'), script.indexOf('    document.getElementById("experiments").addEventListener'));
  const handlers = {};
  const nodes = { askInput: { value: "  평가 방법  ", focus() { this.focused = true; } }, askSubmit: { disabled: false }, askResearch: { checked: false }, askOutput: {} };
  for (const id of ["askForm", "newResearch"]) nodes[id] = { addEventListener: (event, fn) => handlers[id] = fn };
  const commands = [];
  let selectedToday = false;
  const context = vm.createContext({ document: { getElementById: id => nodes[id], querySelector: () => ({ click() { selectedToday = true; } }) }, runDashboardCommand: async command => commands.push(command), loadDashboard: async () => {} });
  vm.runInContext(block, context);
  await handlers.askForm({ preventDefault() {} });
  assert.deepEqual(commands, ["/ask 평가 방법"]);
  handlers.newResearch();
  assert.equal(selectedToday, true);
  assert.equal(nodes.askInput.focused, true);
  await handlers.askForm({ preventDefault() {} });
  assert.equal(commands[1], "/lab now 평가 방법");
  assert.equal(nodes.askSubmit.disabled, false);
  nodes.askInput.value = " ";
  await handlers.askForm({ preventDefault() {} });
  assert.equal(commands.length, 2);
});

test("emitted limit card renders remaining percentage, KST reset and unavailable states", () => {
  const script = renderDashboardHtml({ allowedChatIds: ["100"] }).match(/<script>([\s\S]*?)<\/script>/)[1];
  const fn = script.slice(script.indexOf("    function renderCodexLimits("), script.indexOf("    function render(data)"));
  const target = {};
  const context = vm.createContext({ document: { getElementById: () => target }, metric: (label, value) => label + ": " + value + "\n", formatTime: String });
  vm.runInContext(fn, context);
  context.renderCodexLimits({ status: "available", fiveHour: { remainingPercent: 21, usedPercent: 79, resetsAt: "2099-01-01T00:00:00Z" } });
  assert.match(target.innerHTML, /21%/);
  assert.match(target.innerHTML, /09:00 KST/);
  assert.match(target.innerHTML, /주간 · 7일/);
  assert.match(target.innerHTML, /한도 조회 불가/);
  context.renderCodexLimits({ status: "available", fiveHour: { remainingPercent: 21, usedPercent: 79 }, weekly: { remainingPercent: 8, usedPercent: 92, resetsAt: "2099-01-02T00:00:00Z" } });
  assert.match(target.innerHTML, /21% 남음/);
  assert.match(target.innerHTML, /8% 남음/);
  assert.match(target.innerHTML, /codex-limit-card low/);
  assert.match(target.innerHTML, /value="8"/);
  assert.match(target.innerHTML, /01. 02. 09:00 KST/);
  context.renderCodexLimits({ status: "available", weekly: { remainingPercent: 0, usedPercent: 100 } });
  assert.match(target.innerHTML, /0% 남음/);
  assert.match(target.innerHTML, /codex-limit-card depleted/);

  context.renderCodexLimits({ status: "available", fiveHour: { remainingPercent: 21, usedPercent: 79, resetsAt: "2000-01-01T00:00:00Z" } });
  assert.match(target.innerHTML, /100% 남음/);
  assert.match(target.innerHTML, /리셋됨 · 다음 사용 때 새 창 시작/);
  assert.doesNotMatch(target.innerHTML, /21%|갱신 대기/);
  context.renderCodexLimits({ status: "available", fiveHour: { remainingPercent: 100, usedPercent: 0, resetsAt: null, idle: true } });
  assert.match(target.innerHTML, /100% 남음/);
  assert.match(target.innerHTML, /리셋됨/);
  context.renderCodexLimits({ status: "unavailable" });
  assert.match(target.innerHTML, /조회 불가/);
});

test("emitted dashboard renders Claude limits into their own section with the fallback notice", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.match(html, /<h2>Claude 사용 한도<\/h2><div id="claudeLimits"/);
  // Limits live only on the Today tab, not above every tab.
  const todayPanel = html.match(/<div class="tab-panel" data-panel="today">([\s\S]*?)<div class="tab-panel" data-panel="lab"/)[1];
  assert.match(todayPanel, /id="claudeLimits"/);
  assert.match(todayPanel, /id="codexLimits"/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(script, /renderCodexLimits\(data\.claudeRateLimits, "claudeLimits", "Claude 작업과 Claude Code 세션 기준"\)/);
  const fn = script.slice(script.indexOf("    function renderCodexLimits("), script.indexOf("    function render(data)"));
  const targets = { claudeLimits: {}, codexLimits: {} };
  const context = vm.createContext({ document: { getElementById: (id) => targets[id] }, formatTime: String });
  vm.runInContext(fn, context);
  context.renderCodexLimits({ status: "available", fiveHour: { remainingPercent: 0, usedPercent: 100, resetsAt: "2099-01-01T00:00:00Z" }, exhaustedUntil: "2099-01-01T00:00:00Z", checkedAt: "c" }, "claudeLimits", "Claude 작업과 Claude Code 세션 기준");
  assert.match(targets.claudeLimits.innerHTML, /Codex로 실행/);
  assert.match(targets.claudeLimits.innerHTML, /Claude 작업과 Claude Code 세션 기준 · 마지막 조회 c/);
  assert.equal(targets.codexLimits.innerHTML, undefined);
  context.renderCodexLimits(null, "claudeLimits", "Claude 작업과 Claude Code 세션 기준");
  assert.match(targets.claudeLimits.innerHTML, /한도 조회 불가/);
  assert.doesNotMatch(targets.claudeLimits.innerHTML, /Codex로 실행/);
});

test("emitted job table shows the engine, model and fallback reason", () => {
  const script = renderDashboardHtml({ allowedChatIds: ["100"] }).match(/<script>([\s\S]*?)<\/script>/)[1];
  const pick = (name, next) => script.slice(script.indexOf(`    function ${name}(`), script.indexOf(`    function ${next}(`));
  const context = vm.createContext({ badge: String });
  const escapeText = script.match(/    function escapeText\(value\) \{[\s\S]*?\n    \}\n/)[0];
  vm.runInContext(pick("renderJobs", "renderEngine") + pick("renderEngine", "renderProcesses") + escapeText, context);
  const html = context.renderJobs([
    { jobId: "a", kind: "chat", status: "completed", provider: "claude", model: "sonnet", prompt: "p", age: "1m" },
    { jobId: "b", kind: "chat", status: "completed", provider: "codex", fallbackReason: "Claude <limit>", prompt: "p", age: "1m" },
    { jobId: "c", kind: "chat", status: "completed", prompt: "p", age: "1m" },
  ], "none");
  assert.match(html, /<th style="width:120px">Engine<\/th>/);
  assert.match(html, /Claude<br><span class="meta">sonnet<\/span>/);
  assert.match(html, /폴백 · Claude &lt;limit&gt;/);
  assert.match(html, /<td><span class="meta">-<\/span><\/td>/);
});

test("dashboard text labels the briefing score as a format check, not factual quality", async () => {
  const { formatDashboard } = await import("../src/dashboard.js");
  const text = formatDashboard({
    chatId: "100", jobs: { listJobs: () => [], getActiveJob: () => null, config: {} },
    processes: { list: () => [] }, schedules: { list: () => [] },
    workspaces: { getActiveWorkspace: () => null }, personalOps: null,
  });
  const line = text.split("\n").find((row) => row.startsWith("Briefing"));
  assert.match(line, /^Briefing format check/);
  assert.match(line, /format only, factual accuracy not evaluated/);
  assert.match(line, /\/100 format score/);
  assert.doesNotMatch(text, /Briefing quality/);
});

test("browser dashboard labels the briefing score as a format check", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.match(html, /브리핑 형식 검사 · 사실 정확성 미평가/);
  assert.doesNotMatch(html, /브리핑 품질/);
});

test("emitted trading metrics open the stock list for orders, trades and candidates", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.match(html, /<div id="trading" class="trading-grid">[\s\S]*?<\/div><div id="tradingDetail"><\/div>/);
  assert.match(html, /\.mini strong \{[^}]*overflow-wrap: anywhere/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fn = script.slice(script.indexOf("    let tradingDetailKey = null;"), script.indexOf("    function metric(label, value)"));
  const nodes = {};
  let clickHandler = null;
  const element = (id) => nodes[id] ??= { innerHTML: "", addEventListener: (type, handler) => { if (id === "trading") clickHandler = handler; } };
  const latest = { trading: null };
  const context = vm.createContext({
    document: { getElementById: element }, latest, escapeText: (value) => String(value),
    formatWon: (value) => value + "원", formatSignedWon: (value) => (value > 0 ? "+" : "") + value + "원", formatRate: (value) => value.toFixed(2) + "%",
    renderTrading: (data) => context.renderTradingDetail(data.trading),
  });
  vm.runInContext(fn, context);
  const row = {
    orderList: [{ symbol: "468530", name: "프로티나", ts: "2026-10-22T01:01:17Z", side: "매수", quantity: 22, price: 45350, status: "거절", message: "quote_error" }],
    tradeList: [], candidateList: [{ symbol: "900110", name: "딥커머스", source: "등락률순위", score: 0.55, changeRate: 0.36, price: 5580 }],
  };
  latest.trading = { ok: true, trading: row };
  assert.match(context.metricButton("orders", "주문", "1건"), /data-trading-detail="orders"[\s\S]*종목 보기/);
  const click = (key) => clickHandler({ target: { closest: () => ({ dataset: { tradingDetail: key } }) } });
  click("orders");
  assert.match(nodes.tradingDetail.innerHTML, /주문 종목 · 1건 표시/);
  assert.match(nodes.tradingDetail.innerHTML, /프로티나[\s\S]*468530[\s\S]*quote_error/);
  click("candidates");
  assert.match(nodes.tradingDetail.innerHTML, /딥커머스[\s\S]*등락률순위/);
  click("trades");
  assert.match(nodes.tradingDetail.innerHTML, /청산 종목이 없습니다/);
  click("trades");
  assert.equal(nodes.tradingDetail.innerHTML, "");
});

test("recent AI jobs include runs persisted before the bridge restarted", () => {
  const now = new Date("2026-10-22T01:00:00Z");
  const snapshot = buildDashboardSnapshot({
    chatId: "1", now,
    jobs: { listJobs: () => [{ jobId: "live1", kind: "chat", status: "running", startedAt: "2026-10-22T00:59:00Z", prompt: "지금 작업", provider: "claude" }], getActiveJob: () => null },
    processes: { list: () => [] },
    schedules: { list: () => [] },
    workspaces: { getActiveWorkspace: () => ({ alias: "default" }), list: () => [] },
    personalOps: { listRecentRuns: () => [
      { id: "live1", kind: "chat", status: "completed", finishedAt: "2026-10-22T00:59:30Z", source: "claude" },
      { id: "old1", kind: "scheduled", status: "completed", startedAt: "2026-10-21T03:00:00Z", finishedAt: "2026-10-21T03:02:00Z", source: "codex", model: "gpt", title: "개인 개발 레이더를 작성하세요", fallbackReason: "Claude 한도" },
    ] },
  });
  assert.deepEqual(snapshot.recentJobs.map((job) => job.jobId), ["live1", "old1"]);
  assert.equal(snapshot.recentJobs[1].prompt, "개인 개발 레이더를 작성하세요");
  assert.equal(snapshot.recentJobs[1].provider, "codex");
  assert.equal(snapshot.recentJobs[1].persisted, true);
});

test("emitted dashboard groups repeated automation runs, previews briefings and hides unused outputs", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.match(html, /<pre id="quickOutput" class="command-output" hidden>/);
  assert.match(html, /<pre id="labOutput" class="command-output" hidden>/);
  assert.match(html, /<div id="docViewer" class="doc-viewer" hidden>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({});
  vm.runInContext(script.slice(script.indexOf("    function groupExecutions("), script.indexOf("    function renderTrading(")), context);
  vm.runInContext(script.slice(script.indexOf("    function briefingPreview("), script.indexOf("    function renderInbox(")), context);
  const groups = context.groupExecutions([
    { workflowName: "KIS", status: "success", startedAt: "2026-10-22T01:03:00Z" },
    { workflowName: "KIS", status: "success", startedAt: "2026-10-22T01:01:00Z" },
    { workflowName: "KIS", status: "error", startedAt: "2026-10-22T00:50:00Z" },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].earliest, "2026-10-22T01:01:00Z");
  assert.equal(context.briefingPreview("☀️ 모닝\n\n🌦 날씨\n• 맑음\n📅 일정\n• 없음"), "맑음 · 없음");
});

test("Today tab orders the request form, today summary and to-do input first", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  const today = html.match(/<div class="tab-panel" data-panel="today">([\s\S]*?)<div class="tab-panel" data-panel="lab"/)[1];
  const order = ["id=\"askForm\"", "<h2>오늘</h2>", "id=\"inboxForm\"", "<h2>최근 브리핑</h2>", "id=\"claudeLimits\""].map((marker) => today.indexOf(marker));
  assert.ok(order.every((position) => position >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("emitted System tab renders repository checks and posts the run button to its own endpoint", async () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.match(html, /id="runRepoChecks"/);
  assert.match(html, /id="repoChecks"/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fn = script.slice(script.indexOf("    function renderRepoChecks("), script.indexOf("    let availableDocuments"));
  const context = vm.createContext({ escapeText: (value) => String(value).replace(/</g, "&lt;"), formatTime: String });
  vm.runInContext(fn, context);
  assert.match(context.renderRepoChecks(null), /아직 점검 기록이 없습니다/);
  const rendered = context.renderRepoChecks({ checkedAt: "t", repos: [
    { name: "app", harness: true, git: false, issues: ["공개 차단 1건 (env-file)", "<b>x</b>"] },
    { name: "lib", harness: false, git: true, issues: [] },
  ] });
  assert.match(rendered, /pill failed">확인 필요 2/);
  assert.match(rendered, /공개 차단 1건 \(env-file\)<br>&lt;b>x&lt;\/b>/);
  assert.match(rendered, /pill completed">이상 없음/);
  assert.match(rendered, /harness 없음 · git/);

  const handlerStart = script.indexOf('    document.getElementById("runRepoChecks").addEventListener');
  const handler = script.slice(handlerStart, script.indexOf("    async function runDashboardCommand"));
  const nodes = { runRepoChecks: { textContent: "지금 점검", addEventListener(event, fn) { this.click = fn; } }, repoChecks: {} };
  const requests = [];
  const handlerContext = vm.createContext({
    document: { getElementById: (id) => nodes[id] },
    renderRepoChecks: (data) => "rendered:" + data.repos.length,
    escapeText: String,
    fetch: async (url, options) => { requests.push([url, options.method]); return { ok: true, json: async () => ({ ok: true, repoChecks: { repos: [1, 2] } }) }; },
  });
  vm.runInContext(handler, handlerContext);
  await nodes.runRepoChecks.click({ currentTarget: nodes.runRepoChecks });
  assert.deepEqual(requests, [["/api/repo-checks", "POST"]]);
  assert.equal(nodes.repoChecks.innerHTML, "rendered:2");
  assert.equal(nodes.runRepoChecks.disabled, false);
  assert.equal(nodes.runRepoChecks.textContent, "지금 점검");
});
