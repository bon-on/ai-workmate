import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRecentImageArtifacts } from "../src/artifacts.js";

test("findRecentImageArtifacts returns recent image files ordered by mtime", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "artifacts-test-"));
  const oldFile = path.join(workspace, "old.png");
  await fs.writeFile(oldFile, "old");

  await new Promise((resolve) => setTimeout(resolve, 20));
  const startedAt = new Date().toISOString();

  await new Promise((resolve) => setTimeout(resolve, 20));
  const recentPhoto = path.join(workspace, "recent.png");
  await fs.writeFile(recentPhoto, "new");

  await new Promise((resolve) => setTimeout(resolve, 20));
  const recentDocument = path.join(workspace, "vector.svg");
  await fs.writeFile(recentDocument, "<svg/>");
  const finishedAt = new Date().toISOString();

  const artifacts = await findRecentImageArtifacts({
    workspace,
    startedAt,
    finishedAt,
  });

  assert.deepEqual(
    artifacts.map((entry) => path.basename(entry.path)),
    ["vector.svg", "recent.png"],
  );
  assert.equal(artifacts[0].mode, "document");
  assert.equal(artifacts[1].mode, "photo");
});

test("findRecentImageArtifacts ignores non-image files such as codex.log", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "artifacts-test-"));
  const startedAt = new Date().toISOString();

  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.writeFile(path.join(workspace, "codex.log"), "debug output");
  await fs.writeFile(path.join(workspace, "result.png"), "image");
  const finishedAt = new Date().toISOString();

  const artifacts = await findRecentImageArtifacts({
    workspace,
    startedAt,
    finishedAt,
  });

  assert.deepEqual(
    artifacts.map((entry) => path.basename(entry.path)),
    ["result.png"],
  );
});
