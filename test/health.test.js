import test from "node:test";
import assert from "node:assert/strict";
import { buildHealthReport, formatHealthReport } from "../src/health.js";

test("health report includes service and unconfigured storage state", async () => {
  const report = await buildHealthReport({ dashboardPort: 1, n8nPort: 2, tradingDashboardPort: 3, ollamaPort: 4, externalStoragePath: null }, { connect: async (port) => port === 1 });
  assert.equal(report.services[0].ok, true);
  assert.equal(report.services[1].ok, false);
  assert.match(formatHealthReport(report), /EXTERNAL_STORAGE_PATH not configured/);
});
