/** A young series opens with room for this many candles, so two bars stay candle-sized instead of filling the chart. */
export const MIN_VISIBLE_BARS = 40;
/** A long history opens on its newest this-many candles, still readable; scroll or zoom out for the rest. */
export const MAX_VISIBLE_BARS = 120;
/** Empty slots kept right of the newest candle. */
export const RIGHT_PAD_BARS = 2;

/**
 * The logical range (bar indices) a chart opens on once a series' history has
 * loaded: the newest candles, between MIN_VISIBLE_BARS and MAX_VISIBLE_BARS
 * slots wide, with the newest at the right. Negative indices are empty slots
 * left of the first candle. Null while there is nothing to show.
 *
 * The bar width this sets is kept as live candles append, so it must not come
 * from a series' first few bars (fitting two candles to the chart would show
 * only the newest two for the rest of the session).
 */
export function openingRange(count: number): { from: number; to: number } | null {
  if (count <= 0) return null;
  const slots = Math.min(Math.max(count, MIN_VISIBLE_BARS), MAX_VISIBLE_BARS);
  const last = count - 1;
  return { from: last - slots + 1, to: last + RIGHT_PAD_BARS };
}
