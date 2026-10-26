import { describe, expect, it } from "vitest";
import { FEATURE_NAMES, TraderActivity, collectSamples, type ActivityEvent } from "../src/index.js";

const feature = (activity: TraderActivity, now: number) => {
  const values = activity.features(now, { activeTraders: 11, volumeOf: (id) => (id === "partner" ? 40 : 0) });
  return Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, values[i]!])) as Record<(typeof FEATURE_NAMES)[number], number>;
};

const order = (time: number, orderId: string, side: "buy" | "sell", price: number | null, quantity: number, extra: Partial<ActivityEvent> = {}): ActivityEvent =>
  ({ kind: "order", time, orderId, side, price, quantity, touchSize: 10, distanceBps: 0, ...extra }) as ActivityEvent;

describe("TraderActivity features", () => {
  it("leaves orders that arrived on an empty side out of the size comparison", () => {
    const a = new TraderActivity(30_000);
    a.record(order(0, "first", "buy", 99, 25, { touchSize: null }));
    a.record(order(1, "second", "buy", 99, 20, { touchSize: 10 }));
    expect(feature(a, 10).log_size_vs_touch).toBeCloseTo(Math.log10(1 + 2));
  });

  it("measures cancelling: ratio, lifetime, and cancels right after an opposite fill", () => {
    const a = new TraderActivity(30_000);
    a.record(order(0, "big", "buy", 99, 100, { distanceBps: 2, touchSize: 20 }));
    a.record(order(100, "real", "sell", 101, 5));
    a.record({ kind: "fill", time: 500, orderId: "real", side: "sell", quantity: 5, liquidity: "maker", counterpartyId: "x" });
    a.record({ kind: "cancel", time: 800, orderId: "big" });
    const f = feature(a, 1_000);
    expect(f.cancel_ratio).toBe(0.5);
    expect(f.log_median_lifetime_ms).toBeCloseTo(Math.log10(801));
    expect(f.cancel_after_opposite_fill).toBe(1); // cancelled 300 ms after the sell filled
    expect(f.log_size_vs_touch).toBeCloseTo(Math.log10(1 + (5 + 0.5) / 2)); // median of 100/20 and 5/10
    expect(f.fill_ratio).toBeCloseTo(5 / 105);
  });

  it("recognises trading both ways with one counterparty", () => {
    const a = new TraderActivity(30_000);
    a.record({ kind: "fill", time: 1, orderId: "o1", side: "buy", quantity: 10, liquidity: "taker", counterpartyId: "partner" });
    a.record({ kind: "fill", time: 2, orderId: "o2", side: "sell", quantity: 10, liquidity: "maker", counterpartyId: "partner" });
    a.record({ kind: "fill", time: 3, orderId: "o3", side: "buy", quantity: 5, liquidity: "taker", counterpartyId: "someone" });
    const f = feature(a, 10);
    expect(f.two_way_counterparty_share).toBeCloseTo(20 / 25);
    expect(f.excess_concentration).toBeCloseTo((20 / 25) ** 2 + (5 / 25) ** 2 - 1 / 10); // 11 active traders: even spread over 10 others
    expect(f.net_to_gross).toBeCloseTo(5 / 25);
    expect(f.taker_share).toBeCloseTo(15 / 25);
    expect(f.log_trades).toBeCloseTo(Math.log10(4));
    // The partner traded 40 in total, 20 of it with us.
    expect(f.excess_partner_exclusivity).toBeCloseTo(20 / 40 - 1 / 10); // half its volume, against an even 1/10
  });

  it("counts price levels stacked on one side, forgetting orders that are gone", () => {
    const a = new TraderActivity(30_000);
    for (let i = 0; i < 6; i++) a.record(order(i, `l${i}`, "buy", 100 - i, 10));
    expect(feature(a, 10).max_levels_one_side).toBe(6);
    for (let i = 0; i < 6; i++) a.record({ kind: "cancel", time: 20, orderId: `l${i}` });
    a.record(order(40_000, "later", "buy", 100, 10)); // the ladder is gone and out of the window
    expect(feature(a, 40_000).max_levels_one_side).toBe(1);
  });

  it("only looks at the last window", () => {
    const a = new TraderActivity(30_000);
    a.record(order(0, "old", "buy", 100, 10));
    expect(a.activeAt(29_999)).toBe(true);
    expect(a.activeAt(30_001)).toBe(false);
  });
});

describe("simulator", () => {
  it("is deterministic: the same seed gives the same training data", () => {
    const a = collectSamples(7, 90_000);
    const b = collectSamples(7, 90_000);
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    expect(collectSamples(8, 90_000)).not.toEqual(a);
  });

  it("labels manipulators only for windows in which they manipulated", () => {
    const samples = collectSamples(3, 120_000, { everyManipulator: true });
    const labels = new Set(samples.map((s) => s.label));
    for (const l of ["honest", "spoofing", "layering", "wash_trading", "pump_and_dump", "quote_stuffing"]) expect(labels).toContain(l);
    expect(samples.filter((s) => s.label === "honest").every((s) => s.intensity === 0)).toBe(true);
    expect(samples.filter((s) => s.label !== "honest").every((s) => s.intensity > 0)).toBe(true);
  });
});
