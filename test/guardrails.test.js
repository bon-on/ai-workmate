import test from "node:test";
import assert from "node:assert/strict";
import { checkPromptSafety, checkServerCommandSafety } from "../src/guardrails.js";

test("checkPromptSafety blocks destructive prompts", () => {
  assert.equal(checkPromptSafety("rm -rf ~/Desktop").allowed, false);
  assert.equal(checkPromptSafety("build a mail server").allowed, true);
});

test("checkServerCommandSafety allows known server commands and blocks dangerous ones", () => {
  assert.equal(checkServerCommandSafety(["npm", "run", "dev"]).allowed, true);
  assert.equal(checkServerCommandSafety(["rm", "-rf", "/"]).allowed, false);
  assert.equal(checkServerCommandSafety(["bash", "-lc", "npm run dev"]).allowed, false);
});
