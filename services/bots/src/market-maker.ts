import type { Instrument, TradingClient } from "@ome/client";
import { computeQuotes, type Quote, type QuoteParams } from "./quotes.js";
import { QuotingBot } from "./quoting-bot.js";

export type MarketMakerParams = Omit<QuoteParams, "fair" | "position" | "tickSize" | "widening"> & {
  /** Client-side budget for orders plus cancels, kept under the gateway's limit. Defaults to 50/sec. */
  maxActionsPerSecond?: number;
  /**
   * Widen quotes when the gateway's volatility forecast is above normal: the
   * spread scales with forecast / `normalSigmaPct`, between 1x and `max`x.
   * Quoting the same spread into a volatile market is how market makers get
   * run over (adverse selection), so this is the first thing a real one does.
   */
  volatility?: { normalSigmaPct: number; max: number };
};

/** How much wider than usual to quote, given the forecast 15-minute volatility in percent. */
export function wideningFor(sigmaPct: number | null, settings: MarketMakerParams["volatility"]): number {
  if (sigmaPct === null || settings === undefined) return 1;
  return Math.min(settings.max, Math.max(1, sigmaPct / settings.normalSigmaPct));
}

/**
 * Keeps a ladder of quotes on one instrument around a fair value supplied by
 * the caller (a random walk, or the live Binance price), with inventory skew
 * and volatility widening (see computeQuotes).
 */
export class MarketMaker extends QuotingBot {
  constructor(
    client: TradingClient,
    instrument: Instrument,
    fair: () => number,
    private readonly params: MarketMakerParams,
    intervalMs = 250,
  ) {
    super(client, instrument, fair, params.maxActionsPerSecond ?? 50, intervalMs);
  }

  /** The current spread multiplier from the volatility forecast. */
  get widening(): number {
    return wideningFor(this.sigmaPct, this.params.volatility);
  }

  protected desiredQuotes(): Quote[] {
    return computeQuotes({
      ...this.params,
      fair: this.fair(),
      position: this.tracker.position,
      tickSize: this.instrument.tickSize,
      widening: this.widening,
    });
  }
}
