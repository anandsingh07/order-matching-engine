import { contractMultiplier, instrumentKind, type Instrument, type MarketStatus, type TradingClient } from "@ome/client";
import { computeOptionQuotes, keepCloseQuotes } from "./option-quotes.js";
import { OrderTracker } from "./order-tracker.js";
import { annualizedVolatility, greeks, noArbitrageBounds, yearsUntil, type Greeks } from "./pricing.js";
import type { Quote } from "./quotes.js";
import { QuotingBot } from "./quoting-bot.js";

export interface DerivativesMakerParams {
  /** Contracts per quote. */
  size: number;
  /**
   * An option's half-spread as a share of its volatility: 0.08 quotes the
   * price change of an 8% (relative) move in volatility either side of value.
   * Uncertainty about volatility is an option market maker's main risk, and
   * vega x volatility puts it in price terms for every strike and expiry.
   */
  volSpread: number;
  /**
   * An option's half-spread is at least this many basis points of the
   * underlying's price times its delta. A deep in-the-money option moves with
   * the stock rupee for rupee but has almost no vega, so the volatility spread
   * alone would quote it a tick or two around value: tighter than the stock
   * itself, and below intrinsic value after the first stock move it has not
   * yet requoted for. (The live check measured exactly that; see derivatives-live.ts.)
   */
  deltaSpreadBps: number;
  /** The future's half-spread, in basis points of the underlying's price. */
  futureHalfSpreadBps: number;
  /** Never quote closer to value than this many ticks. */
  minHalfSpreadTicks: number;
  /** Most contracts held in any one series; at the limit the side that would add to it stops. */
  maxContracts: number;
  /** Most delta held, in units of the underlying (shares); at the limit, quotes that would add to it stop. */
  maxDelta: number;
  /**
   * How far the valuation leans at the delta limit, in basis points of the
   * underlying: long delta, everything is valued as if the underlying were
   * that much lower, so calls and the future are offered more keenly and puts
   * bid more keenly, all trades that reduce delta. (The stock market maker's
   * inventory skew, generalised to a book of options.)
   */
  skewBps: number;
  /** Most vega held, in currency per volatility point; at the limit, bids (or offers) on options stop. */
  maxVega: number;
  /** Hedge with the underlying once delta passes this many shares; null never hedges. */
  hedgeThreshold: number | null;
  /** Largest single hedge order, in shares. */
  maxHedge: number;
  /** Pull every quote this long before expiry: the settlement price is being set, and the gateway cancels at expiry anyway. */
  stopBeforeExpiryMs: number;
  intervalMs: number;
  /** Client-side action budget over all of the underlying's series, under the gateway's per-connection limit. */
  maxActionsPerSecond: number;
  /** Volatility before the gateway publishes a forecast for the underlying: a typical 15-minute move, in percent. */
  defaultSigmaPct: number;
}

export const DEFAULT_DERIVATIVES_MAKER: DerivativesMakerParams = {
  size: 5,
  volSpread: 0.08,
  // A little wider than the stock's own 4 bp half-spread.
  deltaSpreadBps: 5,
  futureHalfSpreadBps: 3,
  minHalfSpreadTicks: 2,
  maxContracts: 50,
  maxDelta: 500,
  skewBps: 10,
  maxVega: 150,
  hedgeThreshold: 100,
  maxHedge: 200,
  stopBeforeExpiryMs: 5_000,
  intervalMs: 500,
  maxActionsPerSecond: 60,
  defaultSigmaPct: 1.5,
};

/** What the desk knows when it quotes a series. */
export interface DeskState {
  /** The underlying's price, in ticks. */
  spot: number;
  /** Annualised. */
  volatility: number;
  now: number;
  /** The whole book's delta, in units of the underlying, and vega, in currency per volatility point. */
  delta: number;
  vega: number;
}

/**
 * The quotes for one series, given the desk's state and the position held in
 * it: centred on value (Black-Scholes, or the underlying's price for the
 * future) leaned against the book's delta, spread by vega x volatility, cut
 * off by the position, delta and vega limits, and kept inside the
 * no-arbitrage bounds. Also returns the half-spread and the bounds used.
 */
