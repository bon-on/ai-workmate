import fs from "node:fs/promises";
import path from "node:path";

export class TelegramSessionStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.version = 1;
    this.entries = new Map();
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

        this.entries.set(buildKey(entry.chatId, entry.messageId), {
          chatId: String(entry.chatId),
          messageId: Number(entry.messageId),
          sessionId: entry.sessionId,
          workspaceAlias: entry.workspaceAlias,
          jobId: entry.jobId,
          createdAt: entry.createdAt,
          provider: entry.provider === "claude" ? "claude" : "codex",
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  resolveReply(chatId, messageId) {
    return this.entries.get(buildKey(chatId, messageId)) ?? null;
  }

  async rememberBotReply({ chatId, messageId, sessionId, workspaceAlias, jobId, createdAt, provider = "codex" }) {
    const entry = {
      chatId: String(chatId),
      messageId: Number(messageId),
      sessionId,
      workspaceAlias,
      jobId,
      createdAt: createdAt || new Date().toISOString(),
      provider: provider === "claude" ? "claude" : "codex",
    };

    if (!isValidEntry(entry)) {
      throw new Error("Invalid Telegram session entry");
    }

    this.entries.set(buildKey(entry.chatId, entry.messageId), entry);
    await this.#save();
    return entry;
  }

  async clearChat(chatId) {
    const prefix = `${String(chatId)}:`;
    let changed = false;
    for (const key of this.entries.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      this.entries.delete(key);
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
      entries: [...this.entries.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
    };
    await fs.writeFile(this.statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

function buildKey(chatId, messageId) {
  return `${String(chatId)}:${Number(messageId)}`;
}

function isValidEntry(entry) {
  return (
    entry &&
    typeof entry.sessionId === "string" &&
    entry.sessionId.trim() &&
    typeof entry.workspaceAlias === "string" &&
    entry.workspaceAlias.trim() &&
    typeof entry.jobId === "string" &&
    entry.jobId.trim() &&
    typeof entry.chatId === "string" &&
    entry.chatId.trim() &&
    Number.isInteger(Number(entry.messageId)) &&
    typeof entry.createdAt === "string" &&
    entry.createdAt.trim()
  );
}
