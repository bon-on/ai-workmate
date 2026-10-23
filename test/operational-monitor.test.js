import test from "node:test";
import assert from "node:assert/strict";
import { runOperationalMonitor } from "../src/operational-monitor.js";

test("operational monitor stays quiet when no anomaly exists", async () => {
  const sent = [];
  const result = await runOperationalMonitor({
    config: { operationalMonitoringEnabled: true, defaultTelegramTargetChatId: "1", personalBriefingsEnabled: false, dashboardPort: 1, n8nPort: 2, tradingDashboardPort: 3, ollamaPort: 4 },
    schedules: { list() { return []; } },
    personalOps: { async reserveAlert() { return true; } },
    telegram: { async sendMessage(...args) { sent.push(args); } },
  });
  assert.deepEqual(result, []);
  assert.equal(sent.length, 0);
});
