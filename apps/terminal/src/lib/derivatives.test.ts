import type { Instrument, MarketStatus } from "@ome/client";
import { describe, expect, it } from "vitest";
import { atTheMoney, forecastVolatility, formatDelta, formatVolatility, inTheMoney, optionChains, underlyingPrice, type Books } from "./chain";
import { chunks, contractTerms, formatCountdown, marketChannels, orderValue } from "./derivatives";
import { annualizedVolatility, blackScholes, greeks, yearsUntil } from "./pricing";

const NOW = Date.UTC(2026, 9, 25, 10, 10);
const EXPIRY = Date.UTC(2026, 9, 25, 10, 30);
const LATER = Date.UTC(2026, 9, 25, 11, 0);

const TCS: Instrument = { symbol: "TCS", name: "TCS", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 410_000 };
const RELIANCE: Instrument = { ...TCS, symbol: "RELIANCE", name: "Reliance", referencePrice: 290_000 };
const base = { ...TCS, underlying: "TCS", multiplier: 10, referencePrice: 1 };
const future = (expiry: number): Instrument => ({ ...base, symbol: `TCS-${expiry}-F`, kind: "future", expiry, referencePrice: 410_000 });
const option = (strike: number, right: "call" | "put", expiry = EXPIRY): Instrument => ({
  ...base,
  symbol: `TCS-${expiry}-${strike / 100}${right === "call" ? "C" : "P"}`,
  kind: "option",
  strike,
  right,
  expiry,
});

// Listed out of strike order, with a second expiry and another underlying mixed in.
const INSTRUMENTS = [
  TCS,
  RELIANCE,
  future(EXPIRY),
  option(415_000, "call"),
  option(405_000, "call"),
  option(410_000, "put"),
  option(410_000, "call"),
  option(405_000, "put"),
  future(LATER),
  option(410_000, "call", LATER),
];

const SPOT = 410_250;
const VOL = 2.8;
const time = yearsUntil(EXPIRY, NOW);
const fair = (i: Instrument) => blackScholes({ right: i.right!, spot: SPOT, strike: i.strike!, time, volatility: VOL });

/** Two-sided quotes `half` either side of fair value: their mid is fair value exactly. */
function quotedBooks(half: number): Books {
  const books: Books = {};
  for (const i of INSTRUMENTS) {
    if (i.kind !== "option" || i.expiry !== EXPIRY) continue;
    const value = fair(i);
    books[i.symbol] = { bids: [{ price: value - half, quantity: 5, orders: 1 }], asks: [{ price: value + half, quantity: 5, orders: 1 }] };
  }
  return books;
}

