import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  annualizedVolatility,
  blackScholes,
  greeks,
  impliedVolatility,
  intrinsicValue,
  noArbitrageBounds,
  normalCdf,
  volatilityOver,
  yearsUntil,
  type OptionInputs,
} from "../src/index.js";

const RUNS = { numRuns: 2_000 };

/** Options from 30 seconds to 5 years, strikes from e^-2 to e^2 of spot, volatility 1% to 500%. */
const option = fc.record({
  spot: fc.double({ min: 1, max: 1e6, noNaN: true }),
  logMoneyness: fc.double({ min: -2, max: 2, noNaN: true }),
  time: fc.double({ min: 1e-6, max: 5, noNaN: true }),
  volatility: fc.double({ min: 0.01, max: 5, noNaN: true }),
  rate: fc.double({ min: 0, max: 0.2, noNaN: true }),
});
type Generated = typeof option extends fc.Arbitrary<infer T> ? T : never;
const inputs = (g: Generated, right: "call" | "put"): OptionInputs => ({
  right,
  spot: g.spot,
  strike: g.spot * Math.exp(g.logMoneyness),
  time: g.time,
  volatility: g.volatility,
  rate: g.rate,
});
/** Rounding slack for prices of this size. */
const eps = (o: OptionInputs) => 1e-9 * Math.max(o.spot, o.strike);

describe("normal distribution", () => {
  it("matches reference values to within 2e-16", () => {
    expect(normalCdf(0)).toBe(0.5);
    for (const [x, reference] of [
      [1, 0.8413447460685429],
      [-1.96, 0.024997895148220435],
      [3, 0.9986501019683699],
      [-5, 2.866515718791939e-7],
      [-8, 6.220960574271784e-16],
    ] as const) {
      expect(Math.abs(normalCdf(x) - reference)).toBeLessThanOrEqual(2e-16);
    }
    expect(normalCdf(-40)).toBe(0);
    expect(normalCdf(40)).toBe(1);
  });
});