export function seriesQuotes(
  series: Instrument,
  position: number,
  state: DeskState,
  p: DerivativesMakerParams,
): { quotes: Quote[]; halfSpread: number; bounds: { lower: number; upper: number } } {
  const option = instrumentKind(series) === "option";
  const time = yearsUntil(series.expiry!, state.now);
  const bounds = option ? noArbitrageBounds({ right: series.right!, spot: state.spot, strike: series.strike!, time }) : { lower: 0, upper: Infinity };
  if (series.expiry! - state.now <= p.stopBeforeExpiryMs) return { quotes: [], halfSpread: 0, bounds };
  const lean = Math.max(-1, Math.min(1, state.delta / p.maxDelta));
  const spot = state.spot * (1 - (lean * p.skewBps) / 10_000);
  const g = option
    ? greeks({ right: series.right!, spot, strike: series.strike!, time, volatility: state.volatility })
    : { price: spot, delta: 1, vega: 0 };
  const tick = series.tickSize;
  const halfSpread = Math.max(
    p.minHalfSpreadTicks * tick,
    option
      ? Math.max(p.volSpread * state.volatility * g.vega, (p.deltaSpreadBps / 10_000) * Math.abs(g.delta) * state.spot)
      : (p.futureHalfSpreadBps / 10_000) * state.spot,
  );
  // Buying this series adds delta of this sign: calls and the future long, puts short. (From the
  // contract, not the computed delta, which far out of the money rounds to zero.)
  const sign = option && series.right === "put" ? -1 : 1;
  let bid = position < p.maxContracts;
  let ask = position > -p.maxContracts;
  if (state.delta >= p.maxDelta) {
    if (sign > 0) bid = false;
    if (sign < 0) ask = false;
  } else if (state.delta <= -p.maxDelta) {
    if (sign > 0) ask = false;
    if (sign < 0) bid = false;
  }
  if (option && state.vega >= p.maxVega) bid = false;
  if (option && state.vega <= -p.maxVega) ask = false;
  return { quotes: computeOptionQuotes({ fair: g.price, halfSpread, bounds, tickSize: tick, size: p.size, bid, ask }), halfSpread, bounds };
}

/** One series' resting quotes; the desk decides what they should be. */
class SeriesQuoter extends QuotingBot {
  /** The underlying's price, the delta and the half-spread the current quotes were made with. */
  quotedAt: { spot: number; delta: number; halfSpread: number } | null = null;

  constructor(
    client: TradingClient,
    readonly series: Instrument,
    private readonly desk: DerivativesMarketMaker,
    perSecond: number,
    intervalMs: number,
  ) {
    // Quotes move with the underlying all the time: amending keeps both sides up through every move.
    super(client, series, () => desk.value(series), perSecond, intervalMs, { amend: true });
  }

  protected desiredQuotes(): Quote[] {
    return this.desk.quotesFor(this.series, this.tracker);
  }
}

/**
 * Makes markets in every live future and option on one underlying, through
 * one connection: around Black-Scholes value for options (the future: the
 * underlying's price), using the gateway's volatility forecast for the
 * underlying from its status messages, within position, delta and vega
 * limits, and hedging its delta in the underlying.
 *
 * It follows the listing cycle by itself: series that appear in an
 * `instruments` message get quotes, and expired ones are dropped (the
 * gateway has cancelled their orders and settled the position in cash).
 */
export class DerivativesMarketMaker {
  private readonly params: DerivativesMakerParams;
  private readonly quoters = new Map<string, SeriesQuoter>();
  /** The underlying shares bought or sold to hedge. */
  readonly hedge: OrderTracker;
  private bestBid: number | undefined;
  private bestAsk: number | undefined;
  private lastTrade: number | undefined;
  private sigmaPct: number | null = null;
  private auction = false;
  private hedging = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly offs: (() => void)[] = [];
  /** Reject reasons of hedge orders, for monitoring and tests. */
  readonly hedgeRejects = new Map<string, number>();

