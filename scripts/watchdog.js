#!/usr/bin/env node
// External watchdog for the bridge: checks the dashboard API and sends a Telegram notice
// through src/telegram-send.js after two consecutive failures, and once on recovery.
// Runs from a launchd interval job; keeps its own small state file. No dependencies.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFile } from "../src/config.js";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAILURES_BEFORE_ALERT = 2;

// Pure decision: returns the next state and which notice (if any) to send.
export function decideWatchdog(state = {}, ok, now = new Date()) {
  const previous = { consecutiveFailures: 0, alerted: false, ...state };
  const checkedAt = now.toISOString();
  if (ok) {
    return {
      state: { consecutiveFailures: 0, alerted: false, lastCheckedAt: checkedAt, lastOkAt: checkedAt, downSince: null },
      notify: previous.alerted ? "recovered" : null,
    };
  }
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const shouldAlert = consecutiveFailures >= FAILURES_BEFORE_ALERT && !previous.alerted;
  return {
    state: {
      ...previous,
      consecutiveFailures,
      alerted: previous.alerted || shouldAlert,
      lastCheckedAt: checkedAt,
      downSince: previous.downSince || checkedAt,
    },
    notify: shouldAlert ? "down" : null,
  };
}

export function watchdogMessage(kind, state, detail = "") {
  if (kind === "down") {
    return `🚨 AI Workmate 응답 없음\n대시보드 점검이 ${state.consecutiveFailures}회 연속 실패했습니다.${detail ? `\n오류: ${detail}` : ""}\n확인: npm run status:daemon`;
  }
  return "✅ AI Workmate가 다시 응답합니다.";
}

export async function checkDashboard({ port, fetchImpl = fetch, timeoutMs = 5000 }) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/dashboard`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 200) };
  }
}

async function readState(statePath) {
  try { return JSON.parse(await fs.readFile(statePath, "utf8")); } catch { return {}; }
}

async function writeState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporary, statePath);
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "src", "telegram-send.js"), "--text", text], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`telegram-send exited with ${code}`))));
  });
}

async function main() {
  // launchd starts this without the project environment; read the same .env as the bridge.
  loadEnvFile(path.join(ROOT, ".env"));
  if (process.env.DASHBOARD_ENABLED === "false") return;
  const port = Number(process.env.DASHBOARD_PORT) || 8766;
  const statePath = process.env.WATCHDOG_STATE_PATH || path.join(os.homedir(), ".codex", "ai-workmate", "watchdog.json");
  const result = await checkDashboard({ port });
  const { state, notify } = decideWatchdog(await readState(statePath), result.ok);
  if (notify) {
    try { await sendTelegram(watchdogMessage(notify, state, result.error)); }
    catch (error) {
      // Retry the notice on the next run instead of marking it delivered.
      console.error("Watchdog notice failed:", error.message);
      if (notify === "down") state.alerted = false;
      else state.alerted = true;
    }
  }
  await writeState(statePath, state);
  if (!result.ok) console.error(`Dashboard check failed: ${result.error}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