describe("Black-Scholes", () => {
  it("reproduces Hull's textbook example: S=42, K=40, r=10%, vol=20%, six months gives c=4.76, p=0.81", () => {
    const hull = { spot: 42, strike: 40, rate: 0.1, volatility: 0.2, time: 0.5 };
    expect(blackScholes({ ...hull, right: "call" })).toBeCloseTo(4.76, 2);
    expect(blackScholes({ ...hull, right: "put" })).toBeCloseTo(0.81, 2);
  });

  it("reproduces Hull's Greek letters example: S=49, K=50, r=5%, vol=20%, 20 weeks", () => {
    // Hull: price 2.40, delta 0.522, gamma 0.066, vega 12.1, theta -4.31 per year.
    const g = greeks({ right: "call", spot: 49, strike: 50, rate: 0.05, volatility: 0.2, time: 20 / 52 });
    expect(g.price).toBeCloseTo(2.4, 2);
    expect(g.delta).toBeCloseTo(0.522, 3);
    expect(g.gamma).toBeCloseTo(0.066, 3);
    expect(g.vega).toBeCloseTo(12.1, 1);
    expect(g.theta).toBeCloseTo(-4.31, 2);
  });

  it("satisfies put-call parity: C - P = S - K e^(-rT)", () => {
    fc.assert(
      fc.property(option, (g) => {
        const call = inputs(g, "call");
        const parity = call.spot - call.strike * Math.exp(-g.rate * g.time);
        expect(Math.abs(blackScholes(call) - blackScholes(inputs(g, "put")) - parity)).toBeLessThanOrEqual(eps(call));
      }),
      RUNS,
    );
  });

  it("stays within the no-arbitrage bounds", () => {
    fc.assert(
      fc.property(option, fc.constantFrom("call" as const, "put" as const), (g, right) => {
        const o = inputs(g, right);
        const { lower, upper } = noArbitrageBounds(o);
        const value = blackScholes(o);
        expect(value).toBeGreaterThanOrEqual(lower - eps(o));
        expect(value).toBeLessThanOrEqual(upper + eps(o));
        expect(lower).toBeGreaterThanOrEqual(intrinsicValue(right, o.spot, o.strike * Math.exp(-g.rate * g.time)) - eps(o));
      }),
      RUNS,
    );
  });

  it("rises with volatility, and with time to expiry", () => {
    fc.assert(
      fc.property(option, fc.double({ min: 0, max: 2, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true }), (g, dv, dt) => {
        for (const right of ["call", "put"] as const) {
          const o = inputs(g, right);
          expect(blackScholes({ ...o, volatility: o.volatility + dv })).toBeGreaterThanOrEqual(blackScholes(o) - eps(o));
        }
        // A European call gains from more time whenever rates are not negative. A
        // deep in-the-money European put can lose from it when rates are positive
        // (the strike is received later), so it is checked at a zero rate.
        const call = inputs(g, "call");
        expect(blackScholes({ ...call, time: call.time + dt })).toBeGreaterThanOrEqual(blackScholes(call) - eps(call));
        const put = { ...inputs(g, "put"), rate: 0 };
        expect(blackScholes({ ...put, time: put.time + dt })).toBeGreaterThanOrEqual(blackScholes(put) - eps(put));
      }),
      RUNS,
    );
  });

  it("falls with the strike for calls and rises with it for puts", () => {
    fc.assert(
      fc.property(option, fc.double({ min: 0, max: 1, noNaN: true }), (g, dk) => {
        const higher = { ...g, logMoneyness: g.logMoneyness + dk };
        const call = inputs(g, "call");
        const put = inputs(g, "put");
        expect(blackScholes(inputs(higher, "call"))).toBeLessThanOrEqual(blackScholes(call) + eps(call));
        expect(blackScholes(inputs(higher, "put"))).toBeGreaterThanOrEqual(blackScholes(put) - eps(put));
      }),
      RUNS,
    );
  });

  it("has Greeks with the right signs that match finite differences", () => {
    fc.assert(
      fc.property(option, fc.constantFrom("call" as const, "put" as const), (g, right) => {
        const o = inputs(g, right);
        // Finite differences need the value to be smooth on the step's scale.
        fc.pre(o.volatility * Math.sqrt(o.time) > 0.02);
        const x = greeks(o);
        expect(x.delta).toBeGreaterThanOrEqual(right === "call" ? 0 : -1);
        expect(x.delta).toBeLessThanOrEqual(right === "call" ? 1 : 0);
        expect(x.gamma).toBeGreaterThanOrEqual(0);
        expect(x.vega).toBeGreaterThanOrEqual(0);
        const h = o.spot * 1e-5;
        const delta = (blackScholes({ ...o, spot: o.spot + h }) - blackScholes({ ...o, spot: o.spot - h })) / (2 * h);
        expect(Math.abs(delta - x.delta)).toBeLessThan(1e-4);
        const dv = 1e-5;
        const vega = (blackScholes({ ...o, volatility: o.volatility + dv }) - blackScholes({ ...o, volatility: o.volatility - dv })) / (2 * dv);
        expect(Math.abs(vega - x.vega)).toBeLessThan(1e-4 * Math.max(o.spot, o.strike));
      }),
      RUNS,
    );
  });

  it("is worth its payoff at expiry", () => {
    expect(greeks({ right: "call", spot: 110, strike: 100, time: 0, volatility: 0.3 })).toEqual({ price: 10, delta: 1, gamma: 0, vega: 0, theta: 0 });
    expect(greeks({ right: "put", spot: 110, strike: 100, time: 0, volatility: 0.3 })).toEqual({ price: 0, delta: 0, gamma: 0, vega: 0, theta: 0 });
    expect(blackScholes({ right: "put", spot: 90, strike: 100, time: -1, volatility: 0.3 })).toBe(10);
  });
});