  constructor(
    private readonly client: TradingClient,
    readonly underlying: Instrument,
    params: Partial<DerivativesMakerParams> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.params = { ...DEFAULT_DERIVATIVES_MAKER, ...params };
    this.hedge = new OrderTracker(underlying.symbol);
  }

  /** Starts quoting the live series among `instruments` (the gateway's list). */
  async start(instruments: Instrument[]): Promise<void> {
    const symbol = this.underlying.symbol;
    this.offs.push(
      this.client.on("book", (m) => {
        if (m.symbol !== symbol) return;
        this.bestBid = m.bids[0]?.price;
        this.bestAsk = m.asks[0]?.price;
        this.requoteMoved();
      }),
      this.client.on("trade", (m) => {
        if (m.symbol === symbol) this.lastTrade = m.trade.price;
      }),
      this.client.on("status", (m) => this.onStatus(m)),
      this.client.on("instruments", (m) => this.sync(m.instruments)),
      this.client.on("execution", (m) => this.hedge.handle(m)),
    );
    this.client.subscribe([`book:${symbol}`, `trades:${symbol}`]);
    // Statuses sent on connect may have arrived before these listeners existed.
    const statuses = (await (await fetch(`${this.client.baseUrl}/api/status`)).json()) as MarketStatus[];
    for (const status of statuses) this.onStatus(status);
    this.running = true;
    this.sync(instruments);
    this.timer = setInterval(() => void this.rehedge(), this.params.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.timer);
    for (const off of this.offs.splice(0)) off();
    await Promise.all([...this.quoters.values()].map((q) => q.stop()));
    this.quoters.clear();
    while (this.hedging) await new Promise((r) => setTimeout(r, 5));
  }

  /** The series being quoted. */
  get series(): Instrument[] {
    return [...this.quoters.values()].map((q) => q.series);
  }

  /** Each series' quotes, position and fills. */
  get trackers(): OrderTracker[] {
    return [...this.quoters.values()].map((q) => q.tracker);
  }

  /** Reject reasons over all series' quotes. */
  get rejectCounts(): Map<string, number> {
    const all = new Map(this.hedgeRejects);
    for (const q of this.quoters.values()) for (const [reason, n] of q.rejectCounts) all.set(reason, (all.get(reason) ?? 0) + n);
    return all;
  }

  /** The underlying's price as the market shows it: the mid, else the last trade, else its reference price. */
  underlyingPrice(): number {
    if (this.bestBid !== undefined && this.bestAsk !== undefined) return (this.bestBid + this.bestAsk) / 2;
    return this.lastTrade ?? this.underlying.referencePrice;
  }

  /** Annualised volatility from the gateway's forecast for the underlying. */
  volatility(): number {
    return annualizedVolatility(this.sigmaPct ?? this.params.defaultSigmaPct, 15);
  }

  /** Value and Greeks per unit of the underlying, in ticks; a future has delta 1 and nothing else. */
  greeksOf(series: Instrument, spot = this.underlyingPrice()): Greeks {
    if (instrumentKind(series) !== "option") return { price: spot, delta: 1, gamma: 0, vega: 0, theta: 0 };
    return greeks({
      right: series.right!,
      spot,
      strike: series.strike!,
      time: yearsUntil(series.expiry!, this.now()),
      volatility: this.volatility(),
    });
  }

  value(series: Instrument): number {
    return this.greeksOf(series).price;
  }

  /** Delta in units of the underlying (hedge included), and vega in currency per volatility point. */
  exposure(spot = this.underlyingPrice()): { delta: number; vega: number } {
    let delta = this.hedge.position / this.underlying.quantityScale;
    let vega = 0;
    for (const { series, tracker } of this.quoters.values()) {
      if (tracker.position === 0) continue;
      const g = this.greeksOf(series, spot);
      const units = tracker.position * contractMultiplier(series);
      delta += units * g.delta;
      vega += (units * g.vega * 0.01) / series.priceScale;
    }
    return { delta, vega };
  }

