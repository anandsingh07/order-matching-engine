import type { Instrument, Side } from "@ome/client";
import type { Forecast } from "@ome/volatility";

// Prices are integer ticks and quantities integer units of the instrument,
// as everywhere else in the exchange, so the tape converts exactly and the
// matching engine sees the same numbers it would live.

/** One historical trade: an aggressive order that traded `quantity` at `price`. */
export interface MarketTrade {
  /** Milliseconds since the epoch. */
  time: number;
  price: number;
  quantity: number;
  /** The aggressor. On Binance, `buyerIsMaker` means a seller aggressed. */
  takerSide: Side;
}

/** A 1-minute bar. `time` is when the minute opened; it is complete at `time + 60 s`. */
export interface MinuteBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quantity units traded in the minute. */
  volume: number;
}

/**
 * What a backtest runs on: a tape of trades, or 1-minute bars (klines) for
 * strategies that only need bars. A bar is one event, at its close: when in
 * the minute its open printed is unknown. `warmup` is history from before the
 * first event, for the volatility forecaster and bar strategies; it never
 * contains anything at or after the start.
 */
export type MarketData =
  | { kind: "trades"; symbol: string; trades: MarketTrade[]; warmup: MinuteBar[] }
  | { kind: "bars"; symbol: string; bars: MinuteBar[]; warmup: MinuteBar[] };

/** How a resting quote is filled by the tape (see engine.ts for the reasoning). */
export type QueueModel = "through" | "touch";

export interface BacktestConfig {
  instrument: Instrument;
  /** Time from a strategy's decision to the exchange acting on it, in ms. */
  latencyMs: number;
  /** Fee on resting (maker) fills, in bps of notional; negative is a rebate. */
  makerFeeBps: number;
  /** Fee on aggressive (taker) fills, in bps of notional. */
  takerFeeBps: number;
  /** A market order fills this far beyond the touch, in bps. */
  slippageBps: number;
  queue: QueueModel;
  /** Starting cash in the quote currency; returns, Sharpe and drawdown are relative to it. */
  capital: number;
  /** Spacing of the equity curve in the result, in ms; must divide a minute. */
  sampleMs: number;
}

export type Liquidity = "maker" | "taker";

export interface Fill {
  time: number;
  orderId: string;
  side: Side;
  price: number;
  quantity: number;
  liquidity: Liquidity;
  /** In the quote currency (negative for a rebate). */
  fee: number;
}

export type OrderStatus = "pending" | "open" | "filled" | "cancelled" | "rejected";

export type RejectReason =
  /** A post-only quote that would have crossed the touch, or the strategy's own opposite quote. */
  | "would_cross"
  /** A market order before any trade printed, so there is no price to fill at. */
  | "no_price"
  /** Limit orders need a tape to be filled by; bar data has none. */
  | "no_tape"
  | "invalid";

/** How a limit order is sent (see StrategyContext.placeLimit). */
export interface LimitOptions {
  /**
   * True (the default): post-only. One that would cross the touch on arrival
   * is rejected, as an exchange rejects a crossing post-only order. False: a
   * plain limit order, which is what the live bots send (the exchange has no
   * post-only type). One that crosses the touch on arrival takes liquidity at
   * once, as a taker, and never at worse than its limit.
   */
  postOnly?: boolean;
  /** A label; the result's `quotes.tags` says what the orders with each label did. */
  tag?: string;
}

/** A strategy's order as the strategy sees it. */
export interface StrategyOrder {
  readonly id: string;
  readonly type: "limit" | "market";
  readonly side: Side;
  /** Limit price in ticks; null for a market order. */
  readonly price: number | null;
  readonly quantity: number;
  readonly filled: number;
  readonly status: OrderStatus;
  /** When the strategy sent it; the exchange sees it `latencyMs` later. */
  readonly sentAt: number;
  /** True once a cancel has been sent (it may still fill until the cancel arrives). */
  readonly cancelRequested: boolean;
}

/**
 * Everything a strategy can see and do. It sees only what has happened by
 * `now`: the engine delivers events strictly in time order and never hands a
 * strategy the data itself.
 */
export interface StrategyContext {
  readonly instrument: Instrument;
  readonly now: number;
  /** Signed, in quantity units. */
  readonly position: number;
  /** Cash in the quote currency: starting capital, plus sales, minus purchases and fees. */
  readonly cash: number;
  /** The last trade price in ticks (on bar data, the last close); null before the first one. */
  readonly lastPrice: number | null;
  /** Best bid and ask of the rest of the market, as the tape implies them. */
  readonly touch: { bid: number; ask: number } | null;
  /** The live volatility forecast from completed minute bars, as the gateway computes it. */
  readonly volatility: Forecast | null;
  /** Completed minute bars, warm-up history first. */
  bars(): readonly MinuteBar[];
  /** Orders sent and not yet filled, cancelled or rejected, oldest first. */
  openOrders(): readonly StrategyOrder[];
  /** A GTC limit order, post-only unless `options.postOnly` is false; returns its id. */
  placeLimit(side: Side, price: number, quantity: number, options?: LimitOptions): string;
  /** A market order, filled at the touch plus slippage when it arrives. */
  marketOrder(side: Side, quantity: number): string;
  cancel(orderId: string): void;
  /** Calls `onTimer(tag)` after `delayMs`. */
  setTimer(delayMs: number, tag?: string): void;
  /** Calls `onTimer(tag)` at every multiple of `intervalMs` from now on. */
  every(intervalMs: number, tag?: string): void;
}

