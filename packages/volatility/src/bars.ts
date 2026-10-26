import type { Bar } from "./features.js";

interface OpenBar extends Bar {
  minute: number;
  traded: boolean;
}

/**
 * Turns a stream of trades into 1-minute bars. A minute without trades
 * becomes a flat bar at the last price, so a quiet market reads as calm
 * rather than as missing data.
 */
export class MinuteBars {
  private current: OpenBar | null = null;

  constructor(
    private readonly barMs = 60_000,
    /** Longest run of empty minutes filled in; the features look back 240 minutes at most. */
    private readonly maxGap = 240,
  ) {}

  /** Adds a trade; returns the bars it completed, oldest first (often none). */
  trade(price: number, time: number): Bar[] {
    const done = this.roll(time);
    const c = this.current;
    if (c === null) {
      this.current = { minute: Math.floor(time / this.barMs), high: price, low: price, close: price, traded: true };
    } else if (!c.traded) {
      Object.assign(c, { high: price, low: price, close: price, traded: true });
    } else {
      // A trade stamped before the open minute (clock skew) is folded into it.
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
    }
    return done;
  }

  /** Closes every minute that has ended by `now`; returns those bars, oldest first. */
  roll(now: number): Bar[] {
    const c = this.current;
    const minute = Math.floor(now / this.barMs);
    if (c === null || minute <= c.minute) return [];
    const done: Bar[] = [{ high: c.high, low: c.low, close: c.close }];
    const empty = Math.min(minute - c.minute - 1, this.maxGap);
    for (let i = 0; i < empty; i++) done.push({ high: c.close, low: c.close, close: c.close });
    this.current = { minute, high: c.close, low: c.close, close: c.close, traded: false };
    return done;
  }
}
