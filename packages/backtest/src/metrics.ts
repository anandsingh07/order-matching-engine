import type { BacktestResult, Fill } from "./types.js";

/** Minutes in a year: crypto trades around the clock, so a year of 1-minute returns is 525,600 of them. */
export const MINUTES_PER_YEAR = 525_600;

/** What the engine accumulates while it runs; money is in the quote currency. */
export interface Accumulators {
  start: number;
  capital: number;
  peak: number;
  maxDrawdown: number;
  maxDrawdownFraction: number;
  lastTime: number;
  /** Integrals of |position| and position over time, in units x ms. */
  absIntegral: number;
  integral: number;
  maxAbs: number;
  turnover: number;
  makerFees: number;
  takerFees: number;
  fills: BacktestResult["fills"];
  orders: BacktestResult["orders"];
  equity: [number, number][];
  price: [number, number | null][];
  /** Equity at the start and at every minute boundary after it (the end is added by summarise). */
  minuteEquity: number[];
  nextSample: number;
  nextMinute: number;
}

/** The parts of a result the engine knows directly. */
export interface ResultFrame {
  strategy: string;
  data: BacktestResult["data"];
  config: BacktestResult["config"];
  end: number;
  equityNow: number;
  afterClose: number;
  position: number;
  fees: number;
  markouts: BacktestResult["markouts"];
  quotes: BacktestResult["quotes"];
}

/** Markout horizons: the first second, ten seconds, and a minute after a fill. */
export const MARKOUT_HORIZONS_MS = [1_000, 10_000, 60_000] as const;

/**
 * Markout horizons on bar data: one, five and fifteen minutes. A bar's close
 * is the only price there is until the next bar closes, and a market order
 * fills off that close, so any horizon under a minute would only measure the
 * slippage, never the market.
 */
export const BAR_MARKOUT_HORIZONS_MS = [60_000, 300_000, 900_000] as const;

/**
 * Quantity-weighted markouts of `fills` (see BacktestResult.markouts).
 * `priceAt(t)` is the last trade price at or before `t`.
 */
export function markouts(
  fills: readonly { time: number; side: "buy" | "sell"; price: number; quantity: number }[],
  priceAt: (t: number) => number | null,
  end: number,
  horizons: readonly number[] = MARKOUT_HORIZONS_MS,
): BacktestResult["markouts"] {
  return horizons.map((horizonMs) => {
    let weighted = 0;
    let quantity = 0;
    let count = 0;
    for (const f of fills) {
      const later = f.time + horizonMs > end ? null : priceAt(f.time + horizonMs);
      if (later === null) continue;
      weighted += (((f.side === "buy" ? 1 : -1) * (later - f.price)) / f.price) * 10_000 * f.quantity;
      quantity += f.quantity;
      count++;
    }
    return { horizonMs, bps: quantity > 0 ? weighted / quantity : null, fills: count };
  });
}

/** Quotes this close to the last trade price count as at the touch; on BTC/USDT one cent is about 0.0012 bps. */
export const NEAR_TOUCH_BPS = 0.5;

/** The q-quantile of sorted values, interpolating linearly between neighbours (numpy's default). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new Error("quantile of nothing");
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (at - lo) * (sorted[hi]! - sorted[lo]!);
}

/**
 * Where the limit orders sat, and what the ones at the touch did (see
 * BacktestResult.quotes). `distance` maps each limit order to its distance
 * from the last trade price when it was decided; `priceAt` and `end` are as
 * for markouts.
 */
export function quotePlacement(
  distance: ReadonlyMap<string, number | null>,
  fills: readonly Fill[],
  priceAt: (t: number) => number | null,
  end: number,
  horizons: readonly number[] = MARKOUT_HORIZONS_MS,
  tagged: { tags: ReadonlyMap<string, string>; marketable: BacktestResult["quotes"]["marketable"] } = { tags: new Map(), marketable: { orders: 0, quantity: 0 } },
): BacktestResult["quotes"] {
  const known = [...distance.values()].filter((d): d is number => d !== null).sort((a, b) => a - b);
  const isNear = (orderId: string) => {
    const d = distance.get(orderId);
    return d !== undefined && d !== null && d < NEAR_TOUCH_BPS;
  };
  const maker = fills.filter((f) => f.liquidity === "maker");
  const near = maker.filter((f) => isNear(f.orderId));
  const quantity = (fs: readonly Fill[]) => fs.reduce((s, f) => s + f.quantity, 0);
  const makerQuantity = quantity(maker);
  const tags: BacktestResult["quotes"]["tags"] = {};
  for (const tag of new Set(tagged.tags.values())) {
    const ofTag = maker.filter((f) => tagged.tags.get(f.orderId) === tag);
    tags[tag] = {
      orders: [...tagged.tags.values()].filter((t) => t === tag).length,
      makerQuantity: quantity(ofTag),
      fillShare: maker.length === 0 ? null : quantity(ofTag) / makerQuantity,
    };
  }
  return {
    placed: distance.size,
    distanceBps: known.length === 0 ? null : { p10: quantile(known, 0.1), median: quantile(known, 0.5), p90: quantile(known, 0.9) },
    nearBps: NEAR_TOUCH_BPS,
    near: {
      orders: [...distance.keys()].filter(isNear).length,
      fillShare: maker.length === 0 ? null : quantity(near) / makerQuantity,
      markouts: markouts(near, priceAt, end, horizons),
    },
    marketable: tagged.marketable,
    tags,
  };
}

/**
 * Sharpe ratio of a series of period returns: mean over sample standard
 * deviation. Null when it is undefined (fewer than two returns, or no
 * variation at all, as for a strategy that never trades).
 */
export function sharpe(returns: readonly number[]): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return variance > 0 ? mean / Math.sqrt(variance) : null;
}

/** The largest peak-to-trough fall of an equity series, in money and as a fraction of the peak. */
export function maxDrawdown(equity: readonly number[]): { amount: number; fraction: number } {
  let peak = -Infinity;
  let amount = 0;
  let fraction = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    amount = Math.max(amount, peak - e);
    if (peak > 0) fraction = Math.max(fraction, (peak - e) / peak);
  }
  return { amount, fraction };
}

export function summarise(a: Accumulators, f: ResultFrame): BacktestResult {
  const total = f.equityNow - a.capital;
  // The start, every minute boundary, and the end: the returns then add up to
  // the total return, so the Sharpe ratio cannot disagree with the P&L in sign.
  const points = [...a.minuteEquity, f.equityNow];
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) returns.push((points[i]! - points[i - 1]!) / a.capital);
  const perMinute = sharpe(returns);
  const duration = Math.max(1, f.end - a.start);
  return {
    strategy: f.strategy,
    data: f.data,
    config: f.config,
    pnl: { total, afterClose: f.afterClose, return: total / a.capital, fees: f.fees, makerFees: a.makerFees, takerFees: a.takerFees },
    sharpe: { perMinute, annualised: perMinute === null ? null : perMinute * Math.sqrt(MINUTES_PER_YEAR), returns: returns.length },
    maxDrawdown: { amount: a.maxDrawdown, fraction: a.maxDrawdownFraction },
    fills: a.fills,
    turnover: { amount: a.turnover, ofCapital: a.turnover / a.capital },
    inventory: { final: f.position, maxAbs: a.maxAbs, meanAbs: a.absIntegral / duration, mean: a.integral / duration },
    markouts: f.markouts,
    quotes: f.quotes,
    orders: a.orders,
    equity: a.equity,
    price: a.price,
  };
}
