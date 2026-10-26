import { instrumentKind, type DepthLevel, type Instrument, type MarketStatus } from "@ome/client";
import { annualizedVolatility, greeks, impliedVolatility, yearsUntil } from "./pricing";

export interface ChainQuote {
  instrument: Instrument;
  bid: number | null;
  ask: number | null;
  /** Annualised volatility implied by the mid; null without a two-sided quote, or when no volatility prices the mid. */
  iv: number | null;
  /** Black-Scholes delta at that implied volatility; null without one. */
  delta: number | null;
}

export interface ChainRow {
  strike: number;
  call: ChainQuote | null;
  put: ChainQuote | null;
}

/** Everything listed on one underlying for one expiry. */
export interface OptionChain {
  expiry: number;
  future: Instrument | null;
  /** Lowest strike first. */
  rows: ChainRow[];
}

export type Books = Record<string, { bids: DepthLevel[]; asks: DepthLevel[] } | undefined>;

/**
 * What the market's quotes say about one option: implied volatility from
 * the mid of the best bid and ask, and delta at that volatility. Using the
 * market's own price, not a model value, is the point: it shows what
 * volatility the market maker is charging for, to compare with the forecast.
 */
function quote(instrument: Instrument, books: Books, spot: number, now: number): ChainQuote {
  const book = books[instrument.symbol];
  const bid = book?.bids[0]?.price ?? null;
  const ask = book?.asks[0]?.price ?? null;
  const inputs = { right: instrument.right ?? ("call" as const), spot, strike: instrument.strike ?? 0, time: yearsUntil(instrument.expiry ?? 0, now) };
  const iv = bid === null || ask === null ? null : impliedVolatility((bid + ask) / 2, inputs);
  return { instrument, bid, ask, iv, delta: iv === null ? null : greeks({ ...inputs, volatility: iv }).delta };
}

/** The option chains on `underlying`, soonest expiry first, priced at the underlying's price `spot` (ticks). */
export function optionChains(instruments: Instrument[], underlying: string, books: Books, spot: number, now: number): OptionChain[] {
  const chains = new Map<number, OptionChain>();
  for (const i of instruments) {
    if (i.underlying !== underlying || i.expiry === undefined || instrumentKind(i) === "spot") continue;
    let chain = chains.get(i.expiry);
    if (chain === undefined) chains.set(i.expiry, (chain = { expiry: i.expiry, future: null, rows: [] }));
    if (instrumentKind(i) === "future") {
      chain.future = i;
      continue;
    }
    let row = chain.rows.find((r) => r.strike === i.strike);
    if (row === undefined) chain.rows.push((row = { strike: i.strike ?? 0, call: null, put: null }));
    row[i.right === "put" ? "put" : "call"] = quote(i, books, spot, now);
  }
  for (const chain of chains.values()) chain.rows.sort((a, b) => a.strike - b.strike);
  return [...chains.values()].sort((a, b) => a.expiry - b.expiry);
}

/** The strike nearest the underlying's price. */
export function atTheMoney(rows: ChainRow[], spot: number): number | null {
  let best: number | null = null;
  for (const { strike } of rows) if (best === null || Math.abs(strike - spot) < Math.abs(best - spot)) best = strike;
  return best;
}

/** Whether exercising now would pay: a call below the price, a put above it. */
export const inTheMoney = (right: "call" | "put", strike: number, spot: number) => (right === "call" ? strike < spot : strike > spot);

/**
 * The underlying's price the chain is valued at, in ticks: its last trade,
 * else the reference price its status reports, else the instrument's.
 */
export function underlyingPrice(last: number | undefined, status: MarketStatus | undefined, instrument: Instrument | undefined): number | null {
  return last ?? status?.referencePrice ?? instrument?.referencePrice ?? null;
}

/** The gateway's forecast for the underlying as an annualised volatility, the unit implied volatility is quoted in. */
export function forecastVolatility(status: MarketStatus | undefined): number | null {
  const v = status?.volatility;
  return v === null || v === undefined ? null : annualizedVolatility(v.sigmaPct, v.horizonMinutes);
}

/** An annualised volatility as a percentage: 2.81 -> "281%". */
export const formatVolatility = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** A delta to two decimals: "0.52", "-0.08"; a far out-of-the-money put's -0.001 is "0.00", not "-0.00". */
export function formatDelta(d: number | null): string {
  if (d === null) return "—";
  const rounded = Number(d.toFixed(2));
  return (rounded === 0 ? 0 : rounded).toFixed(2);
}
