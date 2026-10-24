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
  assert.equal(checkServerCommandSafety(["node", "server.js"]).allowed, true);
  assert.equal(checkServerCommandSafety(["python3", "app.py", "--port", "8000"]).allowed, true);
  for (const argv of [["node", "-e", "x"], ["node", "--eval=x"], ["node", "-r", "./x", "a.js"], ["python3", "-c", "x"], ["python3", "-m", "http.server"], ["node"],
    ["node", "-pe", "process.version"], ["python3", "-Bc", "print(1)"], ["node", "--inspect=0.0.0.0:9229", "server.js"]]) {
    assert.equal(checkServerCommandSafety(argv).allowed, false, argv.join(" "));
  }
});
