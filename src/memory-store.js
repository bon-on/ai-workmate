import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class MemoryStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.version = 1;
    this.entries = new Map();
    this.saveQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== this.version || !Array.isArray(parsed.entries)) {
        return;
      }

      this.entries.clear();
      for (const entry of parsed.entries) {
        if (!isValidEntry(entry)) {
          continue;
        }

        this.entries.set(entry.id, normalizeEntry(entry));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async add({ chatId, workspaceAlias, text }) {
    const normalizedText = normalizeText(text);
    const duplicate = this.list({ chatId, workspaceAlias, limit: Number.MAX_SAFE_INTEGER }).find(
      (entry) => normalizeText(entry.text) === normalizedText,
    );
    if (duplicate) {
      return { ...duplicate, duplicate: true };
    }

    const entry = {
      id: randomUUID().slice(0, 8),
      chatId: String(chatId),
      workspaceAlias,
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };

    if (!isValidEntry(entry)) {
      throw new Error("Invalid memory entry");
    }

    this.entries.set(entry.id, entry);
    await this.#save();
    return entry;
  }

  list({ chatId, workspaceAlias, limit = 20 } = {}) {
    return [...this.entries.values()]
      .filter((entry) => !chatId || entry.chatId === String(chatId))
      .filter((entry) => !workspaceAlias || entry.workspaceAlias === workspaceAlias)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit);
  }

  listForPrompt({ chatId, workspaceAlias, limit = 12 }) {
    return this.list({ chatId, workspaceAlias, limit }).reverse();
  }

  async forget({ chatId, id }) {
    const entry = this.entries.get(id);
    if (!entry || entry.chatId !== String(chatId)) {
      return null;
    }

    this.entries.delete(id);
    await this.#save();
    return entry;
  }

  async clearChat(chatId) {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.chatId !== String(chatId)) {
        continue;
      }

      this.entries.delete(entry.id);
      changed = true;
    }

    if (changed) {
      await this.#save();
    }

    return changed;
  }

  async #save() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const payload = {
      version: this.version,
      entries: [...this.entries.values()].sort(
        (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
      ),
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const write = this.saveQueue.then(async () => {
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, serialized, "utf8");
      await fs.rename(temporary, this.statePath);
    });
    this.saveQueue = write.catch(() => {});
    await write;
  }
}

function normalizeEntry(entry) {
  return {
    id: entry.id,
    chatId: String(entry.chatId),
    workspaceAlias: entry.workspaceAlias,
    text: entry.text,
    createdAt: entry.createdAt,
  };
}

function normalizeText(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isValidEntry(entry) {
  return (
    entry &&
    typeof entry.id === "string" &&
    entry.id.trim() &&
    typeof entry.chatId === "string" &&
    entry.chatId.trim() &&
    typeof entry.workspaceAlias === "string" &&
    entry.workspaceAlias.trim() &&
    typeof entry.text === "string" &&
    entry.text.trim() &&
    typeof entry.createdAt === "string" &&
    entry.createdAt.trim()
  );
}
