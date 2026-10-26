import type { Instrument } from "@ome/client";
import { describe, expect, it } from "vitest";
import { annualizedVolatility, blackScholes, yearsUntil } from "../src/pricing.js";
import { DEFAULT_DERIVATIVES, DEFAULT_INSTRUMENTS, Derivatives, expiryCode, nextExpiry, seriesFor } from "../src/index.js";

const TCS = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "TCS")!;
const at = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 9, 25, h, m, s, ms);
const HALF_HOUR = 30 * 60_000;

function desk(start = at(10, 10)) {
  const clock = { now: start };
  const prices: Record<string, number> = { TCS: 410_000 };
  const forecast: { value: { sigmaPct: number; horizonMinutes: number } | null } = { value: null };
  const derivatives = new Derivatives(
    { underlyings: [{ symbol: "TCS", multiplier: 10, strikeStep: 5_000 }] },
    { now: () => clock.now, price: (s) => prices[s]!, forecast: () => forecast.value, bandPct: () => 10 },
  );
  return { derivatives, clock, prices, forecast, underlyings: new Map([["TCS", TCS]]) };
}

describe("series listing", () => {
  it("expires on the cycle, leaving each new series more than its minimum life", () => {
    expect(nextExpiry(at(10, 10), HALF_HOUR, 15 * 60_000)).toBe(at(10, 30));
    expect(nextExpiry(at(10, 15), HALF_HOUR, 15 * 60_000)).toBe(at(11, 0)); // 10:30 would leave exactly 15 minutes
    expect(nextExpiry(at(10, 30), HALF_HOUR, 0)).toBe(at(11, 0)); // never the current instant
    expect(expiryCode(at(10, 30), HALF_HOUR)).toBe("25OCT1030");
    expect(expiryCode(at(9, 5, 30), 90_000)).toBe("25OCT090530"); // seconds when the cycle needs them
  });

  it("lists a future and calls and puts at five strikes around the underlying's price", () => {
    const series = seriesFor(TCS, { symbol: "TCS", multiplier: 10, strikeStep: 5_000 }, 410_120, at(10, 30), DEFAULT_DERIVATIVES);
    expect(series.map((i) => i.symbol)).toEqual([
      "TCS-25OCT1030-F",
      ...["4000", "4050", "4100", "4150", "4200"].flatMap((k) => [`TCS-25OCT1030-${k}C`, `TCS-25OCT1030-${k}P`]),
    ]);
    expect(series[0]).toMatchObject({ kind: "future", underlying: "TCS", expiry: at(10, 30), multiplier: 10, referencePrice: 410_120, tickSize: 5, currency: "INR" });
    expect(series[5]).toMatchObject({ kind: "option", right: "call", strike: 410_000, lotSize: 1, quantityScale: 1, name: "Tata Consultancy Services 4100 call, expires 10:30 UTC" });
  });

  it("lists each underlying once, at fair value, and reports series as they come due", () => {
    const { derivatives, clock, underlyings } = desk();
    const listed = derivatives.plan(underlyings);
    expect(listed).toHaveLength(11);
    expect(derivatives.plan(underlyings)).toEqual([]); // already live
    const call = listed.find((i) => i.symbol === "TCS-25OCT1030-4100C")!;
    // Black-Scholes at the default 1.5% per 15 minutes, 20 minutes before expiry, rounded to the 5-paise tick.
    const fair = blackScholes({ right: "call", spot: 410_000, strike: 410_000, time: yearsUntil(at(10, 30), at(10, 10)), volatility: annualizedVolatility(1.5, 15) });
    expect(call.referencePrice).toBe(Math.round(fair / 5) * 5);
    expect(call.referencePrice).toBeGreaterThan(2_500); // about Rs 28: 0.4 x 4100 x 1.5% x sqrt(20/15)
    expect(call.referencePrice).toBeLessThan(3_200);
    clock.now = at(10, 29, 59, 999);
    expect(derivatives.due()).toEqual([]);
    clock.now = at(10, 30);
    expect(derivatives.due()).toHaveLength(11);
    for (const i of listed) derivatives.remove(i.symbol);
    expect(derivatives.plan(underlyings).map((i) => i.expiry)).toContain(at(11, 0));
  });
});

