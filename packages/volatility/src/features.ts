/**
 * Volatility features from 1-minute bars, the TypeScript twin of
 * services/ai/volatility/features.py. test/golden.json, written by the Python
 * training run, pins the two implementations to the same numbers.
 *
 * At the close of minute t:
 *   r_i      = ln(close_i / close_{i-1})                  (the first bar has none: 0)
 *   rv(k)    = sqrt(sum of r_i^2 over the last k minutes) * sqrt(15 / k)
 *              with fewer than k minutes of history, the minutes available are used
 *   range15  = ln(max high / min low) over the last 15 minutes
 *   features = ln rv(5), ln rv(15), ln rv(60), ln rv(240), ln range15     (floored at 1e-6)
 */

export const WINDOWS = [5, 15, 60, 240] as const;
export const HORIZON = 15;
export const FLOOR = 1e-6;
export const FEATURE_NAMES = ["log_rv_5m", "log_rv_15m", "log_rv_60m", "log_rv_240m", "log_range_15m"] as const;

const LONGEST = Math.max(...WINDOWS);

export interface Bar {
  high: number;
  low: number;
  close: number;
}

/** The trailing history the features need, updated one bar at a time. */
export class FeatureWindow {
  private readonly squared: number[] = []; // last LONGEST squared returns
  private readonly recent: Bar[] = []; // last HORIZON bars
  private previousClose: number | null = null;
  private count = 0;
  /** The latest bar's log return. */
  lastReturn = 0;

  push(bar: Bar): void {
    const r = this.previousClose === null ? 0 : Math.log(bar.close / this.previousClose);
    this.previousClose = bar.close;
    this.lastReturn = r;
    this.count += 1;
    this.squared.push(r * r);
    if (this.squared.length > LONGEST) this.squared.shift();
    this.recent.push(bar);
    if (this.recent.length > HORIZON) this.recent.shift();
  }

  /** Bars seen so far. */
  get size(): number {
    return this.count;
  }

  /** Features at the latest bar, in FEATURE_NAMES order. */
  features(): number[] {
    if (this.count === 0) throw new Error("no bars yet");
    const row: number[] = [];
    for (const k of WINDOWS) {
      const used = Math.min(this.count, k);
      let sum = 0;
      for (let i = this.squared.length - used; i < this.squared.length; i++) sum += this.squared[i]!;
      row.push(Math.log(Math.max(Math.sqrt(sum) * Math.sqrt(HORIZON / used), FLOOR)));
    }
    let high = -Infinity;
    let low = Infinity;
    for (const bar of this.recent) {
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
    }
    row.push(Math.log(Math.max(Math.log(high / low), FLOOR)));
    return row;
  }
}
