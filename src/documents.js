import fs from "node:fs/promises";
import path from "node:path";

const extensions = new Set([".md", ".txt", ".pdf", ".docx", ".csv", ".html"]);
const folders = ["documents", "out/research"];

export function documentWorkspaces(config) {
  return { default: config.codexWorkspace || process.cwd(), ...(config.workspaces?.byAlias || {}) };
}

export async function resolveDocument(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Invalid document path");
  if (!folders.some(folder => relative.startsWith(folder + "/")) || !extensions.has(path.extname(relative).toLowerCase())) throw new Error("Invalid document path");
  const realRoot = await fs.realpath(root);
  const candidate = await fs.realpath(path.resolve(root, relative));
  // Reject symlinks, including document folders redirected outside the workspace.
  if (candidate !== path.join(realRoot, relative)) throw new Error("Invalid document path");
  if (!(await fs.stat(candidate)).isFile()) throw new Error("Invalid document path");
  return candidate;
}

export async function listDocuments(config) {
  const documents = [];
  const visited = new Set();
  for (const [workspace, root] of Object.entries(documentWorkspaces(config))) {
    if (visited.has(path.resolve(root))) continue;
    visited.add(path.resolve(root));
    async function walk(relative) {
      let entries;
      try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const file = relative + "/" + entry.name;
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && extensions.has(path.extname(file).toLowerCase())) {
          try {
            const resolved = await resolveDocument(root, file);
            const stat = await fs.stat(resolved);
            documents.push({ workspace, path: file, absolutePath: resolved, name: entry.name, modifiedAt: stat.mtime.toISOString(), url: "/api/document?workspace=" + encodeURIComponent(workspace) + "&path=" + encodeURIComponent(file) });
          } catch { /* Unavailable files are not published. */ }
        }
      }
    }
    for (const folder of folders) {
      // Do not traverse symlinked roots.
      try { if ((await fs.lstat(path.join(root, folder))).isSymbolicLink()) continue; } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      await walk(folder);
    }
  }
  return documents.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function serveDocument(request, response, url, config) {
  try {
    const root = documentWorkspaces(config)[url.searchParams.get("workspace") || "default"];
    if (typeof root !== "string") throw new Error("Unknown workspace");
    const filename = await resolveDocument(root, url.searchParams.get("path"));
    const data = await fs.readFile(filename);
    const ext = path.extname(filename).toLowerCase();
    const download = url.searchParams.get("download") === "1" || [".docx", ".html"].includes(ext);
    response.writeHead(200, {
      "content-type": ext === ".pdf" ? "application/pdf" : [".md", ".txt", ".csv"].includes(ext) ? "text/plain; charset=utf-8" : "application/octet-stream",
      "content-disposition": (download ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(path.basename(filename)),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("문서를 찾을 수 없습니다.");
  }
}

const REPORT_REFERENCE = /(?:^|[\s`'"(\[])((?:\/[^\s`'"()\[\]]*\/)?(?:documents|out\/research)\/[^\s`'"()\[\]]+\.md)/g;

// AI lab results must be readable from the dashboard. Reuse a Markdown report the
// job already wrote inside the workspace; otherwise save the result summary as one.
export async function ensureLabReport({ root, experiment, summary, artifacts = [], now = new Date() }) {
  const text = [summary, ...artifacts.map((item) => typeof item === "string" ? item : item?.path)].filter(Boolean).join("\n");
  const realRoot = await fs.realpath(root);
  for (const match of text.matchAll(REPORT_REFERENCE)) {
    const reference = match[1];
    const relative = path.isAbsolute(reference) ? path.relative(realRoot, reference) : reference;
    try {
      await resolveDocument(root, relative);
      return { path: relative, created: false };
    } catch { /* Not a readable workspace document; keep looking. */ }
  }
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-");
  const relative = `documents/reports/${year}-${month}/${year}-${month}-${day}-${experiment.id}.md`;
  const body = [
    `# ${String(experiment.topic || experiment.id).split("\n")[0].slice(0, 120)}`,
    "",
    `- 실험: ${experiment.id}`,
    `- 작성: ${year}-${month}-${day} (작업 결과 요약에서 자동 저장)`,
    "",
    String(summary || "결과 요약이 없습니다.").trim(),
    "",
  ].join("\n");
  await fs.mkdir(path.join(root, path.dirname(relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), body, { encoding: "utf8", flag: "wx" }).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return { path: relative, created: true };
}
