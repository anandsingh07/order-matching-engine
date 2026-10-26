import { instrumentKind, type ClientOrder, type Instrument, type MarketStatus, type TradingPhase } from "@ome/client";
import type { Exchange } from "@ome/exchange";
import type { Forecast } from "@ome/volatility";

export interface MarketRules {
  /** Length of the opening call auction at startup; 0 starts straight in continuous trading. */
  openingAuctionMs: number;
  /** Static price band: limit and stop prices must be within this percentage of the reference price. */
  bandPct: number;
  /**
   * Volatility circuit breaker: if the price moves more than `movePct` within
   * `windowMs`, the symbol halts into a call auction for `haltMs`.
   */
  circuitBreaker: { windowMs: number; movePct: number; haltMs: number } | null;
  /**
   * Volatility-aware limits. Once a symbol has a volatility forecast, its band
   * is `bandSigmas` expected 15-minute moves and its breaker trips on a move
   * of `breakerSigmas` expected moves over the breaker window. They only ever
   * tighten the static settings above, so a bad forecast cannot remove
   * protection, and never below the floors, so ordinary noise does not halt
   * a calm market.
   */
  volatility: { bandSigmas: number; minBandPct: number; breakerSigmas: number; minBreakerPct: number } | null;
}

export const DEFAULT_RULES: MarketRules = { openingAuctionMs: 0, bandPct: 10, circuitBreaker: null, volatility: null };

const MINUTE_MS = 60_000;

interface Tick {
  time: number;
  price: number;
}

interface SymbolState {
  instrument: Instrument;
  phase: TradingPhase;
  reason: MarketStatus["reason"];
  until: number | null;
  /** Last trade price, or the instrument's reference before any trade. */
  reference: number;
  /**
   * The circuit breaker's window, as its running low and high: each list is
   * oldest first, `lows` rising and `highs` falling, so the first entry of
   * each is the lowest or highest price within the window.
   */
  lows: Tick[];
  highs: Tick[];
  indicative: MarketStatus["indicative"];
  halting: boolean;
  /** Derivatives: the band last published, to republish only when it moves. */
  publishedBand: { low: number; high: number } | null;
}

/**
 * Market-wide protections the matching engine does not decide on its own:
 * when auctions start and end, price bands, and the circuit breaker.
 *
 * Phase changes are sent to the engine as ordinary commands (start_auction,
 * uncross). They are ordered with the orders around them and journaled, so a
 * recovered engine replays exactly the same halts. This class tracks the
 * phase from the engine's own phase events, not from what it asked for.
 */
