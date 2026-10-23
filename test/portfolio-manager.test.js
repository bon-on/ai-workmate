import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PortfolioManager } from "../src/portfolio-manager.js";

test("portfolio overview calculates returns from the registered cost basis", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portfolio-"));
  const filePath = path.join(directory, "portfolio.json");
  await writeFile(filePath, JSON.stringify({ updatedAt: "2026-01-01", holdings: [
    { symbol: "000001", name: "Example A", quantity: 2, costBasis: 200000 },
  ] }));
  const manager = new PortfolioManager({ filePath, fetchImpl: async () => ({
    ok: true,
    json: async () => ({ closePrice: "120,000" }),
  }) });
  const result = await manager.overview();
  assert.equal(result.holdings[0].averagePrice, 100000);
  assert.equal(result.holdings[0].profitLoss, 40000);
  assert.equal(result.holdings[0].returnRate, 20);
  assert.equal(result.summary.marketValue, 240000);
});

test("portfolio remains readable when a quote is unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portfolio-"));
  const filePath = path.join(directory, "portfolio.json");
  await writeFile(filePath, JSON.stringify({ holdings: [
    { symbol: "000000", name: "Example", quantity: 1, costBasis: 150000 },
  ] }));
  const manager = new PortfolioManager({ filePath, fetchImpl: async () => { throw new Error("offline"); } });
  const result = await manager.overview();
  assert.equal(result.holdings[0].currentPrice, null);
  assert.equal(result.summary.marketValue, 150000);
  assert.equal(result.summary.priced, 0);
});

test("portfolio supports a manually valued retirement product without a ticker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portfolio-"));
  const filePath = path.join(directory, "portfolio.json");
  await writeFile(filePath, JSON.stringify({ holdings: [
    { name: "Retirement fund", category: "기타", costBasis: 1000000, manualMarketValue: 1020000 },
  ] }));
  const manager = new PortfolioManager({ filePath });
  const result = await manager.overview();
  assert.equal(result.holdings[0].marketValue, 1020000);
  assert.equal(result.holdings[0].profitLoss, 20000);
  assert.equal(result.holdings[0].valuation, "manual");
});
