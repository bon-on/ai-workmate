import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  buildPackArgs, buildPlanPrompt, createEmoticonStudio, parsePlan, runImoticonPack, validateEmoticonRequest,
} from "../src/emoticon-studio.js";
import { renderDashboardHtml, startDashboardServer } from "../src/dashboard-server.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const planJson = '```json\n{"species":"곰","color":"갈색","title":"퇴근곰 😎","description":"A sleepy office bear.","lines":["퇴근각!","ㅋㅋ|ㅋ","야근ㅠㅠ 😭"]}\n```';

function argValue(args, flag) {
  const entry = args.find((arg) => arg.startsWith(`${flag}=`));
  return entry === undefined ? undefined : entry.slice(flag.length + 1);
}

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "emoticon-test-"));
}

test("requests need a feeling or photo and accept only real JPEG/PNG/WebP within limits", () => {
  assert.throws(() => validateEmoticonRequest({}), /느낌/);
  assert.throws(() => validateEmoticonRequest({ vibe: "a", count: 13 }), /1~12/);
  assert.throws(() => validateEmoticonRequest({ vibe: "a".repeat(501) }), /500자/);
  assert.throws(() => validateEmoticonRequest({ photo: { type: "image/gif", data: "R0lG" } }), /JPEG, PNG, WebP/);
  assert.throws(() => validateEmoticonRequest({ photo: { type: "image/png", data: JPEG.toString("base64") } }), /형식/);
  const ok = validateEmoticonRequest({ photo: { type: "image/png", data: PNG.toString("base64") }, engine: "ai", registerStickerSet: true });
  assert.equal(ok.photo.ext, ".png");
  assert.equal(ok.engine, "ai");
  assert.equal(ok.count, 12);
  assert.equal(ok.deliverToTelegram, false);
  assert.equal(validateEmoticonRequest({ vibe: "x", engine: "other" }).engine, "local");
});

test("plans are validated against the renderer vocabulary and cleaned", () => {
  const plan = parsePlan(`설명\n${planJson}`, { vibe: "퇴근", count: 3 });
  assert.equal(plan.source, "ai");
  assert.equal(plan.character, "갈색 곰");
  assert.equal(plan.title, "퇴근곰");
  assert.deepEqual(plan.lines, ["퇴근각!", "ㅋㅋ ㅋ", "야근ㅠㅠ"]);
  assert.equal(parsePlan('{"species":"공룡","lines":[]}', { vibe: "공룡" }).source, "fallback");
  const fallback = parsePlan("no json here", { vibe: "분홍 토끼 느낌" });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.character, "분홍 토끼 느낌");
  assert.deepEqual(fallback.lines, []);
  assert.ok(parsePlan(JSON.stringify({ species: "토끼", lines: ["가".repeat(30)] })).lines[0].length <= 16);
  assert.deepEqual(parsePlan(JSON.stringify({ species: "토끼", lines: ["커피♥", "좋아❤️", "하트♡"] })).lines, ["커피♥", "좋아♥", "하트♡"]);
});

test("the plan prompt lists expressions in slot order and the photo path", () => {
  const prompt = buildPlanPrompt({ vibe: "직장인", photoPath: "/w/data/emoticons/x/source.jpg", count: 3 });
  assert.match(prompt, /source\.jpg/);
  assert.match(prompt, /1\. 인사하며 손 흔들기\n2\. 크게 웃기\n3\. 엉엉 울기/);
  assert.doesNotMatch(prompt, /4\. /);
});

test("pack argv uses the plan, the four platforms and the photo only for the ai engine", () => {
  const plan = { character: "갈색 곰", description: "A bear.", lines: ["a", "", "c"] };
  const local = buildPackArgs({ plan, count: 3, engine: "local", photoPath: "/p.jpg", outputDir: "/out" });
  assert.deepEqual(local.slice(0, 3), ["main.py", "pack", "--json"]);
  assert.equal(argValue(local, "--character"), "갈색 곰");
  assert.equal(argValue(local, "--platforms"), "telegram,imessage,whatsapp,kakaotalk");
  assert.equal(argValue(local, "--say"), "a||c");
  assert.equal(argValue(local, "--image_path"), undefined);
  const ai = buildPackArgs({ plan: { ...plan, lines: [] }, count: 3, engine: "ai", photoPath: "/p.jpg", outputDir: "/out" });
  assert.equal(argValue(ai, "--character"), "갈색 곰. A bear.");
  assert.equal(argValue(ai, "--image_path"), "/p.jpg");
  assert.equal(argValue(ai, "--say"), undefined);
  const dashed = buildPackArgs({ plan: { character: "-_-", description: "", lines: ["-_-"] }, count: 1, engine: "local", outputDir: "/out" });
  assert.ok(dashed.includes("--character=-_-") && dashed.includes("--say=-_-"));
});