  /** What one series should be quoting now. */
  quotesFor(series: Instrument, tracker: OrderTracker): Quote[] {
    if (!this.running || this.auction) return [];
    const spot = this.underlyingPrice();
    const state = { spot, volatility: this.volatility(), now: this.now(), ...this.exposure(spot) };
    const { quotes, halfSpread, bounds } = seriesQuotes(series, tracker.position, state, this.params);
    const quoter = this.quoters.get(series.symbol);
    if (quoter !== undefined) quoter.quotedAt = { spot, delta: this.greeksOf(series, spot).delta, halfSpread };
    // A resting quote close to the new price keeps its place in the queue, and the action budget.
    return keepCloseQuotes(quotes, [...tracker.open.values()], halfSpread / 4, bounds, series.tickSize);
  }

  /**
   * Requotes, straight away rather than on the next timer tick, every series
   * whose value the underlying has moved by more than half its half-spread
   * since it was quoted. Between ticks a stale quote is a free option for
   * anyone watching the stock; most moves are smaller than that and cost no
   * actions at all.
   */
  private requoteMoved(): void {
    if (!this.running || this.auction) return;
    const spot = this.underlyingPrice();
    for (const quoter of this.quoters.values()) {
      const at = quoter.quotedAt;
      if (at !== null && Math.abs((spot - at.spot) * at.delta) > at.halfSpread / 2) void quoter.requote();
    }
  }

  private onStatus(status: MarketStatus): void {
    if (status.symbol !== this.underlying.symbol) return;
    this.sigmaPct = status.volatility?.sigmaPct ?? null;
    // No quotes while the underlying is halted: its derivatives cannot trade then.
    this.auction = status.phase === "auction";
  }

  /** Quotes the underlying's live series and drops the ones that have gone. */
  private sync(instruments: Instrument[]): void {
    if (!this.running) return;
    const live = instruments.filter((i) => i.underlying === this.underlying.symbol && instrumentKind(i) !== "spot" && i.expiry! > this.now());
    const symbols = new Set(live.map((i) => i.symbol));
    for (const [symbol, quoter] of this.quoters) {
      if (symbols.has(symbol)) continue;
      this.quoters.delete(symbol);
      void quoter.stop();
    }
    const perSeries = Math.max(2, Math.floor(this.params.maxActionsPerSecond / Math.max(1, live.length)));
    for (const series of live) {
      if (this.quoters.has(series.symbol)) continue;
      const quoter = new SeriesQuoter(this.client, series, this, perSeries, this.params.intervalMs);
      this.quoters.set(series.symbol, quoter);
      quoter.start();
    }
  }

  /** Brings delta back inside the threshold with an IOC order at the underlying's touch, so a hedge never sweeps the book. */
  private async rehedge(): Promise<void> {
    const threshold = this.params.hedgeThreshold;
    if (threshold === null || this.hedging || this.auction || !this.client.open) return;
    const { delta } = this.exposure();
    if (Math.abs(delta) <= threshold) return;
    const side = delta > 0 ? "sell" : "buy";
    const price = side === "sell" ? this.bestBid : this.bestAsk;
    const lot = this.underlying.lotSize;
    const quantity = Math.min(this.params.maxHedge, Math.floor((Math.abs(delta) * this.underlying.quantityScale) / lot) * lot);
    if (price === undefined || quantity <= 0) return;
    this.hedging = true;
    try {
      const result = await this.client.placeOrder(this.underlying.symbol, this.client.newOrderId("hedge"), {
        type: "limit",
        side,
        price,
        quantity,
        timeInForce: "IOC",
      });
      if (result.type !== "ack") {
        const reason = result.type === "reject" ? result.reason : result.message;
        this.hedgeRejects.set(reason, (this.hedgeRejects.get(reason) ?? 0) + 1);
      }
    } finally {
      this.hedging = false;
    }
  }
}
