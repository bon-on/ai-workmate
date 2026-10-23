import { randomUUID } from "node:crypto";

export class ApprovalStore {
  constructor({ ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  create({ chatId, userId, prompt, workspaceAlias, operationMode = "default", unrestricted = false, kind = "job" }) {
    this.prune();
    const id = randomUUID().slice(0, 8);
    const entry = {
      id,
      kind,
      chatId: String(chatId),
      userId: String(userId),
      prompt,
      workspaceAlias,
      operationMode,
      unrestricted,
      createdAt: this.now(),
    };
    this.entries.set(id, entry);
    return entry;
  }

  // Each button scope consumes only its own kind, so an AI-job button cannot run an ops action.
  consume({ id, chatId, userId, kind = "job" }) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== kind || entry.chatId !== String(chatId) || entry.userId !== String(userId)) {
      return null;
    }
    this.entries.delete(id);
    return entry;
  }

  // Validates without consuming, so a refused attempt can be approved again later.
  peek({ id, chatId, userId, kind = "job" }) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== kind || entry.chatId !== String(chatId) || entry.userId !== String(userId)) return null;
    return entry;
  }

  cancel(input) {
    return this.consume(input);
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.createdAt < cutoff) this.entries.delete(id);
    }
  }
}

export function requiresExplicitApproval(prompt) {
  return /(메일|이메일|email|메시지|message).*(보내|발송|전송|send)|\b(send|delete|remove|publish|deploy|release)\b|git\s+push|--push\b|(github|깃허브|원격|remote|origin).*(push|푸시|올려|업로드|upload|반영)|\b(push|upload)\b.*\b(github|origin|remote)\b|(업로드|푸시).*(github|깃허브|원격)|푸시해|삭제|게시|배포|일정.*(삭제|변경|생성)|calendar.*(delete|update|create)/i.test(prompt);
}
