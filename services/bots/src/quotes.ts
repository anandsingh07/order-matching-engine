import type { Side } from "@ome/client";

export interface QuoteParams {
  /** Fair value, in price ticks. */
  fair: number;
  /** Current inventory in quantity units; positive is long. */
  position: number;
  tickSize: number;
  /** Price levels per side. */
  levels: number;
  /** Distance from the reservation price to the first quote, in basis points of fair value. */
  halfSpreadBps: number;
  /** Extra distance between successive levels, in basis points. */
  stepBps: number;
  /** Quantity per level. */
  size: number;
  /** Stop adding to a position beyond this. */
  maxPosition: number;
  /** How far quotes shift per unit of maxPosition held, in basis points. */
  skewBps: number;
  /** Multiplies the spread and the level steps; above 1 when volatility is high. Defaults to 1. */
  widening?: number;
}

export interface Quote {
  side: Side;
  price: number;
  quantity: number;
}

const floorTo = (value: number, step: number) => Math.floor(value / step) * step;
const ceilTo = (value: number, step: number) => Math.ceil(value / step) * step;

/**
 * A ladder of bids and asks around fair value, with inventory skew.
 *
 * The reservation price is fair value moved against the current position: a
 * long market maker quotes lower, so it is more likely to sell, and vice
 * versa (the idea behind Avellaneda-Stoikov). At the position limit, the side
 * that would grow the position is not quoted at all. Prices land on the tick
 * grid, and the best bid always stays below the best ask.
 */
export function computeQuotes(p: QuoteParams): Quote[] {
  const bps = p.fair / 10_000;
  // Capped at the limit: fills can overshoot it, and an unbounded skew would
  // drag quotes towards zero or below.
  const inventory = Math.max(-1, Math.min(1, p.position / p.maxPosition));
  const reservation = p.fair - inventory * p.skewBps * bps;
  const quotes: Quote[] = [];
  let previousBid = Infinity;
  let previousAsk = -Infinity;
  const widening = p.widening ?? 1;
  for (let i = 0; i < p.levels; i++) {
    const offset = (p.halfSpreadBps + i * p.stepBps) * widening * bps;
    // Each level at least one tick beyond the last, even when the offsets are
    // smaller than a tick.
    const bid = Math.min(floorTo(reservation - offset, p.tickSize), previousBid - p.tickSize);
    let ask = Math.max(ceilTo(reservation + offset, p.tickSize), previousAsk + p.tickSize);
    if (i === 0 && ask <= bid) ask = bid + p.tickSize;
    previousBid = bid;
    previousAsk = ask;
    if (p.position < p.maxPosition && bid > 0) quotes.push({ side: "buy", price: bid, quantity: p.size });
    if (p.position > -p.maxPosition && ask > 0) quotes.push({ side: "sell", price: ask, quantity: p.size });
  }
  return quotes;
}
