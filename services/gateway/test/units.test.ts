import { describe, expect, it } from "vitest";
import { CandleSeries } from "../src/candles.js";
import { TokenBucket } from "../src/rate-limit.js";

describe("CandleSeries", () => {
  it("builds OHLCV candles per interval", () => {
    const series = new CandleSeries(60_000);
    series.add(100, 5, 60_000);
    series.add(105, 1, 61_000);
    series.add(98, 2, 119_999);
    series.add(101, 4, 120_000); // next minute
    expect(series.history()).toEqual([
      { time: 60_000, open: 100, high: 105, low: 98, close: 98, volume: 8, trades: 3 },
      { time: 120_000, open: 101, high: 101, low: 101, close: 101, volume: 4, trades: 1 },
    ]);
  });

  it("folds a late trade into the latest candle and caps history", () => {
    const series = new CandleSeries(1_000, 3);
    for (let t = 0; t < 5_000; t += 1_000) series.add(t, 1, t);
    series.add(7, 1, 500); // late
    const history = series.history();
    expect(history.map((c) => c.time)).toEqual([2_000, 3_000, 4_000]);
    expect(history.at(-1)).toMatchObject({ low: 7, close: 7, trades: 2 });
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then refills at the sustained rate", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    now = 499;
    expect(bucket.take()).toBe(false);
    now = 500; // half a second at 2/sec = 1 token
    expect(bucket.take()).toBe(true);
    now = 60_000; // never exceeds the burst size
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
  });
});
