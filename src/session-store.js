import fs from "node:fs/promises";
import path from "node:path";

export class TelegramSessionStore {
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
      if (error?.code === "ENOENT") return;
      if (!(error instanceof SyntaxError)) throw error;
      // A corrupt file must not stop the bridge from starting; keep it for inspection.
      const backup = `${this.statePath}.corrupt-${Date.now()}`;
      await fs.rename(this.statePath, backup).catch(() => {});
      console.error(`Session state was not valid JSON; moved to ${backup} and starting empty.`);
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
    const entries = [...this.entries.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    // Replies to very old bot messages are rare; keep the newest sessions only.
    for (const old of entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES))) this.entries.delete(buildKey(old.chatId, old.messageId));
    const serialized = `${JSON.stringify({ version: this.version, entries: entries.slice(-MAX_ENTRIES) }, null, 2)}\n`;
    // Serialized and atomic (temp file + rename), like the schedule and personal ops stores.
    const write = this.saveQueue.then(async () => {
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, serialized, "utf8");
      await fs.rename(temporary, this.statePath);
    });
    this.saveQueue = write.catch(() => {});
    await write;
  }
}

const MAX_ENTRIES = 500;

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
