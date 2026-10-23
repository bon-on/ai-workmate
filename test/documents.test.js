import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { ensureLabReport, listDocuments, resolveDocument, serveDocument } from "../src/documents.js";
import { renderDashboardHtml } from "../src/dashboard-server.js";
import { buildBridgePrompt } from "../src/job-manager.js";

test("documents lists legacy and organized reports, serves files and blocks traversal/symlinks", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workmate-documents-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "documents/reports/2026-10"), { recursive: true });
  await fs.mkdir(path.join(root, "out/research"), { recursive: true });
  const report = "documents/reports/2026-10/보고서.md";
  await fs.writeFile(path.join(root, report), "# 보고서\n<script>alert(1)</script>");
  await fs.writeFile(path.join(root, "out/research/old.md"), "old report");
  await fs.writeFile(path.join(root, ".env"), "secret");
  await fs.symlink(path.join(root, ".env"), path.join(root, "documents/leak.md"));
  const config = { codexWorkspace: root };
  const docs = await listDocuments(config);
  assert.equal(docs.length, 2);
  assert.ok(docs.some(d => d.path === report));
  for (const file of ["documents/../.env", "/etc/passwd", "documents/leak.md", ".env"]) await assert.rejects(resolveDocument(root, file));
  let code, headers, body;
  const response = { writeHead(c, h) { code = c; headers = h; }, end(b) { body = b; } };
  const url = new URL(docs.find(d => d.path === report).url, "http://localhost");
  await serveDocument({ method: "GET" }, response, url, config);
  assert.equal(code, 200);
  assert.equal(headers["content-type"], "text/plain; charset=utf-8");
  assert.match(body.toString(), /# 보고서/);
  url.searchParams.set("download", "1");
  await serveDocument({ method: "GET" }, response, url, config);
  assert.match(headers["content-disposition"], /^attachment/);
  url.searchParams.set("path", "documents/leak.md");
  await serveDocument({ method: "GET" }, response, url, config);
  assert.equal(code, 404);
});

test("emitted browser code adds verified document links to completed job results", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["1"] });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({ escapeText: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;') });
  vm.runInContext(script.slice(script.indexOf('    let availableDocuments ='), script.indexOf('    function renderServices(')), context);
  vm.runInContext('availableDocuments = [{name:"report.md", path:"documents/reports/report.md", absolutePath:"/workspace/documents/reports/report.md", url:"/api/document?path=documents%2Freports%2Freport.md"}]', context);
  let rendered = '';
  const output = { dataset: { jobId: "j1" }, insertAdjacentHTML(_position, html) { rendered += html; } };
  context.updateJobOutput(output, { activeJob: null, runningDelegates: [], recentJobs: [{jobId:"j1", status:"completed", summary:"작성: documents/reports/report.md"}] });
  assert.match(rendered, /data-doc-view="\/api\/document\?path=documents%2Freports%2Freport.md"[^>]*>보기</);
  assert.match(rendered, /download=1/);
  assert.equal(output.dataset.jobId, undefined);
  assert.equal(context.documentsForText("missing.md").length, 0);
});

test("bridge instructs report organization while respecting explicit locations", () => {
  const prompt = buildBridgePrompt("문서를 작성해줘");
  assert.match(prompt, /documents\/reports\/YYYY-MM/);
  assert.match(prompt, /documents\/notes\/YYYY-MM/);
  assert.match(prompt, /unless the user specifies another location/);
});

test("ensureLabReport reuses a written report and otherwise saves the summary as Markdown", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-report-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "out/research"), { recursive: true });
  await fs.writeFile(path.join(root, "out/research/2026-10-05-lab-1.md"), "# 기존");
  const experiment = { id: "lab-abc123", topic: "로컬 LLM 평가\n세부" };

  const reused = await ensureLabReport({ root, experiment, summary: "보고서: `out/research/2026-10-05-lab-1.md`" });
  assert.deepEqual(reused, { path: "out/research/2026-10-05-lab-1.md", created: false });

  const created = await ensureLabReport({ root, experiment, summary: "결론만 있음 (documents/reports/missing.md)", now: new Date("2026-10-21T16:00:00Z") });
  assert.deepEqual(created, { path: "documents/reports/2026-10/2026-10-22-lab-abc123.md", created: true });
  const text = await fs.readFile(path.join(root, created.path), "utf8");
  assert.match(text, /^# 로컬 LLM 평가\n/);
  assert.match(text, /결론만 있음/);
});
