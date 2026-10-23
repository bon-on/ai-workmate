import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore, requiresExplicitApproval } from "../src/approval-store.js";

test("ApprovalStore only allows the originating chat and user to consume a request", () => {
  const store = new ApprovalStore();
  const entry = store.create({ chatId: 1, userId: 2, prompt: "send", workspaceAlias: "default" });
  assert.equal(store.consume({ id: entry.id, chatId: 1, userId: 3 }), null);
  assert.equal(store.consume({ id: entry.id, chatId: 1, userId: 2 }).prompt, "send");
  assert.equal(store.consume({ id: entry.id, chatId: 1, userId: 2 }), null);
});

test("ApprovalStore expires requests and risky actions require approval", () => {
  let now = 0;
  const store = new ApprovalStore({ ttlMs: 100, now: () => now });
  const entry = store.create({ chatId: 1, userId: 2, prompt: "send", workspaceAlias: "default" });
  now = 101;
  assert.equal(store.consume({ id: entry.id, chatId: 1, userId: 2 }), null);
  assert.equal(requiresExplicitApproval("이메일을 보내줘"), true);
  assert.equal(requiresExplicitApproval("코드를 분석해줘"), false);
});

test("ApprovalStore preserves explicitly approved unrestricted scope", () => {
  const store = new ApprovalStore();
  const entry = store.create({ chatId: 1, userId: 2, prompt: "restart service", workspaceAlias: "default", unrestricted: true });
  assert.equal(store.consume({ id: entry.id, chatId: 1, userId: 2 }).unrestricted, true);
});
