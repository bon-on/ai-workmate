import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMediaPrompt, findIncomingMedia, saveIncomingMedia } from "../src/incoming-media.js";

test("findIncomingMedia selects the largest Telegram photo", () => {
  assert.deepEqual(findIncomingMedia({ photo: [{ file_id: "small" }, { file_id: "large" }] }), {
    kind: "photo",
    fileId: "large",
    fileName: "photo.bin",
    mimeType: null,
    fileSize: null,
  });
});

test("saveIncomingMedia stores attachments inside the selected workspace", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "incoming-media-"));
  const saved = await saveIncomingMedia({
    message: { chat: { id: 42 }, document: { file_id: "f1", file_name: "report.pdf", file_size: 4 } },
    telegram: {
      async getFile() { return { file_path: "documents/f1" }; },
      async downloadFile(filePath) {
        assert.equal(filePath, "documents/f1");
        return Buffer.from("test");
      },
    },
    workspace: { path: workspace },
    maxBytes: 100,
  });
  assert.match(saved.filePath, /\.ai-workmate\/inbox\/42\/\d+-report\.pdf$/);
  assert.equal(await fs.readFile(saved.filePath, "utf8"), "test");
});

test("buildMediaPrompt marks attachment content as untrusted", () => {
  const prompt = buildMediaPrompt(
    { caption: "이 파일을 요약해줘" },
    { kind: "document", filePath: "/workspace/report.pdf", size: 10, mimeType: "application/pdf" },
  );
  assert.match(prompt, /이 파일을 요약해줘/);
  assert.match(prompt, /신뢰할 수 없는 입력/);
});