describe("option chain", () => {
  it("groups an underlying's series by expiry, soonest first, strikes ascending", () => {
    const chains = optionChains(INSTRUMENTS, "TCS", {}, SPOT, NOW);
    expect(chains.map((c) => c.expiry)).toEqual([EXPIRY, LATER]);
    expect(chains[0]!.future?.symbol).toBe(future(EXPIRY).symbol);
    expect(chains[0]!.rows.map((r) => r.strike)).toEqual([405_000, 410_000, 415_000]);
    expect(chains[0]!.rows[2]!.put).toBeNull(); // only the call was listed at 4150
    expect(chains[1]!.rows.map((r) => [r.strike, r.call?.instrument.expiry])).toEqual([[410_000, LATER]]);
    expect(optionChains(INSTRUMENTS, "RELIANCE", {}, 290_000, NOW)).toEqual([]);
  });

  it("recovers the volatility the quotes were made with from their mid, and its delta", () => {
    const [chain] = optionChains(INSTRUMENTS, "TCS", quotedBooks(150), SPOT, NOW);
    for (const row of chain!.rows) {
      for (const quote of [row.call, row.put]) {
        if (quote === null) continue;
        expect(quote.iv).not.toBeNull();
        expect(quote.iv!).toBeCloseTo(VOL, 8);
        const expected = greeks({ right: quote.instrument.right!, spot: SPOT, strike: quote.instrument.strike!, time, volatility: VOL }).delta;
        expect(quote.delta!).toBeCloseTo(expected, 8);
      }
    }
  });

  it("prices whole-tick quotes back to their mid", () => {
    const call = option(410_000, "call");
    const books: Books = { [call.symbol]: { bids: [{ price: 3_000, quantity: 1, orders: 1 }], asks: [{ price: 3_105, quantity: 1, orders: 1 }] } };
    const quote = optionChains(INSTRUMENTS, "TCS", books, SPOT, NOW)[0]!.rows[1]!.call!;
    expect(blackScholes({ right: "call", spot: SPOT, strike: 410_000, time, volatility: quote.iv! })).toBeCloseTo(3_052.5, 6);
  });

  it("shows no implied volatility without a two-sided quote, or when no volatility fits", () => {
    const call = option(405_000, "call");
    const oneSided: Books = { [call.symbol]: { bids: [{ price: 5_000, quantity: 1, orders: 1 }], asks: [] } };
    expect(optionChains(INSTRUMENTS, "TCS", oneSided, SPOT, NOW)[0]!.rows[0]!.call).toMatchObject({ bid: 5_000, ask: null, iv: null, delta: null });
    // A mid below the call's intrinsic value (Rs 52.50) is an arbitrage, not a volatility.
    const belowIntrinsic: Books = { [call.symbol]: { bids: [{ price: 5_000, quantity: 1, orders: 1 }], asks: [{ price: 5_100, quantity: 1, orders: 1 }] } };
    expect(optionChains(INSTRUMENTS, "TCS", belowIntrinsic, SPOT, NOW)[0]!.rows[0]!.call).toMatchObject({ iv: null, delta: null });
  });

  it("finds the at-the-money strike and which side is in the money", () => {
    const rows = optionChains(INSTRUMENTS, "TCS", {}, SPOT, NOW)[0]!.rows;
    expect(atTheMoney(rows, SPOT)).toBe(410_000);
    expect(atTheMoney(rows, 414_000)).toBe(415_000);
    expect(atTheMoney([], SPOT)).toBeNull();
    expect(inTheMoney("call", 405_000, SPOT)).toBe(true);
    expect(inTheMoney("put", 405_000, SPOT)).toBe(false);
    expect(inTheMoney("put", 415_000, SPOT)).toBe(true);
  });

  it("values the chain at the underlying's last trade, then its status, then its listing price", () => {
    const status = { referencePrice: 411_000 } as MarketStatus;
    expect(underlyingPrice(410_500, status, TCS)).toBe(410_500);
    expect(underlyingPrice(undefined, status, TCS)).toBe(411_000);
    expect(underlyingPrice(undefined, undefined, TCS)).toBe(410_000);
    expect(underlyingPrice(undefined, undefined, undefined)).toBeNull();
  });

  it("annualises the forecast like implied volatility, and formats both", () => {
    const status = { volatility: { sigmaPct: 1.5, horizonMinutes: 15, model: "ewma" } } as MarketStatus;
    expect(forecastVolatility(status)).toBe(annualizedVolatility(1.5, 15));
    expect(forecastVolatility({ volatility: null } as MarketStatus)).toBeNull();
    expect(formatVolatility(2.814)).toBe("281%");
    expect(formatVolatility(null)).toBe("—");
    expect(formatDelta(0.5234)).toBe("0.52");
    expect(formatDelta(-0.0012)).toBe("0.00");
    expect(formatDelta(-0.084)).toBe("-0.08");
  });
});

describe("derivatives in the terminal", () => {
  it("subscribes to the selected symbol and every book its option chain shows, once each", () => {
    const chainBooks = INSTRUMENTS.filter((i) => i.underlying === "TCS").map((i) => `book:${i.symbol}`);
    expect(marketChannels(INSTRUMENTS, "TCS", "5s")).toEqual(["book:TCS", "candles:TCS:5s", ...chainBooks]);
    const call = option(410_000, "call").symbol;
    const channels = marketChannels(INSTRUMENTS, call, "1m");
    expect(channels.slice(0, 2)).toEqual([`book:${call}`, `candles:${call}:1m`]);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels).toEqual(expect.arrayContaining(chainBooks));
    expect(marketChannels(INSTRUMENTS, "RELIANCE", "5s")).toEqual(["book:RELIANCE", "candles:RELIANCE:5s"]);
  });

  it("splits subscriptions within the gateway's 50 channels a message", () => {
    const channels = Array.from({ length: 120 }, (_, i) => `trades:S${i}`);
    expect(chunks(channels).map((c) => c.length)).toEqual([50, 50, 20]);
    expect(chunks(channels).flat()).toEqual(channels);
    expect(chunks([])).toEqual([]);
  });

  it("states a contract's terms and values it per share times the multiplier", () => {
    expect(contractTerms(option(410_000, "call"))).toBe("TCS 4100 call · 10 shares a contract");
    expect(contractTerms(future(EXPIRY))).toBe("TCS future · 10 shares a contract");
    expect(contractTerms(TCS)).toBeNull();
    expect(orderValue(future(EXPIRY), 410_000, 3)).toBe(12_300_000); // Rs 1,23,000 of notional, in paise
    expect(orderValue(TCS, 410_000, 3)).toBe(1_230_000);
  });

  it("counts down to expiry", () => {
    expect(formatCountdown(12 * 60_000 + 5_000)).toBe("12:05");
    expect(formatCountdown(3_723_000)).toBe("1:02:03");
    expect(formatCountdown(400)).toBe("0:01"); // a part-second left still shows
    expect(formatCountdown(0)).toBe("expired");
  });
});
