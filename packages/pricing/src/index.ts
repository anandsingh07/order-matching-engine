// Option pricing shared by the gateway (reference prices, bands, margin), the
// bots (quoting) and the browser terminal (implied volatility and delta).
// Like @ome/client it uses only standard JavaScript, so it runs anywhere.
export { blackScholes, greeks, intrinsicValue, noArbitrageBounds } from "./black-scholes.ts";
export type { Greeks, OptionInputs, OptionRight } from "./black-scholes.ts";
export { impliedVolatility } from "./implied-volatility.ts";
export type { ImpliedVolatilityOptions } from "./implied-volatility.ts";
export { normalCdf, normalPdf } from "./normal.ts";
export { annualizedVolatility, MINUTES_PER_YEAR, MS_PER_YEAR, volatilityOver, yearsUntil } from "./time.ts";
