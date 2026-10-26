import type { Quote } from "./quotes.js";

export interface OptionQuoteParams {
  /** Where to centre the quotes, in ticks: fair value, after any inventory skew. */
  fair: number;
  /** Distance from `fair` to each quote, in ticks (before rounding outwards to the tick grid). */
  halfSpread: number;
  /**
   * No-arbitrage bounds at the underlying's actual price, in ticks. An ask
   * below the lower bound (intrinsic value) or a bid above the upper one
   * would hand someone a riskless profit at the market maker's expense.
   */
  bounds: { lower: number; upper: number };
  tickSize: number;
  /** Contracts per quote. */
  size: number;
  /** False stops quoting that side: a position, delta or vega limit. */
  bid: boolean;
  ask: boolean;
}

const floorTo = (value: number, step: number) => Math.floor(value / step) * step;
const ceilTo = (value: number, step: number) => Math.ceil(value / step) * step;

/**
 * One bid and one ask around a derivative's value: on the tick grid,
 * strictly positive, uncrossed, and inside the no-arbitrage bounds. The ask
 * is pulled into the bounds if it falls outside them; a bid that would fall
 * below them is dropped instead of raised, because far out of the money that
 * would mean paying a tick for an option worth a fraction of one.
 */
export function computeOptionQuotes(p: OptionQuoteParams): Quote[] {
  const tick = p.tickSize;
  const lowest = Math.max(tick, ceilTo(p.bounds.lower, tick));
  const highest = floorTo(p.bounds.upper, tick);
  if (highest < lowest) return [];
  const half = Math.max(tick, p.halfSpread);
  const ask = Math.min(highest, Math.max(lowest, ceilTo(p.fair + half, tick)));
  const wanted = floorTo(p.fair - half, tick);
  const bid = wanted < lowest ? null : Math.min(highest, wanted);
  const quotes: Quote[] = [];
  if (p.bid && bid !== null && bid < ask) quotes.push({ side: "buy", price: bid, quantity: p.size });
  if (p.ask) quotes.push({ side: "sell", price: ask, quantity: p.size });
  return quotes;
}

/**
 * Keeps a resting quote in place of a new one on the same side when it is
 * within `tolerance` ticks of it and still inside the bounds: its queue
 * position is worth more than a fraction of a spread, and requoting every
 * series on every tick of the underlying would spend the action budget many
 * times over. Kept prices never cross each other.
 */
export function keepCloseQuotes(
  quotes: Quote[],
  resting: readonly { side: Quote["side"]; price: number }[],
  tolerance: number,
  bounds: OptionQuoteParams["bounds"],
  tickSize: number,
): Quote[] {
  const lowest = Math.max(tickSize, ceilTo(bounds.lower, tickSize));
  const highest = floorTo(bounds.upper, tickSize);
  const kept = quotes.map((q) => {
    const current = resting.find((o) => o.side === q.side && Math.abs(o.price - q.price) <= tolerance && o.price >= lowest && o.price <= highest);
    return current === undefined ? q : { ...q, price: current.price };
  });
  const bid = kept.find((q) => q.side === "buy");
  const ask = kept.find((q) => q.side === "sell");
  return bid !== undefined && ask !== undefined && bid.price >= ask.price ? quotes : kept;
}
