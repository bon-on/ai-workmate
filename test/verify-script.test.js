import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const verifySource = fileURLToPath(new URL("../scripts/verify.mjs", import.meta.url));

// verify.mjs derives its root from its own location, so run a copy inside a
// temporary fixture project whose single test is controlled by the test case.
async function makeFixture(testBody, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verify-fixture-"));
  for (const dir of ["src", "test", "scripts", "harness"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.copyFile(verifySource, path.join(root, "scripts/verify.mjs"));
  await fs.writeFile(path.join(root, "src/a.js"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "harness/h.md"), "h\n");
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(root, "AGENTS.md"), "agents\n");
  await fs.writeFile(path.join(root, "test/fixture.test.js"), testBody);
  for (const [name, content] of Object.entries(extra)) await fs.writeFile(path.join(root, name), content);
  return root;
}

function runVerify(root) {
  const result = spawnSync(process.execPath, ["scripts/verify.mjs"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  return result;
}

async function readEvidence(root) {
  const parent = path.join(root, "out/evidence");
  const dirs = await fs.readdir(parent);
  return { dirs, directory: path.join(parent, dirs[0]) };
}

const passingTest = 'import test from "node:test"; test("ok", () => {});\n';
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("verify saves output, exit code and hashes in a unique evidence directory", async () => {
  const root = await makeFixture(passingTest);
  try {
    const first = runVerify(root);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /^PASS: 1 tests; evidence: /);
    runVerify(root);
    const { dirs, directory } = await readEvidence(root);
    assert.equal(dirs.length, 2, "each run gets its own unique directory");
    assert.ok(dirs.every((name) => name.startsWith("verify-")));
    const output = await fs.readFile(path.join(directory, "test-output.txt"), "utf8");
    assert.match(output, /tests 1/);
    const checks = JSON.parse(await fs.readFile(path.join(directory, "checks.json"), "utf8"));
    assert.equal(checks.code, 0);
    assert.equal(checks.passed, true);
    assert.equal(checks.unchanged, true);
    assert.equal(checks.tests, 1);
    assert.equal(checks.before["src/a.js"], sha("export const a = 1;\n"));
    assert.equal(checks.before["package.json"], sha('{"type":"module"}\n'));
    for (const prefix of ["src/", "test/", "scripts/", "harness/"]) {
      assert.ok(Object.keys(checks.before).some((key) => key.startsWith(prefix)), `before hashes cover ${prefix}`);
      assert.ok(Object.keys(checks.after).some((key) => key.startsWith(prefix)), `after hashes cover ${prefix}`);
    }
    assert.ok("package.json" in checks.before && "package.json" in checks.after);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify flags files changed during verification as failed evidence", async () => {
  const body = 'import test from "node:test"; import fs from "node:fs"; test("mutates", () => { fs.appendFileSync(new URL("../src/a.js", import.meta.url), "// changed\\n"); });\n';
  const root = await makeFixture(body);
  try {
    const result = runVerify(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL:/);
    const { directory } = await readEvidence(root);
    const checks = JSON.parse(await fs.readFile(path.join(directory, "checks.json"), "utf8"));
    assert.equal(checks.code, 0, "the test process itself succeeded");
    assert.equal(checks.unchanged, false);
    assert.equal(checks.passed, false);
    assert.notEqual(checks.before["src/a.js"], checks.after["src/a.js"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify records failed evidence and exits nonzero when the test process fails", async () => {
  const root = await makeFixture('import test from "node:test"; test("bad", () => { throw new Error("boom"); });\n');
  try {
    const result = runVerify(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL:/);
    const { directory } = await readEvidence(root);
    const checks = JSON.parse(await fs.readFile(path.join(directory, "checks.json"), "utf8"));
    assert.notEqual(checks.code, 0);
    assert.equal(checks.passed, false);
    const output = await fs.readFile(path.join(directory, "test-output.txt"), "utf8");
    assert.match(output, /boom/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify records what it does not verify", async () => {
  const root = await makeFixture(passingTest);
  try {
    runVerify(root);
    const { directory } = await readEvidence(root);
    const { notVerified } = JSON.parse(await fs.readFile(path.join(directory, "checks.json"), "utf8"));
    const joined = notVerified.join("|").toLowerCase();
    for (const item of ["browser interaction", "factual accuracy", "independent review"]) {
      assert.ok(joined.includes(item), `notVerified mentions ${item}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
