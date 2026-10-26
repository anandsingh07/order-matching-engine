import type { Depth, Side } from "@ome/core";

/**
 * What surveillance sees of one trader's activity in one symbol. The same
 * events come from the simulator (to build training data) and from the live
 * gateway (to score traders), so both compute features with the same code.
 */
export type ActivityEvent =
  | {
      kind: "order";
      time: number;
      orderId: string;
      side: Side;
      /** Null for market orders. */
      price: number | null;
      quantity: number;
      /**
       * Typical visible size near the touch on the order's own side when it
       * arrived: the mean of the best three levels. Three levels, not one, so a
       * thin best price does not make every order look huge. Null when that
       * side was empty: there is nothing to compare the order with.
       */
      touchSize: number | null;
      /**
       * How far behind the best price on its own side the order sits, in basis
       * points of the mid: positive is behind the touch, negative is inside the
       * spread. Zero for market orders and for an empty side.
       */
      distanceBps: number;
    }
  | { kind: "cancel"; time: number; orderId: string }
  | {
      kind: "fill";
      time: number;
      orderId: string;
      side: Side;
      quantity: number;
      liquidity: "maker" | "taker";
      counterpartyId: string;
    };

/**
 * Feature order is part of the model's contract: training and scoring must
 * agree. Heavy-tailed counts are on a log10 scale, which also lets the
 * Isolation Forest (which splits uniformly between a feature's min and max)
 * spend its splits where honest traders actually differ.
 */
