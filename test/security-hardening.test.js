import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { executeDashboardCommand, isAllowedHost, startDashboardServer } from "../src/dashboard-server.js";
import { ApprovalStore } from "../src/approval-store.js";
import { handleUpdate, splittingTelegram } from "../src/router.js";
import { WorkspaceSessionStore } from "../src/workspaces.js";

const config = { allowedChatIds: ["100"], allowedUserIds: ["200"] };
const workspaces = { getActiveWorkspace: () => ({ alias: "default", path: "/tmp" }), getWorkspaceByAlias: () => ({ alias: "default", path: "/tmp" }) };

test("dashboard hosts are limited to loopback, tailnet names and configured hosts", () => {
  for (const host of ["127.0.0.1:8766", "localhost:8766", "[::1]:8766", "mac.tail1234.ts.net"]) assert.equal(isAllowedHost(host), true, host);
  for (const host of ["evil.example:8766", "127.0.0.1.evil.example", "ts.net.evil.example", "", undefined]) assert.equal(isAllowedHost(host), false, String(host));
  assert.equal(isAllowedHost("box.lan:8766", { dashboardAllowedHosts: ["box.lan"] }), true);
});

function request(port, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end(body);
  });
}

test("the server rejects a rebound hostname and a foreign origin before running anything", async () => {
  const server = startDashboardServer({ config: { ...config, dashboardEnabled: true, dashboardPort: 0, dashboardHost: "127.0.0.1" }, jobs: {}, telegram: {} });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    assert.equal(await request(port, { path: "/api/dashboard", headers: { host: `evil.example:${port}` } }), 421);
    assert.equal(await request(port, {
      method: "POST", path: "/api/command", headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ command: "/status" }),
    }), 403);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("/ask cannot smuggle a command past the dashboard allowlist", async () => {
  let started = false;
  const processes = { start() { started = true; } };
  for (const command of ["/ask /serve node server.js", "/ask /file .env", "/ask   /workspace other"]) {
    await assert.rejects(executeDashboardCommand({ command, config, telegram: {}, jobs: {}, workspaces, processes }), /not available from the dashboard/, command);
  }
  assert.equal(started, false);
});

test("dashboard requests that need approval send the buttons to Telegram instead of dropping them", async () => {
  const sent = [];
  const telegram = { async sendMessage(chatId, text, extra) { sent.push({ chatId, text, extra }); return { message_id: 1 }; } };
  const result = await executeDashboardCommand({
    command: "/ask 변경사항을 GitHub에 push 해줘", config, telegram, approvals: new ApprovalStore(),
    jobs: { getActiveJob: () => null }, workspaces,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "100");
  assert.ok(sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data.startsWith("approval:run:"));
  assert.match(result.messages[0], /텔레그램에서 승인하세요/);

  const noUser = await executeDashboardCommand({
    command: "/ask 변경사항을 GitHub에 push 해줘", config: { allowedChatIds: ["100"], allowedUserIds: [] }, telegram, approvals: new ApprovalStore(),
    jobs: { getActiveJob: () => null }, workspaces,
  });
  assert.equal(sent.length, 1, "without ALLOWED_USER_IDS the button could never be approved, so nothing is sent");
  assert.match(noUser.messages[0], /텔레그램에서 직접 요청하세요/);
});

test("a failing command is reported to its chat instead of escaping to the poll loop, and long replies are split", async () => {
  const sent = [];
  const telegram = { async sendMessage(chatId, text) { sent.push({ chatId, text }); } };
  const originalError = console.error;
  console.error = () => {};
  try {
    await handleUpdate({
      update: { update_id: 1, message: { chat: { id: 100 }, from: { id: 200 }, text: "/watch not-a-url" } },
      config, telegram, jobs: {}, workspaces, personalOps: { async addWatch() { throw new Error("URL must be HTTP(S)"); } },
    });
    await handleUpdate({
      update: { update_id: 2, message: { chat: { id: 999 }, from: { id: 999 }, text: "/watch x" } },
      config: { ...config, denyMode: "silent" }, telegram: { async sendMessage() { throw new Error("must not be called for strangers"); } }, jobs: {}, workspaces,
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^⚠️ 요청을 처리하지 못했습니다/);

  const parts = [];
  const split = splittingTelegram({ async sendMessage(chatId, text, extra) { parts.push({ text, extra }); return { message_id: parts.length }; } });
  await split.sendMessage("100", "가".repeat(9000), { reply_markup: { inline_keyboard: [] } });
  assert.ok(parts.length >= 3 && parts.every((row) => row.text.length <= 4096));
  assert.deepEqual(parts.map((row) => Boolean(row.extra?.reply_markup)), [...Array(parts.length - 1).fill(false), true]);
});

test("/file refuses a symlink that points outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-link-"));
  const workspace = path.join(root, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(root, "secret.txt"), "x");
  await fs.symlink(path.join(root, "secret.txt"), path.join(workspace, "link.txt"));
  await fs.writeFile(path.join(workspace, "ok.txt"), "ok");
  const sent = [];
  const documents = [];
  const telegram = { async sendMessage(chatId, text) { sent.push(text); }, async sendDocument(chatId, file) { documents.push(file); } };
  const deps = { config, telegram, jobs: {}, workspaces: { getActiveWorkspace: () => ({ alias: "default", path: workspace }) } };
  await handleUpdate({ ...deps, update: { update_id: 1, message: { chat: { id: 100 }, from: { id: 200 }, text: "/file link.txt" } } });
  await handleUpdate({ ...deps, update: { update_id: 2, message: { chat: { id: 100 }, from: { id: 200 }, text: "/file ok.txt" } } });
  assert.match(sent[0], /Workspace 밖의 파일은 전송할 수 없습니다/);
  assert.deepEqual(documents, [path.join(workspace, "ok.txt")]);
});

test("workspace aliases never resolve to Object.prototype members", () => {
  const registry = new WorkspaceSessionStore({ defaultAlias: "default", byAlias: { default: "/tmp" } });
  assert.equal(registry.getWorkspaceByAlias("constructor"), null);
  assert.equal(registry.getWorkspaceByAlias("toString"), null);
  assert.deepEqual(registry.getWorkspaceByAlias("default"), { alias: "default", path: "/tmp" });
});