describe("implied volatility", () => {
  it("recovers the volatility a price was made with", () => {
    fc.assert(
      fc.property(option, fc.constantFrom("call" as const, "put" as const), (g, right) => {
        const o = inputs(g, right);
        const price = blackScholes(o);
        const { lower } = noArbitrageBounds(o);
        // A price indistinguishable from intrinsic value (or from zero) in
        // double precision carries no information about volatility.
        fc.pre(price - lower > 1e-9 * o.spot);
        const iv = impliedVolatility(price, o);
        expect(iv).not.toBeNull();
        // The volatility found prices the option back to the input...
        expect(Math.abs(blackScholes({ ...o, volatility: iv! }) - price)).toBeLessThanOrEqual(1e-10 * price + 1e-13 * o.spot);
        // ...and is the volatility used, wherever the price pins it down.
        if (greeks(o).vega > 1e-4 * o.spot) expect(Math.abs(iv! - o.volatility)).toBeLessThanOrEqual(1e-7 * Math.max(1, o.volatility));
      }),
      RUNS,
    );
  });

  it("is robust deep in and out of the money and seconds before expiry", () => {
    const minute = 1 / (365 * 24 * 60);
    const cases: OptionInputs[] = [
      { right: "call", spot: 4_100, strike: 4_000, time: 30 * minute, volatility: 2.8 }, // the simulator's 30-minute series
      { right: "put", spot: 4_100, strike: 4_150, time: minute, volatility: 2.8 }, // in the money by 3 sigma, one minute left
      { right: "call", spot: 4_100, strike: 4_300, time: 10 / (365 * 24 * 3600), volatility: 2.8 }, // ten seconds left
      { right: "call", spot: 100, strike: 1_000, time: 1, volatility: 0.5 }, // price ~3e-5
      { right: "put", spot: 100, strike: 10, time: 2, volatility: 0.4 }, // price ~1e-6
      { right: "call", spot: 100, strike: 10, time: 2, volatility: 0.9 }, // deep in the money, solved via the put
      { right: "call", spot: 100, strike: 100, time: 1, volatility: 4 },
    ];
    for (const o of cases) {
      const iv = impliedVolatility(blackScholes(o), o);
      expect(iv).not.toBeNull();
      expect(iv!).toBeCloseTo(o.volatility, 6);
    }
  });

  it("returns null when no volatility fits", () => {
    const o = { right: "call" as const, spot: 100, strike: 90, time: 0.5 };
    expect(impliedVolatility(9.99, o)).toBeNull(); // below intrinsic value
    expect(impliedVolatility(10, o)).toBeNull(); // exactly intrinsic: the zero-volatility limit
    expect(impliedVolatility(100.01, o)).toBeNull(); // a call worth more than the share
    expect(impliedVolatility(5, { right: "put", spot: 100, strike: 90, time: 0.5, rate: 0.05 })).not.toBeNull();
    expect(impliedVolatility(90, { right: "put", spot: 100, strike: 90, time: 0.5 })).toBeNull(); // the most a put can be worth
    expect(impliedVolatility(12, { ...o, time: 0 })).toBeNull(); // expired
    expect(impliedVolatility(Number.NaN, o)).toBeNull();
    expect(impliedVolatility(-1, { ...o, strike: 120 })).toBeNull();
  });
});

describe("volatility over time", () => {
  it("scales the 15-minute forecast by the square root of time", () => {
    expect(volatilityOver(1.5, 15, 15 * 60_000)).toBeCloseTo(0.015, 15);
    expect(volatilityOver(1.5, 15, 60 * 60_000)).toBeCloseTo(0.03, 15); // four times as long, twice the move
    expect(volatilityOver(1.5, 15, -5)).toBe(0);
    // An annualised volatility over the same time gives the same move, so Black-Scholes sees it unchanged.
    const now = Date.UTC(2026, 9, 25, 10, 0);
    const time = yearsUntil(now + 30 * 60_000, now);
    expect(annualizedVolatility(1.5, 15) * Math.sqrt(time)).toBeCloseTo(volatilityOver(1.5, 15, 30 * 60_000), 15);
    expect(yearsUntil(now - 1, now)).toBe(0);
    // About 280% a year: the simulated stocks' random walk is 0.05% a second.
    expect(annualizedVolatility(1.5, 15)).toBeCloseTo(0.015 * Math.sqrt(4 * 24 * 365), 12);
  });
});
