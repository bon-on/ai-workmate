import fs from "node:fs/promises";
import path from "node:path";

export class PortfolioManager {
  constructor({
    filePath = path.resolve(process.cwd(), "data", "portfolio.json"),
    fetchImpl = fetch,
  } = {}) {
    this.filePath = filePath;
    this.fetch = fetchImpl;
  }

  async overview() {
    const portfolio = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    const holdings = await Promise.all(portfolio.holdings.map((holding) => this.#enrich(holding)));
    const costBasis = holdings.reduce((sum, row) => sum + row.costBasis, 0);
    const marketValue = holdings.reduce((sum, row) => sum + (row.marketValue ?? row.costBasis), 0);
    const priced = holdings.filter((row) => row.marketValue !== null).length;
    return {
      updatedAt: portfolio.updatedAt,
      holdings,
      summary: {
        costBasis,
        marketValue,
        profitLoss: marketValue - costBasis,
        returnRate: costBasis > 0 ? ((marketValue - costBasis) / costBasis) * 100 : 0,
        priced,
        total: holdings.length,
      },
    };
  }

  async #enrich(holding) {
    const hasQuantity = Number(holding.quantity) > 0;
    const averagePrice = hasQuantity ? holding.costBasis / holding.quantity : null;
    if (Number.isFinite(holding.manualMarketValue)) {
      const profitLoss = holding.manualMarketValue - holding.costBasis;
      return {
        ...holding,
        averagePrice,
        currentPrice: null,
        marketValue: holding.manualMarketValue,
        profitLoss,
        returnRate: (profitLoss / holding.costBasis) * 100,
        valuation: "manual",
      };
    }
    let currentPrice = null;
    try {
      if (!holding.symbol || !hasQuantity) throw new Error("quote unavailable");
      const response = await this.fetch(`https://m.stock.naver.com/api/stock/${holding.symbol}/basic`, {
        signal: AbortSignal.timeout(5000),
        headers: { "user-agent": "ai-workmate/1.0" },
      });
      if (!response.ok) throw new Error(`quote API ${response.status}`);
      const quote = await response.json();
      currentPrice = Number(String(quote.closePrice ?? "").replaceAll(",", "")) || null;
    } catch {
      // Keep the registered basis visible when a quote is temporarily unavailable.
    }
    const marketValue = currentPrice === null ? null : currentPrice * holding.quantity;
    const profitLoss = marketValue === null ? null : marketValue - holding.costBasis;
    return {
      ...holding,
      averagePrice,
      currentPrice,
      marketValue,
      profitLoss,
      returnRate: profitLoss === null ? null : (profitLoss / holding.costBasis) * 100,
      valuation: currentPrice === null ? "unavailable" : "market",
    };
  }
}
