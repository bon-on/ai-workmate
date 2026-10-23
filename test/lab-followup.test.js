import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { handleMessage } from "../src/router.js";
import { PersonalOpsStore } from "../src/personal-ops-store.js";
import { renderDashboardHtml, executeDashboardCommand } from "../src/dashboard-server.js";

const config = { allowedChatIds: ["100"], allowedUserIds: ["200"] };

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lab-followup-"));
  tempDirs.push(directory);
  const personalOps = new PersonalOpsStore(path.join(directory, "state.json"));
  const sent = [];
  const scheduled = [];
  const workspaceLookups = [];
  const schedules = { async add(input) { scheduled.push(input); return { id: `sc-${scheduled.length}`, ...input }; } };
  const workspaces = {
    getWorkspaceByAlias: alias => { workspaceLookups.push(alias); return { alias, path: "/tmp" }; },
    getActiveWorkspace: () => ({ alias: "active-other", path: "/tmp" }),
  };
  const run = text => handleMessage({
    message: { chat: { id: 100 }, from: { id: 200 }, text },
    config, telegram: { async sendMessage(_c, t) { sent.push(t); } }, workspaces, schedules, personalOps,
  });
  async function completed(topic = "원본", result = "참고 보고서", workspaceAlias = "original") {
    const row = await personalOps.addExperiment({ chatId: 100, topic, workspaceAlias });
    await personalOps.recordExperimentResult({ chatId: 100, id: row.id, job: { status: "completed", summary: result } });
    return row;
  }
  return { directory, personalOps, sent, scheduled, workspaceLookups, run, completed };
}

test("lab read through the router keeps the result listed but no longer counts it as new", async () => {
  const { personalOps, run, completed, sent } = await setup();
  const row = await completed();
  assert.equal(personalOps.summary(100).readyExperiments, 1);
  await run(`/lab read ${row.id}`);
  assert.match(sent.at(-1), /읽음 처리/);
  assert.equal(personalOps.summary(100).readyExperiments, 0);
  assert.deepEqual(personalOps.listExperiments(100).map(r => r.id), [row.id]);
  assert.equal(personalOps.listExperiments(100)[0].status, "completed");
  assert.ok(personalOps.listExperiments(100)[0].readAt);
});

for (const action of ["practice", "research", "implement"]) {
  test(`lab ${action} follow-up requires a selected topic and links to the original report`, async () => {
    const { personalOps, run, completed, scheduled } = await setup();
    const parent = await completed();
    await assert.rejects(run(`/lab ${action} ${parent.id}`), /구체적인 항목/);
    assert.equal(scheduled.length, 0);
    assert.equal(personalOps.listExperiments(100).length, 1);

    await run(`/lab ${action} ${parent.id} 선택한 항목 하나`);
    const child = personalOps.listExperiments(100).find(r => r.id !== parent.id);
    assert.equal(child.parentId, parent.id);
    assert.equal(child.followupKind, action);
    assert.equal(child.topic, "선택한 항목 하나");
    assert.equal(child.scheduleId, "sc-1");
    assert.match(scheduled[0].prompt, new RegExp(`AI_WORKMATE_LAB:${child.id}`));
    assert.match(scheduled[0].prompt, /선택한 작업: 선택한 항목 하나/);
  });
}

test("follow-ups reuse the original workspace and the existing scheduler for immediate one-shot runs", async () => {
  const { run, completed, scheduled, workspaceLookups } = await setup("원본", "참고 보고서", "original-ws");
  const parent = (await completed("원본", "참고 보고서", "original-ws"));
  const before = Date.now();
  await run(`/lab research ${parent.id} 더 조사`);
  assert.deepEqual(workspaceLookups, ["original-ws"]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].workspaceAlias, "original-ws");
  assert.notEqual(scheduled[0].workspaceAlias, "active-other");
  assert.equal(scheduled[0].intervalMs, null);
  const due = Date.parse(scheduled[0].nextRunAt);
  assert.ok(due >= before - 1000 && due <= Date.now() + 1000);
});

