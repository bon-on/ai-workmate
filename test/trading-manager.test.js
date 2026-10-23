import assert from "node:assert/strict";
import test from "node:test";
import { TradingManager } from "../src/trading-manager.js";

test("trading overview exposes open positions for the dashboard", async () => {
  const manager = new TradingManager({ fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      summary: { positions: 1 },
      positions: [{
        symbol: "000001", name: "Example A", qty: 2, entry_price: 70000,
        current_price: 73500, market_value: 147000, pnl: 7000, pnl_pct: 0.05,
        mode: "swing", held_days: 2,
      }],
    }),
  }) });
  const result = await manager.overview();
  assert.equal(result.positions, 1);
  assert.equal(result.pnlCurrency, "KRW");
  assert.equal(result.cashCurrency, "KRW");
  assert.deepEqual(result.openPositions[0], {
    symbol: "000001", name: "Example A", quantity: 2, entryPrice: 70000,
    currentPrice: 73500, marketValue: 147000, profitLoss: 7000, returnRate: 5,
    mode: "swing", entryAt: null, heldDays: 2,
  });
});

test("trading overview lists order, trade and selected candidate stocks", async () => {
  const manager = new TradingManager({ fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      summary: { orders: 1, forward_trades: [{ experiment: "e", arm: "a", trades: 2, wins: 1, losses: 1, pnl: -10 }] },
      orders: [{ symbol: "000002", name: "Example B", ts: "2026-01-02T09:00:00", side: "buy", side_label: "매수", qty: 10, price: 50000, status: "rejected", status_label: "거절", message_label: "quote_error" }],
      trades: [{ symbol: "000003", display_name: "Example C (000003)", entry_ts: "2026-01-02T09:00:00", exit_ts: "2026-01-02T09:00:00", pnl: 2000, reason: "take_profit", source: "거래량순위" }],
      dynamic_watchlist: [
        { symbol: "000004", name: "Example D", source: "등락률순위", score: 0.5, change_pct: 0.01, price: 5000, selected: 1 },
        { symbol: "000001", name: "제외", selected: 0 },
      ],
    }),
  }) });
  const result = await manager.overview();
  assert.deepEqual(result.orderList, [{ symbol: "000002", name: "Example B", ts: "2026-01-02T09:00:00", side: "매수", quantity: 10, price: 50000, status: "거절", message: "quote_error" }]);
  assert.equal(result.tradeList[0].name, "Example C (000003)");
  assert.equal(result.tradeList[0].profitLoss, 2000);
  assert.equal(result.candidateList.length, 1);
  assert.equal(result.candidateList[0].name, "Example D");
  assert.ok(Math.abs(result.candidateList[0].changeRate - 1) < 1e-9);
  assert.equal(result.forwardTrades[0].losses, 1);
});