export const FEATURE_NAMES = [
  "log_orders_per_min",
  "cancel_ratio",
  "log_order_to_trade",
  "log_median_lifetime_ms",
  "fill_ratio",
  "log_size_vs_touch",
  "mean_distance_bps",
  "cancel_after_opposite_fill",
  "log_trades",
  "excess_concentration",
  "excess_partner_exclusivity",
  "two_way_counterparty_share",
  "net_to_gross",
  "taker_share",
  "resting_side_imbalance",
  "max_levels_one_side",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Cancels this soon after a fill on the other side look like spoofing: the fake orders did their job. */
const OPPOSITE_FILL_MS = 2_000;

/** What features need to know about the whole symbol over the same window. */
export interface MarketContext {
  activeTraders: number;
  /** Filled volume of any trader in the window (0 if unknown). */
  volumeOf(traderId: string): number;
}

/** Builds the market context from every active trader's activity in one symbol. */
export function marketContext(now: number, activities: Iterable<[string, TraderActivity]>): MarketContext {
  const volumes = new Map<string, number>();
  for (const [id, activity] of activities) if (activity.activeAt(now)) volumes.set(id, activity.volume(now));
  return { activeTraders: volumes.size, volumeOf: (id) => volumes.get(id) ?? 0 };
}

/** Levels per side that orders are measured against. */
export const TOUCH_LEVELS = 3;

/**
 * Describes an arriving order against the book just before it matches. The
 * simulator and the live monitor both call this, so an order is measured the
 * same way in training and in production.
 */
export function describeOrder(
  book: Depth,
  orderId: string,
  time: number,
  side: Side,
  price: number | null,
  quantity: number,
): Extract<ActivityEvent, { kind: "order" }> {
  const same = (side === "buy" ? book.bids : book.asks).slice(0, TOUCH_LEVELS);
  const touchSize = same.length === 0 ? null : Math.max(1, same.reduce((s, l) => s + l.quantity, 0) / same.length);
  let distanceBps = 0;
  const best = same[0];
  if (price !== null && best !== undefined) {
    const behind = side === "buy" ? best.price - price : price - best.price;
    const bid = book.bids[0]?.price ?? best.price;
    const ask = book.asks[0]?.price ?? best.price;
    distanceBps = (behind / ((bid + ask) / 2)) * 10_000;
  }
  return { kind: "order", time, orderId, side, price, quantity, touchSize, distanceBps };
}

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

interface LiveOrder {
  side: Side;
  price: number;
  placedAt: number;
}

/**
 * A rolling window of one trader's activity in one symbol, turned into a
 * fixed-length feature vector on demand.
 *
 * The features follow what market-abuse surveillance looks at in practice:
 * how much a trader cancels and how fast, how big and how far from the touch
 * their orders are, whether cancels follow fills on the other side (spoofing),
 * how many price levels they stack on one side (layering), whether they keep
 * trading with the same counterparty and end up flat (wash trading), and how
 * aggressive their trading is (pump and dump).
 */
export class TraderActivity {
  private events: ActivityEvent[] = [];
  /** Live orders, kept beyond the window so lifetimes and levels stay correct. */
  private readonly live = new Map<string, LiveOrder>();
  /** Maximum distinct price levels with live orders on either side, seen within the window. */
  private levelPeaks: { time: number; levels: number }[] = [];

  constructor(readonly windowMs: number) {}

  record(event: ActivityEvent): void {
    this.events.push(event);
    if (event.kind === "order" && event.price !== null) {
      this.live.set(event.orderId, { side: event.side, price: event.price, placedAt: event.time });
      this.levelPeaks.push({ time: event.time, levels: this.levelsOneSide() });
    } else if (event.kind === "cancel") {
      this.live.delete(event.orderId);
    }
  }

  /** Marks a resting order as fully filled, so it no longer counts as live. */
  closed(orderId: string): void {
    this.live.delete(orderId);
  }

  /** True if the trader did anything in the window ending at `now`. */
  activeAt(now: number): boolean {
    this.trim(now);
    return this.events.length > 0;
  }

  /** Volume this trader filled within the window ending at `now`. */
  volume(now: number): number {
    this.trim(now);
    let total = 0;
    for (const e of this.events) if (e.kind === "fill") total += e.quantity;
    return total;
  }

  /**
   * `market` describes the symbol over the same window: how many traders
   * were active (concentration is judged against it: trading mostly with one
   * of five traders is normal, with one of fifty is not) and each trader's
   * filled volume (to tell a wash partner, who trades only with you, from a
   * market maker, who trades with everyone).
   */
  features(now: number, market: MarketContext): number[] {
    const activeTraders = market.activeTraders;
    this.trim(now);
    const orders = this.events.filter((e) => e.kind === "order");
    const cancels = this.events.filter((e) => e.kind === "cancel");
    const fills = this.events.filter((e) => e.kind === "fill");
    const limits = orders.filter((o) => o.price !== null);
    const placedAt = new Map(orders.map((o) => [o.orderId, o]));

    const placedQty = orders.reduce((s, o) => s + o.quantity, 0);
    const filledQty = fills.reduce((s, f) => s + f.quantity, 0);

    const lifetimes = cancels.flatMap((c) => {
      const o = placedAt.get(c.orderId);
      return o === undefined ? [] : [c.time - o.time];
    });

    let afterOpposite = 0;
    for (const c of cancels) {
      const o = placedAt.get(c.orderId);
      if (o === undefined) continue;
      const opposite = fills.some((f) => f.side !== o.side && f.time <= c.time && c.time - f.time <= OPPOSITE_FILL_MS);
      if (opposite) afterOpposite++;
    }

    const byCounterparty = new Map<string, { volume: number; bought: boolean; sold: boolean }>();
    let net = 0;
    let taker = 0;
    for (const f of fills) {
      const c = byCounterparty.get(f.counterpartyId) ?? { volume: 0, bought: false, sold: false };
      c.volume += f.quantity;
      if (f.side === "buy") c.bought = true;
      else c.sold = true;
      byCounterparty.set(f.counterpartyId, c);
      net += f.side === "buy" ? f.quantity : -f.quantity;
      if (f.liquidity === "taker") taker += f.quantity;
    }
    let concentration = 0;
    let twoWay = 0;
    let top: { id: string; volume: number } | null = null;
    for (const [id, c] of byCounterparty) {
      concentration += (c.volume / Math.max(1, filledQty)) ** 2;
      // Buying from and selling to the same counterparty in one window: the wash-trade signature.
      if (c.bought && c.sold) twoWay += c.volume;
      if (top === null || c.volume > top.volume) top = { id, volume: c.volume };
    }
    // How much of the main counterparty's own trading was with this trader,
    // above an even share of this market: near 1 for a colluding partner,
    // near 0 for a market maker serving everyone. Measured against the even
    // share because in a market of four, a third of the market maker's flow
    // is normal (live testing showed the raw share flagging retail traders).
    const exclusivity =
      top === null ? 0 : top.volume / Math.max(top.volume, market.volumeOf(top.id)) - 1 / Math.max(1, activeTraders - 1);

    const buyQty = limits.filter((o) => o.side === "buy").reduce((s, o) => s + o.quantity, 0);
    const sellQty = limits.filter((o) => o.side === "sell").reduce((s, o) => s + o.quantity, 0);
    const restingQty = buyQty + sellQty;

    const minutes = this.windowMs / 60_000;
    return [
      Math.log10(1 + orders.length / minutes),
      cancels.length / Math.max(1, orders.length),
      Math.log10(orders.length / Math.max(1, fills.length) + 0.01),
      Math.log10(1 + (lifetimes.length === 0 ? this.windowMs : median(lifetimes))),
      filledQty / Math.max(1, placedQty),
      // Orders that arrived on an empty side have no reference size and are left out.
      Math.log10(1 + median(limits.flatMap((o) => (o.touchSize === null ? [] : [o.quantity / o.touchSize])))),
      limits.length === 0 ? 0 : limits.reduce((s, o) => s + o.distanceBps, 0) / limits.length,
      afterOpposite / Math.max(1, cancels.length),
      Math.log10(1 + fills.length),
      // Above what trading evenly with every other active trader would give.
      filledQty === 0 ? 0 : concentration - 1 / Math.max(1, activeTraders - 1),
      exclusivity,
      filledQty === 0 ? 0 : twoWay / filledQty,
      filledQty === 0 ? 0 : Math.abs(net) / filledQty,
      filledQty === 0 ? 0 : taker / filledQty,
      restingQty === 0 ? 0 : Math.abs(buyQty - sellQty) / restingQty,
      Math.max(0, ...this.levelPeaks.map((p) => p.levels)),
    ];
  }

  private levelsOneSide(): number {
    const buy = new Set<number>();
    const sell = new Set<number>();
    for (const o of this.live.values()) (o.side === "buy" ? buy : sell).add(o.price);
    return Math.max(buy.size, sell.size);
  }

  private trim(now: number): void {
    const from = now - this.windowMs;
    let i = 0;
    while (i < this.events.length && this.events[i]!.time < from) i++;
    if (i > 0) this.events = this.events.slice(i);
    this.levelPeaks = this.levelPeaks.filter((p) => p.time >= from);
  }
}