export class MarketControl {
  private readonly states = new Map<string, SymbolState>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly exchange: Exchange,
    instruments: Instrument[],
    private readonly now: () => number,
    private readonly rules: MarketRules,
    private readonly publish: (status: MarketStatus) => void,
    private readonly forecast: (symbol: string) => Forecast | null = () => null,
    /**
     * The band for a derivative, as prices, or null for anything else. An
     * option moves several times as far as its underlying in percent, so a
     * percentage band around its own last trade means nothing; its band comes
     * from its underlying's (see derivatives.ts).
     */
    private readonly derivativeBand: (symbol: string) => { low: number; high: number } | null = () => null,
  ) {
    for (const instrument of instruments) this.states.set(instrument.symbol, MarketControl.initial(instrument));
  }

  private static initial(instrument: Instrument): SymbolState {
    return {
      instrument,
      phase: "continuous",
      reason: null,
      until: null,
      reference: instrument.referencePrice,
      lows: [],
      highs: [],
      indicative: null,
      halting: false,
      publishedBand: null,
    };
  }

  /** Starts tracking a newly listed symbol, trading continuously, and publishes its status. */
  add(instrument: Instrument): void {
    if (this.states.has(instrument.symbol)) return;
    this.states.set(instrument.symbol, MarketControl.initial(instrument));
    this.republish(instrument.symbol);
  }

  /** Stops tracking a delisted symbol. */
  remove(symbol: string): void {
    this.states.delete(symbol);
  }

  /** Runs the opening auction, if configured. */
  async start(): Promise<void> {
    if (this.rules.openingAuctionMs <= 0) return;
    await Promise.all([...this.states.keys()].map((symbol) => this.beginAuction(symbol, "opening", this.rules.openingAuctionMs)));
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  referencePrice(symbol: string): number {
    return this.states.get(symbol)?.reference ?? 0;
  }

  status(symbol: string): MarketStatus | undefined {
    const s = this.states.get(symbol);
    if (s === undefined) return undefined;
    const f = this.forecast(symbol);
    const band = this.derivativeBand(symbol);
    return {
      symbol,
      phase: s.phase,
      reason: s.reason,
      until: s.until,
      referencePrice: s.reference,
      indicative: s.indicative,
      // For a derivative, the widest distance of its band from the reference, for clients that only read the percentage.
      bandPct: band === null ? this.bandPct(symbol) : (Math.max(band.high - s.reference, s.reference - band.low) / s.reference) * 100,
      breakerPct: band === null ? this.breakerPct(symbol) : null,
      volatility: f === null ? null : { sigmaPct: f.sigma * 100, horizonMinutes: f.horizonMinutes, model: f.model },
      ...(band === null ? {} : { band }),
    };
  }

  all(): MarketStatus[] {
    return [...this.states.keys()].map((symbol) => this.status(symbol)!);
  }

  /** Publishes a symbol's status again, say because its volatility forecast changed. */
  republish(symbol: string): void {
    const status = this.status(symbol);
    if (status === undefined) return;
    this.states.get(symbol)!.publishedBand = status.band ?? null;
    this.publish(status);
  }

  /** Republishes derivatives whose band has moved since it was last published (it follows the underlying). */
  refreshBands(): void {
    for (const [symbol, s] of this.states) {
      const band = this.derivativeBand(symbol);
      if (band !== null && (band.low !== s.publishedBand?.low || band.high !== s.publishedBand.high)) this.republish(symbol);
    }
  }

  /** The price band in force, as a percentage either side of the reference price. */
  bandPct(symbol: string): number {
    const v = this.rules.volatility;
    const f = this.forecast(symbol);
    // A forecast that is not a number would make the band NaN, and every price would pass.
    if (v === null || f === null || !Number.isFinite(f.sigma)) return this.rules.bandPct;
    return Math.min(this.rules.bandPct, Math.max(v.minBandPct, v.bandSigmas * f.sigma * 100));
  }

  /** The move that trips the circuit breaker, as a percentage within its window; null when there is no breaker. */
  breakerPct(symbol: string): number | null {
    const breaker = this.rules.circuitBreaker;
    if (breaker === null) return null;
    const v = this.rules.volatility;
    const f = this.forecast(symbol);
    // Likewise a NaN limit would never trip.
    if (v === null || f === null || !Number.isFinite(f.sigma)) return breaker.movePct;
    // Volatility grows with the square root of time.
    const sigmaWindow = f.sigma * Math.sqrt(breaker.windowMs / (f.horizonMinutes * MINUTE_MS));
    return Math.min(breaker.movePct, Math.max(v.minBreakerPct, v.breakerSigmas * sigmaWindow * 100));
  }

  /** Rejects limit and stop prices outside the band around the reference price. */
  checkBand(symbol: string, order: Pick<ClientOrder, "type"> & { price?: number; stopPrice?: number; limitPrice?: number }): string | null {
    const s = this.states.get(symbol);
    if (s === undefined) return null;
    const prices = [order.price, order.stopPrice, order.limitPrice].filter((p): p is number => p !== undefined);
    const derivative = this.derivativeBand(symbol);
    if (derivative !== null) return prices.some((p) => p < derivative.low || p > derivative.high) ? "price_outside_band" : null;
    const band = (s.reference * this.bandPct(symbol)) / 100;
    return prices.some((p) => p < s.reference - band || p > s.reference + band) ? "price_outside_band" : null;
  }

  onTrade(symbol: string, price: number, time: number): void {
    const s = this.states.get(symbol);
    if (s === undefined) return;
    s.reference = price;
    const breaker = this.rules.circuitBreaker;
    // Uncross trades arrive before the phase event that ends the auction; they
    // set the new reference but do not count towards a fresh halt. Derivatives
    // have no breaker of their own: they stop trading when their underlying halts.
    if (breaker === null || s.phase !== "continuous" || s.halting || instrumentKind(s.instrument) !== "spot") return;
    // The move is measured from the lowest and highest prices in the window,
    // not from its oldest trade: a fall and a sharp rise within the window is
    // a move from the low, however close the price is to where the window began.
    const since = time - breaker.windowMs;
    MarketControl.track(s.lows, { time, price }, since, (kept) => kept.price < price);
    MarketControl.track(s.highs, { time, price }, since, (kept) => kept.price > price);
    const low = s.lows[0]!.price;
    const high = s.highs[0]!.price;
    const movePct = Math.max((price - low) / low, (high - price) / high) * 100;
    if (movePct > this.breakerPct(symbol)!) void this.halt(symbol, breaker.haltMs);
  }

  /**
   * Adds a trade to a running low or high: trades it outranks can never be the
   * extreme again, so they go, and so do trades older than the window.
   */
  private static track(ticks: Tick[], tick: Tick, since: number, keeps: (kept: Tick) => boolean): void {
    while (ticks.length > 0 && !keeps(ticks.at(-1)!)) ticks.pop();
    ticks.push(tick);
    while (ticks[0]!.time < since) ticks.shift();
  }

  onPhase(symbol: string, phase: TradingPhase, auctionPrice: number | null): void {
    const s = this.states.get(symbol);
    if (s === undefined) return;
    s.phase = phase;
    if (phase === "continuous") {
      s.reason = null;
      s.until = null;
      s.indicative = null;
      // The breaker starts again from the reopening price. Trades before the
      // auction are dropped, or the move that halted it would halt it again at
      // once; but the uncross price must take their place, or the first trade
      // after a reopen would be its own reference and a sweep straight after
      // it could move the price any distance unchecked. A move away from the
      // reopening price halts again even when it heads back to where the price
      // was before the spike: the auction is the market's price, and a fast
      // move from it is still a fast move.
      const open = auctionPrice === null ? [] : [{ time: this.now(), price: auctionPrice }];
      s.lows = [...open];
      s.highs = [...open];
      if (auctionPrice !== null) s.reference = auctionPrice;
    }
    this.publish(this.status(symbol)!);
  }

  /** Refreshes and publishes the indicative uncross price of every symbol in an auction. */
  async refreshIndicative(): Promise<void> {
    await Promise.all(
      [...this.states.entries()]
        .filter(([, s]) => s.phase === "auction")
        .map(async ([symbol, s]) => {
          s.indicative = await this.exchange.indicative(symbol);
          if (s.phase === "auction") this.publish(this.status(symbol)!);
        }),
    );
  }

  private async halt(symbol: string, haltMs: number): Promise<void> {
    const s = this.states.get(symbol)!;
    s.halting = true;
    try {
      await this.beginAuction(symbol, "circuit_breaker", haltMs);
    } catch {
      // The engine did not take the halt, so the symbol is still trading: say
      // so, and let the next trade that breaks the limit try again.
      s.reason = null;
      s.until = null;
    } finally {
      s.halting = false;
    }
  }

  private async beginAuction(symbol: string, reason: NonNullable<MarketStatus["reason"]>, durationMs: number): Promise<void> {
    const s = this.states.get(symbol)!;
    s.reason = reason;
    s.until = this.now() + durationMs;
    await this.exchange.send(symbol, { type: "start_auction" });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.exchange.send(symbol, { type: "uncross" }).catch(() => {});
    }, durationMs);
    timer.unref();
    this.timers.add(timer);
  }
}
