import fs from "node:fs/promises";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

export async function findRecentImageArtifacts({
  workspace,
  startedAt,
  finishedAt,
  limit = 3,
}) {
  const lowerBound = Date.parse(startedAt);
  const upperBound = Date.parse(finishedAt ?? new Date().toISOString()) + 1000;
  const matches = [];

  await walkDirectory(workspace, async (filePath) => {
    const extension = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) {
      return;
    }

    const stats = await fs.stat(filePath);
    if (stats.mtimeMs < lowerBound || stats.mtimeMs > upperBound) {
      return;
    }

    matches.push({
      path: filePath,
      extension,
      modifiedAt: stats.mtimeMs,
      mode: PHOTO_EXTENSIONS.has(extension) ? "photo" : "document",
    });
  });

  return matches
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, limit);
}

async function walkDirectory(root, onFile) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await walkDirectory(fullPath, onFile);
      continue;
    }

    if (entry.isFile()) {
      await onFile(fullPath);
    }
  }
}
