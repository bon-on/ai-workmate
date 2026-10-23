import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
async function snapshot() {
  const hashes = {};
  async function visit(relative) {
    const filename = path.join(root, relative);
    const stat = await fs.lstat(filename);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(filename)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      hashes[relative] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    }
  }
  for (const entry of ['src', 'test', 'scripts', 'harness', 'package.json', 'AGENTS.md']) await visit(entry);
  return hashes;
}

const startedAt = new Date().toISOString();
const parent = path.join(root, 'out/evidence');
await fs.mkdir(parent, { recursive: true });
const directory = await fs.mkdtemp(path.join(parent, 'verify-'));
const before = await snapshot();
const log = await fs.open(path.join(directory, 'test-output.txt'), 'w');
let spawnError = null;
const outcome = await new Promise(resolve => {
  const child = spawn(process.execPath, ['--test'], {
    cwd: root, stdio: ['ignore', log.fd, log.fd],
  });
  child.on('error', error => { spawnError = error.message; });
  child.on('close', (code, signal) => resolve({ code, signal }));
});
await log.close();
const after = await snapshot();
const unchanged = JSON.stringify(before) === JSON.stringify(after);
const output = await fs.readFile(path.join(directory, 'test-output.txt'), 'utf8');
const count = Number(output.match(/(?:#|ℹ) tests (\d+)/)?.[1] || 0);
const passed = outcome.code === 0 && count > 0 && unchanged && !spawnError;
await fs.writeFile(path.join(directory, 'checks.json'), JSON.stringify({
  startedAt, finishedAt: new Date().toISOString(), command: [process.execPath, '--test'],
  nodeVersion: process.version, platform: process.platform, arch: process.arch,
  ...outcome, spawnError, tests: count, unchanged, passed,
  before, after,
  notVerified: ['Browser interaction', 'Research factual accuracy', 'Independent review', 'Production delivery'],
}, null, 2) + '\n');
console.log(`${passed ? 'PASS' : 'FAIL'}: ${count} tests; evidence: ${directory}`);
process.exitCode = passed ? 0 : 1;
