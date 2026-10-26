import { describe, expect, it } from "vitest";
import { MAX_VISIBLE_BARS, MIN_VISIBLE_BARS, openingRange, RIGHT_PAD_BARS } from "./chart-view";

const slots = (r: { from: number; to: number }) => r.to - r.from + 1 - RIGHT_PAD_BARS;

describe("chart opening range", () => {
  it("waits for candles", () => {
    expect(openingRange(0)).toBeNull();
  });

  it("gives a young series room to grow instead of stretching its first bars across the chart", () => {
    // Two 1-minute candles: fitted, each would be half the chart wide, and stay that wide as more arrive.
    const r = openingRange(2)!;
    expect(slots(r)).toBe(MIN_VISIBLE_BARS);
    expect(r.to).toBe(1 + RIGHT_PAD_BARS); // the newest candle sits at the right
    expect(r.from).toBeLessThan(0); // empty room on the left
  });

  it("shows every candle of a short history, newest at the right", () => {
    const count = 60;
    expect(openingRange(count)).toEqual({ from: 0, to: count - 1 + RIGHT_PAD_BARS });
  });

  it("opens a long history on its newest candles", () => {
    const count = 1_000;
    const r = openingRange(count)!;
    expect(slots(r)).toBe(MAX_VISIBLE_BARS);
    expect(r).toEqual({ from: count - MAX_VISIBLE_BARS, to: count - 1 + RIGHT_PAD_BARS });
  });
});
