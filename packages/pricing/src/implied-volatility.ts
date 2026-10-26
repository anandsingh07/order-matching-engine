import { greeks, noArbitrageBounds, type OptionInputs } from "./black-scholes.ts";

export interface ImpliedVolatilityOptions {
  /** Highest volatility searched, annualised. Defaults to 1,000 (100,000%). */
  maxVolatility?: number;
  /** Defaults to 200; bisection alone needs about 60 for full precision. */
  maxIterations?: number;
}

/**
 * The volatility at which Black-Scholes gives `price`, or null when no
 * volatility does: a price at or outside the no-arbitrage bounds, or no time
 * left. (A price exactly at the lower bound is the limit of zero volatility,
 * which is not a volatility either.)
 *
 * Newton's method converges in a handful of steps near the money, but far
 * from it vega is almost zero and a Newton step can fly anywhere. So the root
 * is kept bracketed (the price only rises with volatility), and any step that
 * would leave the bracket becomes a bisection step instead. It is solved on
 * the out-of-the-money side: a deep in-the-money price is almost all
 * intrinsic value, and put-call parity turns it into the out-of-the-money
 * option with the same time value, without the cancellation.
 */
export function impliedVolatility(price: number, o: Omit<OptionInputs, "volatility">, options: ImpliedVolatilityOptions = {}): number | null {
  if (!Number.isFinite(price) || !(o.time > 0) || !(o.spot > 0) || !(o.strike > 0)) return null;
  const rate = o.rate ?? 0;
  // C - P for the same strike and expiry.
  const parity = o.spot - o.strike * Math.exp(-rate * o.time);
  let inputs: Omit<OptionInputs, "volatility"> = o;
  let target = price;
  if (o.right === "call" && parity > 0) {
    inputs = { ...o, right: "put" };
    target = price - parity;
  } else if (o.right === "put" && parity < 0) {
    inputs = { ...o, right: "call" };
    target = price + parity;
  }
  const { lower, upper } = noArbitrageBounds(inputs);
  if (!(target > lower) || !(target < upper)) return null;

  const value = (volatility: number) => greeks({ ...inputs, volatility });
  const maxVolatility = options.maxVolatility ?? 1_000;
  let lo = 0;
  let hi = 1;
  while (value(hi).price < target) {
    lo = hi;
    hi *= 2;
    if (hi > maxVolatility) return null;
  }

  // Manaster-Koehler start: the volatility where vega peaks, from which Newton
  // converges monotonically. At the money that is zero, so use the
  // Brenner-Subrahmanyam approximation instead.
  const moneyness = Math.abs(Math.log(o.spot / o.strike) + rate * o.time);
  let sigma = moneyness > 1e-3 ? Math.sqrt((2 * moneyness) / o.time) : Math.sqrt((2 * Math.PI) / o.time) * (target / o.spot);
  if (!(sigma > lo && sigma < hi)) sigma = 0.5 * (lo + hi);

  // Relative to the price: far out of the money a price of 1e-40 is still a
  // valid input, and an absolute tolerance would accept any volatility for it.
  const tolerance = 1e-12 * target;
  for (let i = 0; i < (options.maxIterations ?? 200); i++) {
    const g = value(sigma);
    const diff = g.price - target;
    if (Math.abs(diff) <= tolerance) return sigma;
    if (diff > 0) hi = sigma;
    else lo = sigma;
    if (hi - lo <= 1e-15 * hi) return sigma;
    const newton = sigma - diff / g.vega;
    sigma = newton > lo && newton < hi ? newton : 0.5 * (lo + hi);
  }
  return sigma;
}