describe("valuation, marks and bands", () => {
  it("values options with the forecast scaled to the time left, and marks futures at their own last trade", () => {
    const { derivatives, underlyings, forecast, clock } = desk();
    derivatives.plan(underlyings);
    const put = derivatives.get("TCS-25OCT1030-4000P")!;
    forecast.value = { sigmaPct: 3, horizonMinutes: 15 };
    clock.now = at(10, 25);
    const expected = blackScholes({ right: "put", spot: 410_000, strike: 400_000, time: 5 / (365 * 24 * 60), volatility: annualizedVolatility(3, 15) });
    expect(derivatives.mark(put.symbol)).toBeCloseTo(expected, 9);
    // 3% over 15 minutes is 3% x sqrt(5/15) over the 5 minutes left.
    expect(annualizedVolatility(3, 15) * Math.sqrt(5 / (365 * 24 * 60))).toBeCloseTo(0.03 * Math.sqrt(5 / 15), 12);

    const future = "TCS-25OCT1030-F";
    expect(derivatives.mark(future)).toBe(410_000); // no trade yet: the underlying's price
    derivatives.onTrade(future, 411_000, 2, at(10, 25));
    expect(derivatives.mark(future)).toBe(411_000);
    expect(derivatives.mark("TCS")).toBeUndefined(); // spot is marked by the gateway
  });

  it("gives options a band from the underlying's band, wide enough for honest quotes", () => {
    const { derivatives, underlyings } = desk();
    derivatives.plan(underlyings);
    expect(derivatives.band("TCS-25OCT1030-F")).toEqual({ low: 369_000, high: 451_000 }); // TCS 4100 +-10%
    for (const instrument of derivatives.all().filter((i) => i.kind === "option")) {
      const band = derivatives.band(instrument.symbol)!;
      const fair = derivatives.fairValue(instrument);
      expect(band.low % 5).toBe(0);
      expect(band.high % 5).toBe(0);
      expect(band.low).toBeLessThanOrEqual(fair * 0.5);
      expect(band.high).toBeGreaterThanOrEqual(fair * 2);
      expect(band.high).toBeGreaterThanOrEqual(100); // never narrower than 20 ticks
    }
    // The 4100 call can be worth at most a little over Rs 410 even if TCS jumps 10% and volatility doubles.
    expect(derivatives.band("TCS-25OCT1030-4100C")!.high).toBeLessThan(50_000);
    expect(derivatives.band("TCS")).toBeNull();
  });
});

describe("settlement price", () => {
  function listed() {
    const d = desk();
    d.derivatives.plan(d.underlyings);
    return { ...d, future: d.derivatives.get("TCS-25OCT1030-F") as Instrument };
  }

  it("is the underlying's VWAP over the last minute before expiry, rounded to the tick", () => {
    const { derivatives, future } = listed();
    derivatives.onTrade("TCS", 400_000, 100, at(10, 28, 30)); // before the window
    derivatives.onTrade("TCS", 412_000, 10, at(10, 29, 10));
    derivatives.onTrade("TCS", 413_000, 30, at(10, 29, 40));
    derivatives.onTrade("TCS", 300_000, 50, at(10, 30, 0, 500)); // after expiry
    // (4120 x 10 + 4130 x 30) / 40 = 4127.50
    expect(derivatives.settlement(future)).toEqual({ price: 412_750, basis: "vwap" });
  });

  it("barely moves for a last-second print that would decide a last-price settlement", () => {
    const { derivatives, future } = listed();
    derivatives.onTrade("TCS", 412_000, 10, at(10, 29, 10));
    derivatives.onTrade("TCS", 413_000, 30, at(10, 29, 40));
    derivatives.onTrade("TCS", 440_000, 1, at(10, 29, 59, 900)); // one share, 6.5% up, 0.1 s before expiry
    // (4120 x 10 + 4130 x 30 + 4400) / 41 = 4134.146..., to the tick 4134.15: Rs 6.65 above the honest
    // average, where settling on the last trade would have moved it Rs 272.50.
    expect(derivatives.settlementPrice(future)).toBe(413_415);
  });

  it("falls back to the last trade before expiry, then to the reference price", () => {
    const { derivatives, future, prices } = listed();
    expect(derivatives.settlement(future)).toEqual({ price: 410_000, basis: "reference" }); // no trades at all
    derivatives.onTrade("TCS", 411_100, 5, at(10, 20));
    derivatives.onTrade("TCS", 411_200, 5, at(10, 31)); // after expiry: ignored
    prices.TCS = 411_200;
    expect(derivatives.settlement(future)).toEqual({ price: 411_100, basis: "last_trade" });
  });

  it("falls back to the newest trade before expiry even once it has left the tape", () => {
    const { derivatives, future } = listed();
    derivatives.onTrade("TCS", 411_100, 5, at(10, 20));
    derivatives.onTrade("TCS", 411_300, 5, at(10, 28));
    // A trade after expiry (the expiry check ran late) trims both earlier ones off the tape.
    derivatives.onTrade("TCS", 399_000, 5, at(10, 30, 2));
    expect(derivatives.settlement(future)).toEqual({ price: 411_300, basis: "last_trade" });
  });

  it("keeps the whole window for a series whose expiry check runs late", () => {
    const { derivatives, future } = listed();
    derivatives.onTrade("TCS", 412_000, 10, at(10, 29, 10));
    derivatives.onTrade("TCS", 413_000, 30, at(10, 29, 40));
    // 45 s after expiry and the series is still live: trimming the tape to the minute before
    // this trade would drop both window trades, and the series would settle on a partial average.
    derivatives.onTrade("TCS", 399_000, 5, at(10, 30, 45));
    expect(derivatives.settlement(future)).toEqual({ price: 412_750, basis: "vwap" });
  });
});
