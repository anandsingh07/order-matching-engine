import { normalCdf, normalPdf } from "./normal.ts";

export type OptionRight = "call" | "put";

/**
 * A European option on a non-dividend-paying underlying. Any consistent price
 * unit works (rupees, or integer ticks): the value comes out in the same unit.
 */
export interface OptionInputs {
  right: OptionRight;
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  time: number;
  /** Annualised volatility of the log return: 0.2 is 20%. */
  volatility: number;
  /** Continuously compounded risk-free rate per year. Defaults to 0. */
  rate?: number;
}

export interface Greeks {
  price: number;
  /** dV/dS. */
  delta: number;
  /** d2V/dS2. */
  gamma: number;
  /** dV/d(volatility), per 1.00 of volatility (divide by 100 for one vol point). */
  vega: number;
  /** dV/dt as calendar time passes, per year (divide by 365 for one day); usually negative. */
  theta: number;
}

/** What the option would pay if it expired now with the underlying at `spot`. */
export function intrinsicValue(right: OptionRight, spot: number, strike: number): number {
  return Math.max(0, right === "call" ? spot - strike : strike - spot);
}

/**
 * Model-free no-arbitrage bounds for a European option's price. A call is worth
 * at least the forward intrinsic value S - K e^(-rT) and never more than the
 * share; a put at least K e^(-rT) - S and never more than the discounted
 * strike. Any price outside them is a riskless profit for someone.
 */
export function noArbitrageBounds(o: Omit<OptionInputs, "volatility">): { lower: number; upper: number } {
  const discountedStrike = o.strike * Math.exp(-(o.rate ?? 0) * Math.max(0, o.time));
  return o.right === "call"
    ? { lower: Math.max(0, o.spot - discountedStrike), upper: o.spot }
    : { lower: Math.max(0, discountedStrike - o.spot), upper: discountedStrike };
}

/** d1 and d2, or null when there is no time or volatility left and the value is deterministic. */
function d(o: OptionInputs): { d1: number; d2: number; sqrtT: number } | null {
  if (!(o.time > 0) || !(o.volatility > 0)) return null;
  const sqrtT = Math.sqrt(o.time);
  const sd = o.volatility * sqrtT;
  const d1 = (Math.log(o.spot / o.strike) + ((o.rate ?? 0) + 0.5 * o.volatility * o.volatility) * o.time) / sd;
  return { d1, d2: d1 - sd, sqrtT };
}

/** The Black-Scholes value of a European call or put. */
export function blackScholes(o: OptionInputs): number {
  return greeks(o).price;
}

/**
 * Value and Greeks in closed form. At expiry (or with zero volatility) the
 * value is the payoff of the forward, delta a step, and the other Greeks zero.
 */
export function greeks(o: OptionInputs): Greeks {
  const rate = o.rate ?? 0;
  const discount = Math.exp(-rate * Math.max(0, o.time));
  const k = o.strike * discount;
  const call = o.right === "call";
  const terms = d(o);
  if (terms === null) {
    const price = Math.max(0, call ? o.spot - k : k - o.spot);
    const inTheMoney = call ? o.spot > k : o.spot < k;
    return { price, delta: inTheMoney ? (call ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0 };
  }
  const { d1, d2, sqrtT } = terms;
  const density = normalPdf(d1);
  const decay = (-o.spot * density * o.volatility) / (2 * sqrtT);
  const gamma = density / (o.spot * o.volatility * sqrtT);
  const vega = o.spot * density * sqrtT;
  if (call) {
    const nd2 = normalCdf(d2);
    // Floating-point cancellation can leave a hair below zero far out of the money.
    return { price: Math.max(0, o.spot * normalCdf(d1) - k * nd2), delta: normalCdf(d1), gamma, vega, theta: decay - rate * k * nd2 };
  }
  const nMinusD2 = normalCdf(-d2);
  return {
    price: Math.max(0, k * nMinusD2 - o.spot * normalCdf(-d1)),
    // -N(-d1) rather than N(d1) - 1, which cancels to noise far out of the money.
    delta: -normalCdf(-d1),
    gamma,
    vega,
    theta: decay + rate * k * nMinusD2,
  };
}
