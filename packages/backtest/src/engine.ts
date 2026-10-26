import type { Instrument, Side } from "@ome/client";
import { OrderBook } from "@ome/core";
import { loadManifest, VolatilityForecaster, type Forecast, type VolatilityManifest } from "@ome/volatility";
import { BTCUSDT, MINUTE_MS } from "./data.js";
import { BAR_MARKOUT_HORIZONS_MS, MARKOUT_HORIZONS_MS, markouts, quotePlacement, summarise, type Accumulators } from "./metrics.js";
import type {
  ActionRecord,
  BacktestConfig,
  BacktestResult,
  Fill,
  Liquidity,
  MarketData,
  MarketTrade,
  MinuteBar,
  RejectReason,
  Strategy,
  StrategyContext,
  StrategyOrder,
} from "./types.js";

/**
 * An event-driven backtester: a strategy trades against a real historical
 * tape, through the real matching engine, on a simulated clock.
 *
 * The market model, and why:
 *
 * - The tape is taker flow. Each historical trade is replayed as an IOC
 *   order into an @ome/core OrderBook that holds only the strategy's resting
 *   quotes, so price-time priority and partial fills are the engine's own.
 *   It is capped at the historical quantity: our quote can take the place of
 *   liquidity that really traded, never add volume that did not.
 * - Queue position is unknowable from trades alone (the tape carries no
 *   depth), so there are two models of it. The default, `through`, is the
 *   conservative one: a quote fills only when the market trades strictly
 *   through its price, which means every order ahead of it at that price
 *   must have filled (we were last in the queue). A quote that improved the
 *   market is the best price, so the next trade on its side prints through
 *   it and fills it, as it would really. `touch` is the optimistic one: a
 *   trade at our price fills us, as if we were first in the queue. Running
 *   both shows how much a result depends on queue position; they are two
 *   models of it, not exact bounds on the truth.
 * - A print also proves an order on its far side: a buyer-initiated trade at
 *   P lifted an ask resting at P. A bid of ours at P or above cannot have
 *   rested beside that ask, because whoever offered at P would have sold to
 *   us first. So in both models such a print fills our crossed quotes at
 *   their own prices, capped by its size (at least that much was offered at
 *   P), instead of leaving them resting through the market.
 * - The rest of the market's touch comes from the tape: a buyer-initiated
 *   trade printed at the ask and a seller-initiated one at the bid, and
 *   BTC/USDT trades on a one-tick spread almost all the time, so the other
 *   side is one tick away. A post-only quote that would cross the touch is
 *   rejected on arrival, as an exchange rejects a crossing post-only order.
 *   A plain limit order (postOnly: false, what the live bots send) that
 *   crosses the touch takes liquidity instead, as it would live: it fills in
 *   full at once like a market order, but never at worse than its limit. A
 *   quote through the strategy's own opposite quote is rejected either way,
 *   as the exchange's self-trade prevention cancels the incoming order.
 * - Market orders fill in full at the touch plus `slippageBps`, at the touch
 *   as it is when they arrive, and pay the taker fee.
 * - Bar data (1-minute klines) says what a minute did but not when: its open
 *   printed at some unknown moment after the minute began. So a bar is one
 *   event, at its close, and until then the price is the last close: a
 *   market order fills off the last price known to exist when it arrives,
 *   with a two-tick spread, never off a later open.
 * - Latency: every action (place, cancel, market) takes effect `latencyMs`
 *   after the strategy decides, and in the order sent. Market data and fill
 *   reports reach the strategy at once, so latency is the round trip. Fills
 *   caused by a print are reported once the print itself is in, so `onFill`
 *   already sees the price the sweep reached.
 * - Our trading does not move the historical prices that follow (no market
 *   impact). That is fair for small orders in a market as deep as BTC/USDT,
 *   and wrong for large ones.
 *
 * No look-ahead, by construction: events run strictly in time order, and a
 * strategy only ever receives the event at hand and a context of what has
 * already happened. At equal timestamps, minute bars close first, then the
 * tape, then actions arriving at the exchange, then timers. So an action
 * that arrives in the same millisecond as a trade misses it, and a cancel in
 * the same millisecond is too late: both the conservative way round.
 */

const OWNER = "strategy";
const TAPE = "tape";

