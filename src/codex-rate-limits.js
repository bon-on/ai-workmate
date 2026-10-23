import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Only account metadata is requested: no thread or model turn is started.
export function readCodexRateLimits({ executable = "codex", timeoutMs = 8000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Codex limit lookup timed out")), timeoutMs);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error); else resolve(result);
    }
    const send = message => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.on("exit", () => finish(new Error("Codex limit lookup exited")));
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) return finish(new Error("Codex limit lookup failed"));
      if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read" });
      } else finish(null, message.result);
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "ai_workmate_limits", title: "AI Workmate", version: "0.1.0" } } });
  });
}

export function normalizeFiveHourLimit(result) {
  return normalizeWindow(result, 300);
}

export function normalizeWeeklyLimit(result) {
  return normalizeWindow(result, 10080);
}

function normalizeWindow(result, durationMins) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (bucket?.limitId && bucket.limitId !== "codex") return null;
  const window = [bucket?.primary, bucket?.secondary].find(row => row?.windowDurationMins === durationMins);
  if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  const reset = typeof window.resetsAt === "number" ? new Date(window.resetsAt * 1000) : null;
  return {
    usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
  };
}

export function createCodexLimitReader({ read = readCodexRateLimits, executable, now = Date.now } = {}) {
  let cached = null;
  let expiresAt = 0;
  let pending;
  return async () => {
    if (pending) return pending;
    if (cached && now() < expiresAt) return cached;
    pending = (async () => {
      try {
        const result = await read({ executable });
        const fiveHour = normalizeFiveHourLimit(result);
        const weekly = normalizeWeeklyLimit(result);
        cached = { status: fiveHour || weekly ? "available" : "unavailable", fiveHour, weekly, checkedAt: new Date(now()).toISOString() };
      } catch {
        cached = { status: "unavailable", fiveHour: null, weekly: null, checkedAt: new Date(now()).toISOString() };
      }
      expiresAt = now() + 60_000;
      return cached;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
