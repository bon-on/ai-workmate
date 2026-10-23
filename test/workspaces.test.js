import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkspaceMap, WorkspaceSessionStore } from "../src/workspaces.js";

test("parseWorkspaceMap uses explicit aliases", () => {
  const parsed = parseWorkspaceMap({
    CODEX_WORKSPACE: "/tmp/a",
    ALLOWED_WORKSPACES: "main=/tmp/a,mail=/tmp/b",
  });

  assert.equal(parsed.defaultAlias, "main");
  assert.equal(parsed.byAlias.mail, "/tmp/b");
});

test("WorkspaceSessionStore tracks active workspace per chat", () => {
  const store = new WorkspaceSessionStore({
    defaultAlias: "main",
    byAlias: { main: "/tmp/a", mail: "/tmp/b" },
  });

  assert.equal(store.getActiveWorkspace("1").alias, "main");
  assert.equal(store.setActiveWorkspace("1", "mail").alias, "mail");
  assert.equal(store.getActiveWorkspace("1").path, "/tmp/b");
});