test("the pack runner parses the JSON line, reports failures and hides bridge secrets", async () => {
  let seenEnv = null;
  const ok = await runImoticonPack({
    makerPath: "/maker", args: ["main.py"],
    execFileImpl: (python, args, options, callback) => { seenEnv = options.env; callback(null, 'Note\n{"ok":true,"stickers":[]}\n', ""); },
  });
  assert.equal(ok.ok, true);
  assert.equal("TELEGRAM_BOT_TOKEN" in seenEnv, false);
  const failed = await runImoticonPack({ makerPath: "/maker", args: [], execFileImpl: (p, a, o, cb) => cb(new Error("spawn python3 ENOENT"), "", "") });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ENOENT/);
});

function fakeEnvironment({ planText = planJson, planStatus = "completed", accepted = true, telegramFails = false } = {}) {
  const calls = { jobs: [], settled: [], packs: [], documents: [], messages: [], telegramApi: [] };
  const jobs = {
    async startJob(options) {
      calls.jobs.push(options);
      if (!accepted) return { accepted: false, reason: "busy" };
      return { accepted: true, job: { jobId: "job1", completion: Promise.resolve({ jobId: "job1", status: planStatus, summary: planText }) } };
    },
  };
  const runPack = async ({ args }) => {
    calls.packs.push(args);
    const out = argValue(args, "--output");
    const stickers = [];
    for (const slot of ["hello", "laugh", "cry"]) {
      const file = path.join(out, "job", "candidates", slot, `${slot}-1.png`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, PNG);
      stickers.push({ slot_id: slot, speech: slot, file });
    }
    const platforms = {};
    for (const name of ["telegram", "imessage", "whatsapp", "kakaotalk"]) {
      const dir = path.join(out, "job", "platforms", name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(`${dir}.zip`, "zip");
      if (name === "telegram") {
        await fs.writeFile(path.join(dir, "icon.png"), PNG);
        for (const [index, row] of stickers.entries()) await fs.writeFile(path.join(dir, `${String(index + 1).padStart(2, "0")}_${row.slot_id}.png`), PNG);
      }
      platforms[name] = { archive: `${dir}.zip`, dir };
    }
    return { ok: true, stickers, platforms, notes: [] };
  };
  const telegram = {
    baseUrl: "https://telegram.invalid/botX",
    async getMe() { return { username: "test_bot" }; },
    async sendDocument(chatId, file, caption) {
      if (telegramFails) throw new Error("network down");
      calls.documents.push({ chatId, file, caption });
    },
    async sendMessage(chatId, text) { calls.messages.push({ chatId, text }); },
    async fetchImpl(url, options) {
      calls.telegramApi.push({ method: url.split("/").pop(), form: options.body });
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    },
  };
  const workspaces = { getWorkspaceByAlias: () => ({ alias: "default", path: "/w" }) };
  const config = { allowedChatIds: ["100"], allowedUserIds: [], workspaces: { defaultAlias: "default" }, imoticonMakerPath: "/maker", imoticonPython: "python3" };
  return { calls, jobs, runPack, telegram, workspaces, config, onJobSettled: async (job) => calls.settled.push(job) };
}

test("a request plans through JobManager, renders, delivers ZIPs and registers a sticker set", async () => {
  const root = await tempRoot();
  const env = fakeEnvironment();
  const studio = createEmoticonStudio({ ...env, root });
  const { id, finished } = await studio.create({
    vibe: "퇴근 곰", count: 3, deliverToTelegram: true, registerStickerSet: true,
    photo: { type: "image/jpeg", data: JPEG.toString("base64") },
  });
  assert.equal(studio.list()[0].status, "planning");
  await finished;

  const [job] = env.calls.jobs;
  assert.equal(job.allowConcurrent, true);
  assert.equal(job.jobKind, "emoticon");
  assert.match(job.prompt, new RegExp(`${id}/source\\.jpg`));
  assert.equal(env.calls.settled[0].deliverToTelegram, false);

  const [args] = env.calls.packs;
  assert.equal(argValue(args, "--character"), "갈색 곰");
  assert.equal(argValue(args, "--output"), path.join(root, id, "out"));

  const [row] = studio.list();
  assert.equal(row.status, "completed");
  assert.equal(row.plan.title, "퇴근곰");
  assert.equal(row.stickers.length, 3);
  assert.match(row.stickers[0].url, /^\/api\/emoticon-file\?id=/);
  assert.deepEqual(row.downloads.map((item) => item.platform), ["telegram", "imessage", "whatsapp", "kakaotalk"]);

  assert.equal(env.calls.documents.length, 4);
  assert.ok(env.calls.documents.every((doc) => doc.chatId === "100"));
  const create = env.calls.telegramApi.find((call) => call.method === "createNewStickerSet");
  assert.equal(create.form.get("user_id"), "100");
  assert.equal(create.form.get("file0").size, PNG.length);
  assert.equal(create.form.get("name"), `emo_${id}_by_test_bot`);
  assert.equal(JSON.parse(create.form.get("stickers")).length, 3);
  assert.ok(env.calls.telegramApi.some((call) => call.method === "setStickerSetThumbnail"));
  assert.equal(row.telegram.stickerSetUrl, `https://t.me/addstickers/emo_${id}_by_test_bot`);
  assert.match(env.calls.messages[0].text, /addstickers/);

  const sticker = studio.get(id).result.stickers[0].file;
  assert.equal(studio.resolveFile(id, sticker), path.join(root, id, sticker));
  assert.equal(studio.resolveFile(id, "../../etc/passwd"), null);
  assert.equal(studio.resolveFile(id, "source.jpg"), null);
  assert.equal(studio.resolveFile("missing", sticker), null);
});

test("a failed or rejected plan falls back to the feeling text and still renders", async () => {
  for (const options of [{ planStatus: "failed" }, { accepted: false }, { planText: "not json" }]) {
    const root = await tempRoot();
    const env = fakeEnvironment(options);
    const studio = createEmoticonStudio({ ...env, root });
    const { finished } = await studio.create({ vibe: "노란 병아리 응원단", count: 3 });
    await finished;
    const [row] = studio.list();
    assert.equal(row.status, "completed", JSON.stringify(options));
    assert.equal(row.plan.source, "fallback");
    assert.ok(row.plan.note);
    const [args] = env.calls.packs;
    assert.equal(argValue(args, "--character"), "노란 병아리 응원단");
    assert.equal(env.calls.documents.length, 0);
  }
});

test("only one request runs at a time and null bodies get a friendly error", async () => {
  const root = await tempRoot();
  const env = fakeEnvironment();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const studio = createEmoticonStudio({ ...env, root, runPack: async (options) => { await gate; return env.runPack(options); } });
  const { finished } = await studio.create({ vibe: "곰", count: 3 });
  await assert.rejects(studio.create({ vibe: "토끼" }), /만드는 중/);
  release();
  await finished;
  await studio.create({ vibe: "토끼", count: 3 }).then(({ finished: next }) => next);
  assert.equal(studio.list().length, 2);
  assert.throws(() => validateEmoticonRequest(null), /느낌/);
});

test("old requests beyond the history limit are deleted with their files", async () => {
  const root = await tempRoot();
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: `old${index}`, status: "completed", createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z` }));
  await fs.writeFile(path.join(root, "index.json"), JSON.stringify(rows));
  await fs.mkdir(path.join(root, "old0"), { recursive: true });
  await fs.writeFile(path.join(root, "old0", "source.jpg"), JPEG);
  const env = fakeEnvironment();
  const studio = createEmoticonStudio({ ...env, root });
  const { finished } = await studio.create({ vibe: "곰", count: 3 });
  await finished;
  await fs.readFile(path.join(root, "index.json"));
  assert.equal(studio.get("old0"), null);
  await assert.rejects(fs.stat(path.join(root, "old0")), /ENOENT/);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "index.json"), "utf8")).length, 30);
});

test("telegram problems are reported without failing a rendered pack", async () => {
  const root = await tempRoot();
  const env = fakeEnvironment({ telegramFails: true });
  env.config.allowedChatIds = ["-100123"];
  const studio = createEmoticonStudio({ ...env, root });
  const { finished } = await studio.create({ vibe: "곰", count: 3, deliverToTelegram: true, registerStickerSet: true });
  await finished;
  const [row] = studio.list();
  assert.equal(row.status, "completed");
  assert.equal(row.telegram.stickerSetUrl, null);
  assert.ok(row.telegram.errors.some((text) => /소유자/.test(text)), JSON.stringify(row.telegram));
  assert.ok(row.telegram.errors.some((text) => /network down/.test(text)));
  assert.equal(env.calls.telegramApi.length, 0);
});

test("render failures are recorded and in-flight requests fail after a restart", async () => {
  const root = await tempRoot();
  const env = fakeEnvironment();
  const studio = createEmoticonStudio({ ...env, root, runPack: async () => ({ ok: false, error: "imoticon-maker 실행 실패: boom" }) });
  const { id, finished } = await studio.create({ vibe: "곰", count: 1 });
  await finished;
  assert.equal(studio.list()[0].status, "failed");
  assert.match(studio.list()[0].error, /boom/);

  const index = path.join(root, "index.json");
  const rows = JSON.parse(await fs.readFile(index, "utf8"));
  rows[0].status = "rendering";
  rows[0].error = null;
  await fs.writeFile(index, JSON.stringify(rows));
  const restarted = createEmoticonStudio({ ...env, root });
  await restarted.load();
  assert.equal(restarted.get(id).status, "failed");
  assert.match(restarted.get(id).error, /재시작/);
});

test("the emoticon tab script renders escaped results and keeps the dashboard script valid", () => {
  const html = renderDashboardHtml({ allowedChatIds: ["100"] });
  assert.match(html, /data-tab="emoticon"/);
  assert.match(html, /data-panel="emoticon"/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  const start = script.indexOf("const emoticonStatus");
  const end = script.indexOf("function readEmoticonPhoto");
  const context = vm.createContext({ escapeText: (value) => String(value ?? "").replace(/</g, "&lt;"), formatTime: String });
  vm.runInContext(script.slice(start, end), context);
  const rendered = context.renderEmoticons([{
    id: "a1", status: "completed", createdAt: "t", vibe: "<b>", count: 1, engine: "local", hasPhoto: true,
    plan: { title: "<script>", character: "곰", source: "ai" },
    stickers: [{ speech: "안녕", url: "/api/emoticon-file?id=a1&path=x.png" }],
    downloads: [{ platform: "telegram", label: "텔레그램", url: "/z" }],
    telegram: { stickerSetUrl: "https://t.me/addstickers/x", errors: [] }, error: null,
  }]);
  assert.match(rendered, /data-emoticon-id="a1"/);
  assert.match(rendered, /&lt;script>/);
  assert.match(rendered, /<details>/);
  assert.match(rendered, /addstickers/);
  assert.match(context.renderEmoticons([]), /아직/);
  assert.match(script, /setHtmlKeepingOpen\(document.getElementById\("emoticons"\)/);
});

function request(port, { method = "GET", target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("dashboard routes create requests with large photo bodies and serve only resolved files", async () => {
  const root = await tempRoot();
  const file = path.join(root, "x.png");
  await fs.writeFile(file, PNG);
  const created = [];
  const emoticonStudio = {
    load: async () => {},
    list: () => [{ id: "a1" }],
    create: async (body) => { created.push(body); return { id: "a1", finished: Promise.resolve() }; },
    resolveFile: (id, relative) => (id === "a1" && relative === "x.png" ? file : null),
  };
  const server = startDashboardServer({
    config: { allowedChatIds: ["100"], allowedUserIds: [], dashboardEnabled: true, dashboardPort: 0, dashboardHost: "127.0.0.1" },
    jobs: {}, telegram: {}, emoticonStudio,
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const photo = Buffer.alloc(300_000, 1).toString("base64");
    const posted = await request(port, {
      method: "POST", target: "/api/emoticon",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ vibe: "곰", photo: { type: "image/jpeg", data: photo } }),
    });
    assert.equal(posted.status, 200, posted.body.toString());
    assert.equal(JSON.parse(posted.body).id, "a1");
    assert.equal(created[0].photo.data.length, photo.length);

    const foreign = await request(port, { method: "POST", target: "/api/emoticon", headers: { origin: "http://evil.example" }, body: "{}" });
    assert.equal(foreign.status, 403);

    const served = await request(port, { target: "/api/emoticon-file?id=a1&path=x.png" });
    assert.equal(served.status, 200);
    assert.equal(served.headers["content-type"], "image/png");
    assert.equal((await request(port, { target: "/api/emoticon-file?id=a1&path=../x.png" })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
