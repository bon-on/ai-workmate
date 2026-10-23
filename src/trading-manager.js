export class TradingManager {
  constructor({ port = 8000, fetchImpl = fetch } = {}) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.fetch = fetchImpl;
  }

  async overview() {
    const response = await this.fetch(`${this.baseUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Trading API ${response.status}`);
    const data = await response.json();
    const summary = data.summary ?? {};
    return {
      date: summary.today,
      pnl: summary.pnl ?? 0,
      pnlCurrency: "KRW",
      orders: summary.orders ?? 0,
      positions: summary.positions ?? 0,
      wins: summary.wins ?? 0,
      losses: summary.losses ?? 0,
      winRate: summary.win_rate ?? 0,
      cash: summary.cash ?? 0,
      cashCurrency: "KRW",
      strategyMode: summary.strategy_mode ?? "-",
      liveReady: Boolean(summary.live_ready),
      liveGateReason: summary.live_gate_reason ?? null,
      selectedCandidates: summary.selected_candidates ?? 0,
      forwardTrades: (summary.forward_trades ?? []).map((row) => ({
        experiment: row.experiment,
        arm: row.arm,
        trades: row.trades ?? 0,
        wins: row.wins ?? 0,
        losses: row.losses ?? 0,
        pnl: row.pnl ?? 0,
      })),
      activeLocks: (summary.active_locks ?? []).slice(0, 5),
      recentEvents: (data.events ?? []).slice(0, 5),
      orderList: (data.orders ?? []).slice(0, 50).map((order) => ({
        symbol: order.symbol,
        name: order.name || order.symbol,
        ts: order.ts ?? null,
        side: order.side_label || order.side || "-",
        quantity: order.qty ?? 0,
        price: order.price ?? 0,
        status: order.status_label || order.status || "-",
        message: order.message_label || order.message || "",
      })),
      tradeList: (data.trades ?? []).slice(0, 50).map((trade) => ({
        symbol: trade.symbol,
        name: trade.name || trade.display_name || trade.symbol,
        entryAt: trade.entry_ts ?? null,
        exitAt: trade.exit_ts ?? null,
        profitLoss: trade.pnl ?? 0,
        reason: trade.reason || "",
        source: trade.source || "",
      })),
      candidateList: (data.dynamic_watchlist ?? []).filter((row) => row.selected).slice(0, 60).map((row) => ({
        symbol: row.symbol,
        name: row.name || row.symbol,
        source: row.source || "",
        score: row.score ?? null,
        changeRate: Number(row.change_pct ?? 0) * 100,
        price: row.price ?? 0,
      })),
      openPositions: (data.positions ?? []).map((position) => ({
        symbol: position.symbol,
        name: position.name || position.display_name || position.symbol,
        quantity: position.qty ?? 0,
        entryPrice: position.entry_price ?? 0,
        currentPrice: position.current_price ?? 0,
        marketValue: position.market_value ?? 0,
        profitLoss: position.pnl ?? 0,
        returnRate: Number(position.pnl_pct ?? 0) * 100,
        mode: position.mode ?? "-",
        entryAt: position.entry_ts ?? null,
        heldDays: position.held_days ?? 0,
      })),
    };
  }
}
