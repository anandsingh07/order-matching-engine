// Turning the gateway's volatility forecast into the inputs Black-Scholes needs.
//
// The forecast (status.volatility, from @ome/volatility) is a typical move of
// `sigmaPct` percent over `horizonMinutes` (15). Option maths wants an
// annualised volatility and a time in years. The simulated market trades
// around the clock, so a year is 365 calendar days, not 252 trading days.

export const MINUTES_PER_YEAR = 365 * 24 * 60;
export const MS_PER_YEAR = MINUTES_PER_YEAR * 60_000;

/** Years from `now` until `expiry` (both ms since epoch); 0 once it has passed. */
export function yearsUntil(expiry: number, now: number): number {
  return Math.max(0, expiry - now) / MS_PER_YEAR;
}

/**
 * A forecast move of `sigmaPct` percent over `horizonMinutes` as an annualised
 * volatility. Under a random walk variance grows linearly with time, so the
 * standard deviation scales with its square root.
 */
export function annualizedVolatility(sigmaPct: number, horizonMinutes: number): number {
  return (sigmaPct / 100) * Math.sqrt(MINUTES_PER_YEAR / horizonMinutes);
}

/**
 * The standard deviation of the log return over `durationMs`, from the same
 * forecast by square-root-of-time scaling: 1.5% over 15 minutes is 3% over an
 * hour. This is volatility x sqrt(time), the quantity option values depend on.
 */
export function volatilityOver(sigmaPct: number, horizonMinutes: number, durationMs: number): number {
  return (sigmaPct / 100) * Math.sqrt(Math.max(0, durationMs) / (horizonMinutes * 60_000));
}
