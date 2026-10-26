import type { Candle } from "./protocol.js";

export const INTERVALS = { "5s": 5_000, "1m": 60_000 } as const;
export type Interval = keyof typeof INTERVALS;

/** OHLCV candles for one symbol and interval, built from trades as they print. */
export class CandleSeries {
  private readonly candles: Candle[] = [];

  constructor(
    private readonly intervalMs: number,
    private readonly maxCandles = 1_000,
  ) {}

  /**
   * Adds a trade and returns the candle it landed in. A trade stamped earlier
   * than the latest candle (clock skew) is folded into the latest candle.
   */
  add(price: number, quantity: number, time: number): Candle {
    const bucket = time - (time % this.intervalMs);
    let current = this.candles.at(-1);
    if (current === undefined || current.time < bucket) {
      current = { time: bucket, open: price, high: price, low: price, close: price, volume: 0, trades: 0 };
      this.candles.push(current);
      if (this.candles.length > this.maxCandles) this.candles.shift();
    }
    current.high = Math.max(current.high, price);
    current.low = Math.min(current.low, price);
    current.close = price;
    current.volume += quantity;
    current.trades += 1;
    return current;
  }

  history(): Candle[] {
    return this.candles.map((c) => ({ ...c }));
  }
}