export const DEFAULT_CONFIG: BacktestConfig = {
  instrument: BTCUSDT,
  latencyMs: 50,
  makerFeeBps: 0,
  takerFeeBps: 0,
  slippageBps: 1,
  queue: "through",
  capital: 100_000,
  sampleMs: 1_000,
};

// Event priorities at equal timestamps (see above). Minute boundaries are not
// queued: the loop closes a minute before anything else at its time.
const MARKET = 1;
const ACTION = 2;
const TIMER = 3;

interface SimOrder {
  id: string;
  type: "limit" | "market";
  side: Side;
  price: number | null;
  quantity: number;
  filled: number;
  status: StrategyOrder["status"];
  sentAt: number;
  cancelRequested: boolean;
  postOnly: boolean;
  tag: string | undefined;
}

/** What the strategy is shown of an order: the engine's bookkeeping fields stay out. */
const view = ({ postOnly: _postOnly, tag: _tag, ...order }: SimOrder): StrategyOrder => ({ ...order });

type Queued =
  | { kind: "arrive"; order: SimOrder }
  | { kind: "cancel"; orderId: string }
  | { kind: "timer"; tag: string; interval: number | null };

/** One of our quotes matched by a print, before it is booked. */
interface Matched {
  orderId: string;
  price: number;
  quantity: number;
}

interface Entry {
  time: number;
  priority: number;
  seq: number;
  event: Queued;
}

const before = (a: Entry, b: Entry) => a.time < b.time || (a.time === b.time && (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)));

/** A binary min-heap of strategy events by (time, priority, sequence). */
class EventQueue {
  private readonly heap: Entry[] = [];
  private seq = 0;