test("archived results stay accessible and restore without deleting files", async () => {
  const { directory, personalOps, run, completed, sent } = await setup();
  const row = await completed("원본", "보고서 본문");
  const file = path.join(directory, "report.md");
  await fs.writeFile(file, "keep me");
  await personalOps.recordExperimentResult({ chatId: 100, id: row.id, job: { status: "completed", summary: "보고서 본문", artifacts: [file] } });
  await run(`/lab archive ${row.id}`);
  assert.equal(personalOps.listExperiments(100).length, 0);
  const archived = personalOps.listExperiments(100, { includeArchived: true });
  assert.equal(archived.length, 1);
  assert.equal(archived[0].status, "archived");
  assert.equal(archived[0].result, "보고서 본문");
  await run(`/lab restore ${row.id}`);
  assert.match(sent.at(-1), /복원/);
  const [restored] = personalOps.listExperiments(100);
  assert.equal(restored.id, row.id);
  assert.equal(restored.status, "completed");
  assert.equal(restored.result, "보고서 본문");
  assert.deepEqual(restored.artifacts, [file]);
  assert.equal(await fs.readFile(file, "utf8"), "keep me");
  await assert.rejects(run(`/lab restore ${row.id}`), /보관된 결과만/);
});

test("active queued jobs cannot be archived or discarded", async () => {
  const { personalOps, run } = await setup();
  const queued = await personalOps.addExperiment({ chatId: 100, topic: "대기", workspaceAlias: "w" });
  for (const action of ["archive", "discard"]) {
    await assert.rejects(run(`/lab ${action} ${queued.id}`), /대기·실행 중인 작업은 보관할 수 없습니다/);
    assert.equal(personalOps.listExperiments(100)[0].status, "queued");
  }
  // running is a dashboard/runtime status: the guard also covers it
  personalOps.experiments.get(queued.id).status = "running";
  await assert.rejects(run(`/lab archive ${queued.id}`), /보관할 수 없습니다/);
  assert.equal(personalOps.listExperiments(100)[0].status, "running");
});

test("emitted dashboard polling preserves expanded results and scroll position", () => {
  const script = renderDashboardHtml({ allowedChatIds: ["100"] }).match(/<script>([\s\S]*?)<\/script>/)[1];
  const pick = (name, next) => script.slice(script.indexOf(`    function ${name}(`), script.indexOf(`    function ${next}(`));
  const rowsData = [{ id: "lab-1", topic: "주제", status: "completed", result: "본문", updatedAt: "t", artifacts: [] }];
  const makeRow = (id, open, scrollTop) => ({ dataset: { labId: id }, details: { open }, result: { scrollTop },
    querySelector(sel) { return sel === "details" ? this.details : this.result; } });
  let rows = [makeRow("lab-1", true, 42)];
  const container = {
    querySelectorAll: () => rows,
    set innerHTML(value) { this.html = value; rows = [makeRow("lab-1", false, 0)]; },
  };
  const context = vm.createContext({
    document: { getElementById: () => container }, badge: String, formatTime: String,
    renderDocumentLinks: () => "", documentsForText: () => [],
  });
  vm.runInContext(script.match(/    function escapeText\(value\) \{[\s\S]*?\n    \}\n/)[0] + pick("updateExperiments", "renderExperiments") + pick("renderExperiments", "renderPreferences"), context);
  context.updateExperiments(rowsData);
  assert.match(container.html, /data-lab-id="lab-1"/);
  assert.equal(rows[0].details.open, true);
  assert.equal(rows[0].result.scrollTop, 42);
  // an unchanged poll must not rebuild the DOM at all
  const rendered = container.html;
  rows = [makeRow("lab-1", true, 7)];
  container.html = undefined;
  context.updateExperiments(rowsData);
  assert.equal(container.html, undefined);
  assert.equal(rendered, container.renderedExperiments);
  // a collapsed result stays collapsed
  rows = [makeRow("lab-1", false, 0)];
  context.updateExperiments([{ ...rowsData[0], result: "변경됨" }]);
  assert.equal(rows[0].details.open, false);
});

test("dashboard research requests are due immediately while explicit schedules stay unchanged", async () => {
  const run = async command => {
    const scheduled = [];
    await executeDashboardCommand({
      command, config, telegram: {}, jobs: {}, processes: {}, sessions: {},
      workspaces: { getActiveWorkspace: () => ({ alias: "default", path: "/tmp" }) },
      schedules: { async add(input) { scheduled.push(input); return { id: "sc-1" }; } },
      personalOps: { async addExperiment(i) { return { id: "lab-x", ...i }; }, async linkExperimentSchedule() {} },
    });
    return scheduled[0];
  };
  const before = Date.now();
  const now = await run("/lab now 새 주제");
  const due = Date.parse(now.nextRunAt);
  assert.ok(due >= before - 1000 && due <= Date.now() + 1000);
  const tonight = await run("/lab tonight 새 주제");
  assert.equal(new Date(tonight.nextRunAt).getHours(), 23);
  assert.equal(new Date(tonight.nextRunAt).getMinutes(), 0);
  assert.equal(tonight.intervalMs, null);
});
