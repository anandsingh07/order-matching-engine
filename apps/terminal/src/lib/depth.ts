import type { DepthLevel } from "@ome/client";

export interface LadderRow {
  price: number;
  quantity: number;
  orders: number;
  /** Running total from the best price outwards. */
  total: number;
  /** total / the largest total on either side, for depth bars (0..1). */
  share: number;
}

export interface Ladder {
  /** Best (lowest) first. */
  asks: LadderRow[];
  /** Best (highest) first. */
  bids: LadderRow[];
  spread: number | null;
  mid: number | null;
}

function cumulate(levels: DepthLevel[], count: number): LadderRow[] {
  let total = 0;
  return levels.slice(0, count).map((l) => {
    total += l.quantity;
    return { ...l, total, share: 0 };
  });
}

/** Turns raw depth into ladder rows with cumulative totals scaled on one shared axis. */
export function ladder(bids: DepthLevel[], asks: DepthLevel[], levels: number): Ladder {
  const b = cumulate(bids, levels);
  const a = cumulate(asks, levels);
  const max = Math.max(b.at(-1)?.total ?? 0, a.at(-1)?.total ?? 0);
  for (const row of [...a, ...b]) row.share = max === 0 ? 0 : row.total / max;
  const bestBid = b[0]?.price;
  const bestAsk = a[0]?.price;
  const both = bestBid !== undefined && bestAsk !== undefined;
  return {
    asks: a,
    bids: b,
    spread: both ? bestAsk - bestBid : null,
    mid: both ? (bestAsk + bestBid) / 2 : null,
  };
}