type Maybe<T> = T | Promise<T>;

/** Callbacks a strategy implements; all optional. Each may be async (an ONNX policy is). */
export interface Strategy {
  readonly name: string;
  /** Called once at the start, before the first event; warm-up bars are already in `ctx.bars()`. */
  init?(ctx: StrategyContext): Maybe<void>;
  onTrade?(ctx: StrategyContext, trade: MarketTrade): Maybe<void>;
  onBar?(ctx: StrategyContext, bar: MinuteBar): Maybe<void>;
  /** A fill caused by a print is reported once that print is in: `ctx.lastPrice` is already its price. */
  onFill?(ctx: StrategyContext, fill: Fill): Maybe<void>;
  onReject?(ctx: StrategyContext, order: StrategyOrder, reason: RejectReason): Maybe<void>;
  onTimer?(ctx: StrategyContext, tag: string): Maybe<void>;
}

/** One action as the engine logged it: when it was decided and when it took effect. */
export interface ActionRecord {
  decidedAt: number;
  arrivedAt: number;
  kind: "limit" | "market" | "cancel";
  orderId: string;
  side?: Side;
  price?: number | null;
  quantity?: number;
}

export interface BacktestResult {
  strategy: string;
  data: {
    kind: MarketData["kind"];
    symbol: string;
    events: number;
    warmupBars: number;
    from: number;
    to: number;
    firstPrice: number | null;
    lastPrice: number | null;
  };
  config: Omit<BacktestConfig, "instrument"> & { symbol: string };
  /** All money in the quote currency. */
  pnl: {
    /** Marked to the last trade price. */
    total: number;
    /** After closing the final position with a market order (touch, slippage and taker fee). */
    afterClose: number;
    /** `total` / capital. */
    return: number;
    fees: number;
    makerFees: number;
    takerFees: number;
  };
  sharpe: {
    /** Mean / standard deviation of 1-minute equity changes (the first and last minutes may be partial). */
    perMinute: number | null;
    /** perMinute x sqrt(525,600): crypto trades every minute of the year. */
    annualised: number | null;
    returns: number;
  };
  maxDrawdown: { amount: number; fraction: number };
  fills: { count: number; maker: number; taker: number; makerQuantity: number; takerQuantity: number };
  /** Traded notional. */
  turnover: { amount: number; ofCapital: number };
  /** In quantity units; the means are time-weighted. */
  inventory: { final: number; maxAbs: number; meanAbs: number; mean: number };
  /**
   * How the price moved after our fills, in our favour, in bps of the fill
   * price and weighted by quantity: the last trade `horizonMs` after each
   * fill against its price. A market maker's markout is the spread it earned
   * minus adverse selection; negative means its fills were followed by moves
   * against it. Fills too close to the end for the horizon are left out
   * (`fills` counts those included). Computed after the run, from the tape;
   * no strategy ever sees it.
   */
  markouts: { horizonMs: number; bps: number | null; fills: number }[];
  /**
   * Where the limit orders sat: each one's distance from the last trade price
   * when it was decided, in bps on its passive side (below the price for a
   * bid, above it for an ask; 0 is at the price). `near` is what the quotes
   * placed within `nearBps` of the price, at the touch, did: their share of
   * the maker fill quantity and their markouts. It shows where a market
   * maker's fills, and its adverse selection, came from. Computed after the run.
   */
  quotes: {
    placed: number;
    distanceBps: { p10: number; median: number; p90: number } | null;
    nearBps: number;
    near: { orders: number; fillShare: number | null; markouts: { horizonMs: number; bps: number | null; fills: number }[] };
    /**
     * Plain (not post-only) limit orders that crossed the touch on arrival and
     * so took liquidity, as they would live; `quantity` is what they took.
     */
    marketable: { orders: number; quantity: number };
    /** By LimitOptions.tag: how many orders had it, and their share of the maker fill quantity. */
    tags: Record<string, { orders: number; makerQuantity: number; fillShare: number | null }>;
  };
  orders: { limit: number; market: number; cancels: number; rejected: Record<string, number>; lateCancels: number };
  /** Equity in the quote currency, every `sampleMs`, plus the first and last moments. */
  equity: [time: number, equity: number][];
  /** The last trade price in ticks at each equity sample. */
  price: [time: number, price: number | null][];
}