  push(time: number, priority: number, event: Queued): void {
    const h = this.heap;
    h.push({ time, priority, seq: this.seq++, event });
    for (let i = h.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!before(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  peek(): Entry | undefined {
    return this.heap[0];
  }

  pop(): Entry | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (top === undefined || last === undefined || h.length === 0) return top;
    h[0] = last;
    for (let i = 0; ; ) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && before(h[l]!, h[m]!)) m = l;
      if (r < h.length && before(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
    return top;
  }
}

export interface RunOptions {
  /** The volatility models (defaults to @ome/volatility's trained manifest). */
  manifest?: VolatilityManifest;
}

export interface BacktestRun {
  result: BacktestResult;
  fills: Fill[];
  actions: ActionRecord[];
}

const isPositiveInteger = (n: number) => Number.isSafeInteger(n) && n > 0;

class Simulation {
  private readonly cfg: BacktestConfig;
  private readonly instrument: Instrument;
  /** Ticks x units -> quote currency. */
  private readonly scale: number;
  private readonly book = new OrderBook();
  private readonly queue = new EventQueue();
  private readonly orders = new Map<string, SimOrder>();
  private readonly live = new Map<string, SimOrder>();
  private readonly forecaster: VolatilityForecaster;
  private forecast: Forecast | null = null;
  private readonly history: MinuteBar[];
  /** The minute being built from the tape; null before the first trade. */
  private bar: (MinuteBar & { traded: boolean }) | null = null;
  private readonly fills: Fill[] = [];
  private readonly actions: ActionRecord[] = [];
  /** Each limit order's distance from the last trade price when it was decided, in bps (null before the first trade). */
  private readonly quoteDistance = new Map<string, number | null>();
  /** Plain limit orders that crossed the touch on arrival and took liquidity. */
  private readonly marketable = { orders: 0, quantity: 0 };
  private nextId = 1;

  private now: number;
  private lastPrice: number | null = null;
  private lastTaker: Side = "buy";
  private position = 0;
  /** Exact: sales minus purchases, in ticks x units. */
  private cashFlow = 0;
  /** In ticks x units. */
  private feeTicks = 0;
  private readonly acc: Accumulators;
  private readonly ctx: StrategyContext;

  constructor(
    private readonly strategy: Strategy,
    private readonly data: MarketData,
    config: BacktestConfig,
    manifest: VolatilityManifest,
  ) {
    this.cfg = config;
    this.instrument = config.instrument;
    this.scale = config.instrument.priceScale * config.instrument.quantityScale;
    this.forecaster = new VolatilityForecaster(manifest);
    this.history = [...data.warmup];
    for (const bar of data.warmup) this.forecaster.push(bar);
    this.forecast = this.forecaster.forecast();
    const start = data.kind === "trades" ? (data.trades[0]?.time ?? 0) : (data.bars[0]?.time ?? 0);
    this.now = start;
    this.acc = {
      start,
      capital: config.capital,
      peak: config.capital,
      maxDrawdown: 0,
      maxDrawdownFraction: 0,
      lastTime: start,
      absIntegral: 0,
      integral: 0,
      maxAbs: 0,
      turnover: 0,
      makerFees: 0,
      takerFees: 0,
      fills: { count: 0, maker: 0, taker: 0, makerQuantity: 0, takerQuantity: 0 },
      orders: { limit: 0, market: 0, cancels: 0, rejected: {}, lateCancels: 0 },
      equity: [[start, config.capital]],
      price: [[start, null]],
      minuteEquity: [config.capital],
      nextSample: (Math.floor(start / config.sampleMs) + 1) * config.sampleMs,
      nextMinute: (Math.floor(start / MINUTE_MS) + 1) * MINUTE_MS,
    };
    this.ctx = this.context();
  }

  async run(): Promise<BacktestRun> {
    const end = this.endTime();
    await this.strategy.init?.(this.ctx);
    const trades = this.data.kind === "trades" ? this.data.trades : [];
    const bars = this.data.kind === "bars" ? this.data.bars : [];
    // Bar data is one market event per bar: the completed bar, at its close (see the top of the file).
    const marketCount = this.data.kind === "trades" ? trades.length : bars.length;
    const marketTime = (i: number) => (this.data.kind === "trades" ? trades[i]!.time : bars[i]!.time + MINUTE_MS);
    let boundary = this.data.kind === "trades" && trades.length > 0 ? (Math.floor(trades[0]!.time / MINUTE_MS) + 1) * MINUTE_MS : Infinity;
    let i = 0;

    for (;;) {
      const queued = this.queue.peek();
      const mTime = i < marketCount ? marketTime(i) : Infinity;
      const qTime = queued === undefined || queued.time > end ? Infinity : queued.time;
      const bTime = boundary <= end ? boundary : Infinity;
      if (mTime === Infinity && qTime === Infinity && bTime === Infinity) break;

      if (bTime <= mTime && bTime <= qTime) {
        this.advance(bTime);
        await this.closeMinute(bTime);
        boundary += MINUTE_MS;
      } else if (mTime <= qTime && (mTime < qTime || MARKET <= queued!.priority)) {
        this.advance(mTime);
        if (this.data.kind === "trades") await this.onTape(trades[i]!);
        else await this.onBarClose(bars[i]!);
        i++;
      } else {
        const entry = this.queue.pop()!;
        this.advance(entry.time);
        await this.onQueued(entry);
      }
    }

    this.advance(end);
    return { result: summarise(this.acc, this.resultFrame(end)), fills: this.fills, actions: this.actions };
  }

  private endTime(): number {
    if (this.data.kind === "trades") return this.data.trades.at(-1)?.time ?? this.now;
    const last = this.data.bars.at(-1);
    return last === undefined ? this.now : last.time + MINUTE_MS;
  }

  // ---- the clock and the books ----

  /** Moves the clock to `t`: samples equity at every boundary passed, and integrates inventory. */
  private advance(t: number): void {
    const a = this.acc;
    while (a.nextSample <= t) {
      a.equity.push([a.nextSample, this.equity()]);
      a.price.push([a.nextSample, this.lastPrice]);
      a.nextSample += this.cfg.sampleMs;
    }
    while (a.nextMinute <= t) {
      a.minuteEquity.push(this.equity());
      a.nextMinute += MINUTE_MS;
    }
    a.absIntegral += Math.abs(this.position) * (t - a.lastTime);
    a.integral += this.position * (t - a.lastTime);
    a.lastTime = t;
    this.now = t;
  }

  /** Equity in the quote currency, marked at `mark` (the last trade price unless given). */
  private equity(mark = this.lastPrice): number {
    const markValue = mark === null ? 0 : this.position * mark;
    return this.cfg.capital + (this.cashFlow + markValue - this.feeTicks) / this.scale;
  }

  private watchDrawdown(mark = this.lastPrice): void {
    const a = this.acc;
    const e = this.equity(mark);
    if (e > a.peak) a.peak = e;
    if (a.peak - e > a.maxDrawdown) a.maxDrawdown = a.peak - e;
    if (a.peak > 0 && (a.peak - e) / a.peak > a.maxDrawdownFraction) a.maxDrawdownFraction = (a.peak - e) / a.peak;
  }

  /** The rest of the market's best bid and ask. */
  private touch(): { bid: number; ask: number } | null {
    const p = this.lastPrice;
    if (p === null) return null;
    const tick = this.instrument.tickSize;
    // Bars say nothing about which side traded last: assume the price was the
    // mid of a two-tick spread, so a round trip pays a little more than on the tape.
    if (this.data.kind === "bars") return { bid: p - tick, ask: p + tick };
    return this.lastTaker === "buy" ? { bid: p - tick, ask: p } : { bid: p, ask: p + tick };
  }

  // ---- market events ----

  private async onTape(t: MarketTrade): Promise<void> {
    const matched: Matched[] = [];
    if (this.book.restingOrderCount > 0) {
      const tick = this.instrument.tickSize;
      // Through: only quotes strictly better than the print. Touch: quotes at the print too.
      const limit = this.cfg.queue === "touch" ? t.price : t.takerSide === "buy" ? t.price - tick : t.price + tick;
      if (limit > 0) this.cross(t.takerSide, limit, t.quantity, matched);
      // Quotes the print proves crossed (see the top of the file): bids at or above a
      // buyer-initiated print, asks at or below a seller-initiated one. Never both
      // in one print, since our own quotes never cross each other.
      this.cross(t.takerSide === "buy" ? "sell" : "buy", t.price, t.quantity, matched);
    }
    // The print's price first, so each fill's report already sees where the sweep went.
    // Each fill is booked as it is reported, so the position is always the fills
    // reported so far, and is checked for drawdown at its own price; then the print's.
    this.lastPrice = t.price;
    this.lastTaker = t.takerSide;
    for (const m of matched) {
      const fill = this.fill(this.orders.get(m.orderId)!, m.price, m.quantity, "maker");
      await this.strategy.onFill?.(this.ctx, fill);
    }
    this.watchDrawdown();
    this.onTapeBar(t);
    await this.strategy.onTrade?.(this.ctx, t);
  }

  /** Sends `quantity` of the tape's flow at our quotes as an IOC order on `side` at `limit`; collects what it matches. */
  private cross(side: Side, limit: number, quantity: number, matched: Matched[]): void {
    const best = side === "buy" ? this.book.bestAsk() : this.book.bestBid();
    if (best === null || (side === "buy" ? best > limit : best < limit)) return; // nothing of ours in reach
    const events = this.book.submit({ type: "limit", id: TAPE, traderId: TAPE, side, price: limit, quantity, timeInForce: "IOC" });
    for (const e of events) {
      if (e.type === "trade") matched.push({ orderId: e.makerOrderId, price: e.price, quantity: e.quantity });
    }
  }

  private onTapeBar(t: MarketTrade): void {
    const b = this.bar;
    if (b === null) {
      this.bar = { time: Math.floor(t.time / MINUTE_MS) * MINUTE_MS, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.quantity, traded: true };
    } else if (!b.traded) {
      Object.assign(b, { open: t.price, high: t.price, low: t.price, close: t.price, volume: t.quantity, traded: true });
    } else {
      b.high = Math.max(b.high, t.price);
      b.low = Math.min(b.low, t.price);
      b.close = t.price;
      b.volume += t.quantity;
    }
  }

  /**
   * Completes the minute that ends at `boundary`. A minute without trades is
   * a flat bar at the last price, as @ome/volatility's MinuteBars makes it
   * live, so the forecaster sees what the gateway would.
   */
  private async closeMinute(boundary: number): Promise<void> {
    const b = this.bar;
    if (b === null) return;
    const { traded: _traded, ...done } = b;
    this.bar = { time: boundary, open: b.close, high: b.close, low: b.close, close: b.close, volume: 0, traded: false };
    await this.completeBar(done);
  }

  private async onBarClose(bar: MinuteBar): Promise<void> {
    this.lastPrice = bar.close;
    this.watchDrawdown();
    await this.completeBar(bar);
  }

  private async completeBar(bar: MinuteBar): Promise<void> {
    this.history.push(bar);
    this.forecaster.push(bar);
    this.forecast = this.forecaster.forecast();
    await this.strategy.onBar?.(this.ctx, bar);
  }

  // ---- the strategy's actions, arriving at the exchange ----

  private async onQueued(entry: Entry): Promise<void> {
    const e = entry.event;
    switch (e.kind) {
      case "timer":
        if (e.interval !== null) this.queue.push(entry.time + e.interval, TIMER, e);
        await this.strategy.onTimer?.(this.ctx, e.tag);
        return;
      case "cancel": {
        const order = this.orders.get(e.orderId);
        if (order === undefined) return;
        if (order.status === "open") {
          this.book.cancel(order.id);
          order.status = "cancelled";
          this.live.delete(order.id);
        } else if (order.status === "filled") {
          this.acc.orders.lateCancels++; // it filled before the cancel got there
        }
        return;
      }
      case "arrive":
        if (e.order.type === "market") await this.arriveMarket(e.order);
        else await this.arriveLimit(e.order);
    }
  }

  private async arriveLimit(order: SimOrder): Promise<void> {
    if (this.data.kind === "bars") return this.reject(order, "no_tape");
    const touch = this.touch();
    if (touch === null) return this.reject(order, "no_price");
    const price = order.price!;
    const ownBid = this.book.bestBid();
    const ownAsk = this.book.bestAsk();
    const crossesOwn = order.side === "buy" ? ownAsk !== null && price >= ownAsk : ownBid !== null && price <= ownBid;
    const crossesTouch = order.side === "buy" ? price >= touch.ask : price <= touch.bid;
    if (crossesOwn || (crossesTouch && order.postOnly)) return this.reject(order, "would_cross");
    if (crossesTouch) {
      // A marketable limit order: it takes what the market offers, at the touch plus
      // the slippage a market order pays, but a limit order never pays past its limit.
      const taken = this.takerPrice(order.side, touch);
      const fill = this.fill(order, order.side === "buy" ? Math.min(price, taken) : Math.max(price, taken), order.quantity, "taker");
      this.marketable.orders++;
      this.marketable.quantity += order.quantity;
      await this.strategy.onFill?.(this.ctx, fill);
      return;
    }
    const events = this.book.submit({ type: "limit", id: order.id, traderId: OWNER, side: order.side, price, quantity: order.quantity, timeInForce: "GTC" });
    if (events.some((e) => e.type === "trade" || e.type === "rejected")) throw new Error(`engine: quote ${order.id} did not rest cleanly`);
    order.status = "open";
  }

  private async arriveMarket(order: SimOrder): Promise<void> {
    const touch = this.touch();
    if (touch === null) return this.reject(order, "no_price");
    // Booked first: `onFill?.(...)` would skip evaluating its argument for a strategy without onFill.
    const fill = this.fill(order, this.takerPrice(order.side, touch), order.quantity, "taker");
    await this.strategy.onFill?.(this.ctx, fill);
  }

  /** Where an order taking liquidity fills: the touch plus the slippage, rounded against us onto the tick grid. */
  private takerPrice(side: Side, touch: { bid: number; ask: number }): number {
    const tick = this.instrument.tickSize;
    const slip = this.cfg.slippageBps / 10_000;
    return side === "buy" ? Math.ceil((touch.ask * (1 + slip)) / tick) * tick : Math.max(tick, Math.floor((touch.bid * (1 - slip)) / tick) * tick);
  }

  private async reject(order: SimOrder, reason: RejectReason): Promise<void> {
    order.status = "rejected";
    this.live.delete(order.id);
    this.acc.orders.rejected[reason] = (this.acc.orders.rejected[reason] ?? 0) + 1;
    await this.strategy.onReject?.(this.ctx, view(order), reason);
  }

  /** Books a fill; the caller reports it to the strategy. */
  private fill(order: SimOrder, price: number, quantity: number, liquidity: Liquidity): Fill {
    const notional = price * quantity;
    const feeTicks = (notional * (liquidity === "maker" ? this.cfg.makerFeeBps : this.cfg.takerFeeBps)) / 10_000;
    const signed = order.side === "buy" ? quantity : -quantity;
    this.position += signed;
    this.cashFlow -= signed * price;
    this.feeTicks += feeTicks;
    order.filled += quantity;
    if (order.filled === order.quantity) {
      order.status = "filled";
      this.live.delete(order.id);
    }

    const a = this.acc;
    const fee = feeTicks / this.scale;
    a.turnover += notional / this.scale;
    a.fills.count++;
    if (liquidity === "maker") {
      a.fills.maker++;
      a.fills.makerQuantity += quantity;
      a.makerFees += fee;
    } else {
      a.fills.taker++;
      a.fills.takerQuantity += quantity;
      a.takerFees += fee;
    }
    a.maxAbs = Math.max(a.maxAbs, Math.abs(this.position));
    // A maker fill is checked at its own price: the last trade at the instant it
    // happens. Marked at the print before it (where the sweep came from), the new
    // position would record a peak the market never offered.
    this.watchDrawdown(liquidity === "maker" ? price : this.lastPrice);

    const fill: Fill = { time: this.now, orderId: order.id, side: order.side, price, quantity, liquidity, fee };
    this.fills.push(fill);
    return fill;
  }

  // ---- what the strategy sees ----

  private send(order: SimOrder): string {
    this.orders.set(order.id, order);
    this.live.set(order.id, order);
    this.queue.push(this.now + this.cfg.latencyMs, ACTION, { kind: "arrive", order });
    this.actions.push({ decidedAt: this.now, arrivedAt: this.now + this.cfg.latencyMs, kind: order.type, orderId: order.id, side: order.side, price: order.price, quantity: order.quantity });
    return order.id;
  }

  private checkQuantity(quantity: number): void {
    if (!isPositiveInteger(quantity) || quantity % this.instrument.lotSize !== 0) throw new Error(`invalid quantity ${quantity}`);
  }

  private context(): StrategyContext {
    const sim = this;
    const tick = this.instrument.tickSize;
    return {
      instrument: this.instrument,
      get now() {
        return sim.now;
      },
      get position() {
        return sim.position;
      },
      get cash() {
        return sim.cfg.capital + (sim.cashFlow - sim.feeTicks) / sim.scale;
      },
      get lastPrice() {
        return sim.lastPrice;
      },
      get touch() {
        return sim.touch();
      },
      get volatility() {
        return sim.forecast;
      },
      bars: () => this.history,
      openOrders: () => [...this.live.values()].map(view),
      placeLimit: (side, price, quantity, options = {}) => {
        if (!isPositiveInteger(price) || price % tick !== 0) throw new Error(`invalid price ${price}`);
        this.checkQuantity(quantity);
        this.acc.orders.limit++;
        const postOnly = options.postOnly ?? true;
        const id = this.send({ id: `o${this.nextId++}`, type: "limit", side, price, quantity, filled: 0, status: "pending", sentAt: this.now, cancelRequested: false, postOnly, tag: options.tag });
        const last = this.lastPrice;
        this.quoteDistance.set(id, last === null ? null : ((side === "buy" ? last - price : price - last) / last) * 10_000);
        return id;
      },
      marketOrder: (side, quantity) => {
        this.checkQuantity(quantity);
        this.acc.orders.market++;
        return this.send({ id: `o${this.nextId++}`, type: "market", side, price: null, quantity, filled: 0, status: "pending", sentAt: this.now, cancelRequested: false, postOnly: false, tag: undefined });
      },
      cancel: (orderId) => {
        const order = this.live.get(orderId);
        if (order === undefined || order.cancelRequested || order.type === "market") return;
        order.cancelRequested = true;
        this.acc.orders.cancels++;
        this.queue.push(this.now + this.cfg.latencyMs, ACTION, { kind: "cancel", orderId });
        this.actions.push({ decidedAt: this.now, arrivedAt: this.now + this.cfg.latencyMs, kind: "cancel", orderId });
      },
      setTimer: (delayMs, tag = "timer") => {
        if (!(delayMs >= 0)) throw new Error(`invalid timer delay ${delayMs}`);
        this.queue.push(this.now + delayMs, TIMER, { kind: "timer", tag, interval: null });
      },
      every: (intervalMs, tag = "timer") => {
        if (!isPositiveInteger(intervalMs)) throw new Error(`invalid timer interval ${intervalMs}`);
        this.queue.push((Math.floor(this.now / intervalMs) + 1) * intervalMs, TIMER, { kind: "timer", tag, interval: intervalMs });
      },
    };
  }

  private resultFrame(end: number) {
    const a = this.acc;
    a.equity.push([end, this.equity()]);
    a.price.push([end, this.lastPrice]);
    const { instrument, ...config } = this.cfg;
    const touch = this.touch();
    // Closing what is left with a market order, at the final touch, with slippage and the taker fee.
    let afterClose = this.equity() - this.cfg.capital;
    if (this.position !== 0 && touch !== null && this.lastPrice !== null) {
      const slip = this.cfg.slippageBps / 10_000;
      const tick = instrument.tickSize;
      const close = this.position > 0 ? Math.floor((touch.bid * (1 - slip)) / tick) * tick : Math.ceil((touch.ask * (1 + slip)) / tick) * tick;
      const fee = (Math.abs(this.position) * close * this.cfg.takerFeeBps) / 10_000;
      afterClose += (this.position * (close - this.lastPrice) - fee) / this.scale;
    }
    const firstPrice = this.data.kind === "trades" ? (this.data.trades[0]?.price ?? null) : (this.data.bars[0]?.open ?? null);
    const marks = this.marks();
    const horizons = this.data.kind === "bars" ? BAR_MARKOUT_HORIZONS_MS : MARKOUT_HORIZONS_MS;
    const tags = new Map<string, string>();
    for (const order of this.orders.values()) if (order.tag !== undefined) tags.set(order.id, order.tag);
    return {
      strategy: this.strategy.name,
      data: {
        kind: this.data.kind,
        symbol: this.data.symbol,
        events: this.data.kind === "trades" ? this.data.trades.length : this.data.bars.length,
        warmupBars: this.data.warmup.length,
        from: a.start,
        to: end,
        firstPrice,
        lastPrice: this.lastPrice,
      },
      config: { ...config, symbol: instrument.symbol },
      end,
      equityNow: this.equity(),
      afterClose,
      position: this.position,
      fees: this.feeTicks / this.scale,
      markouts: markouts(this.fills, marks, end, horizons),
      quotes: quotePlacement(this.quoteDistance, this.fills, marks, end, horizons, { tags, marketable: { ...this.marketable } }),
    };
  }

  /**
   * The last market price at or before a moment, from the data itself: the
   * tape, or each bar's close once the bar is complete. Used only after the run.
   */
  private marks(): (t: number) => number | null {
    const data = this.data;
    const count = data.kind === "trades" ? data.trades.length : data.bars.length;
    const timeOf = (i: number) => (data.kind === "trades" ? data.trades[i]!.time : data.bars[i]!.time + MINUTE_MS);
    const priceOf = (i: number) => (data.kind === "trades" ? data.trades[i]!.price : data.bars[i]!.close);
    return (t) => {
      // The last index at or before t (binary search); events are in time order.
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (timeOf(mid) <= t) lo = mid + 1;
        else hi = mid;
      }
      return lo === 0 ? null : priceOf(lo - 1);
    };
  }
}

/** Runs one strategy over the data. Same inputs, same result, every time. */
export async function runBacktest(strategy: Strategy, data: MarketData, config: Partial<BacktestConfig> = {}, options: RunOptions = {}): Promise<BacktestRun> {
  const cfg: BacktestConfig = { ...DEFAULT_CONFIG, ...(data.kind === "bars" ? { sampleMs: MINUTE_MS } : {}), ...config };
  if (!isPositiveInteger(cfg.sampleMs)) throw new Error(`invalid sampleMs ${cfg.sampleMs}`);
  if (!(cfg.latencyMs >= 0)) throw new Error(`invalid latencyMs ${cfg.latencyMs}`);
  if (!(cfg.capital > 0)) throw new Error(`invalid capital ${cfg.capital}`);
  return new Simulation(strategy, data, cfg, options.manifest ?? loadManifest()).run();
}
