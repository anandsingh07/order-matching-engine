import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeQuotes, wideningFor, type QuoteParams } from "../src/index.js";

const params = fc.record({
  fair: fc.integer({ min: 1_000, max: 10_000_000 }),
  position: fc.integer({ min: -1_000, max: 1_000 }),
  tickSize: fc.constantFrom(1, 5, 10),
  levels: fc.integer({ min: 1, max: 8 }),
  halfSpreadBps: fc.double({ min: 0, max: 50, noNaN: true }),
  stepBps: fc.double({ min: 0, max: 20, noNaN: true }),
  size: fc.integer({ min: 1, max: 100 }),
  maxPosition: fc.integer({ min: 1, max: 1_000 }),
  skewBps: fc.double({ min: 0, max: 50, noNaN: true }),
});

describe("computeQuotes", () => {
  it("always produces a valid, uncrossed ladder on the tick grid", () => {
    fc.assert(
      fc.property(params, (p: QuoteParams) => {
        const quotes = computeQuotes(p);
        const bids = quotes.filter((q) => q.side === "buy").map((q) => q.price);
        const asks = quotes.filter((q) => q.side === "sell").map((q) => q.price);
        for (const q of quotes) {
          expect(q.price % p.tickSize).toBe(0);
          expect(q.price).toBeGreaterThan(0);
          expect(q.quantity).toBe(p.size);
        }
        // Strictly worse prices at each further level.
        for (let i = 1; i < bids.length; i++) expect(bids[i]!).toBeLessThan(bids[i - 1]!);
        for (let i = 1; i < asks.length; i++) expect(asks[i]!).toBeGreaterThan(asks[i - 1]!);
        if (bids.length > 0 && asks.length > 0) expect(bids[0]!).toBeLessThan(asks[0]!);
      }),
    );
  });

  it("stops quoting the side that would breach the position limit", () => {
    fc.assert(
      fc.property(params, (p) => {
        const long = computeQuotes({ ...p, position: p.maxPosition });
        const short = computeQuotes({ ...p, position: -p.maxPosition });
        expect(long.some((q) => q.side === "buy")).toBe(false);
        expect(short.some((q) => q.side === "sell")).toBe(false);
      }),
    );
  });

  it("caps the skew when the position overshoots its limit", () => {
    // Found by the property test above: 1000x over the limit used to drive asks to -0.
    const p = { fair: 1_000, tickSize: 5, levels: 3, halfSpreadBps: 5, stepBps: 2, size: 1, maxPosition: 1, skewBps: 50 };
    const quotes = computeQuotes({ ...p, position: 1_000 });
    expect(quotes.every((q) => q.side === "sell" && q.price > 0)).toBe(true);
    expect(computeQuotes({ ...p, position: 1_000 })).toEqual(computeQuotes({ ...p, position: 1 }));
  });

  it("skews quotes down when long and up when short", () => {
    const base = { fair: 1_000_000, tickSize: 1, levels: 1, halfSpreadBps: 5, stepBps: 0, size: 10, maxPosition: 100, skewBps: 20 };
    const [flatBid, flatAsk] = computeQuotes({ ...base, position: 0 }).map((q) => q.price);
    const [longBid, longAsk] = computeQuotes({ ...base, position: 50 }).map((q) => q.price);
    const [shortBid, shortAsk] = computeQuotes({ ...base, position: -50 }).map((q) => q.price);
    expect(longBid!).toBeLessThan(flatBid!);
    expect(longAsk!).toBeLessThan(flatAsk!);
    expect(shortBid!).toBeGreaterThan(flatBid!);
    expect(shortAsk!).toBeGreaterThan(flatAsk!);
  });

  it("quotes wider when volatility is high, and stays a valid ladder", () => {
    const base = { fair: 1_000_000, position: 0, tickSize: 1, levels: 3, halfSpreadBps: 5, stepBps: 2, size: 10, maxPosition: 100, skewBps: 20 };
    const spread = (widening: number) => {
      const q = computeQuotes({ ...base, widening });
      return q.find((x) => x.side === "sell")!.price - q.find((x) => x.side === "buy")!.price;
    };
    expect(spread(1)).toBe(1_000); // 2 x 5 bps of 1,000,000
    expect(spread(3)).toBe(3_000);
    fc.assert(
      fc.property(params, fc.double({ min: 1, max: 4, noNaN: true }), (p, widening) => {
        const quotes = computeQuotes({ ...p, widening });
        const bids = quotes.filter((q) => q.side === "buy").map((q) => q.price);
        const asks = quotes.filter((q) => q.side === "sell").map((q) => q.price);
        if (bids.length > 0 && asks.length > 0) expect(bids[0]!).toBeLessThan(asks[0]!);
      }),
    );
  });
});

describe("wideningFor", () => {
  const settings = { normalSigmaPct: 0.2, max: 4 };
  it("is 1x at or below normal volatility and without a forecast", () => {
    expect(wideningFor(null, settings)).toBe(1);
    expect(wideningFor(0.1, settings)).toBe(1);
    expect(wideningFor(0.5, undefined)).toBe(1);
  });
  it("scales with volatility above normal, up to the cap", () => {
    expect(wideningFor(0.5, settings)).toBeCloseTo(2.5);
    expect(wideningFor(5, settings)).toBe(4);
  });
});
