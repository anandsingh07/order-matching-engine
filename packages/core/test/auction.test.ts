import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/index.js";
import type { EngineEvent, LimitOrderInput, Side } from "../src/types.js";

const limit = (id: string, side: Side, price: number, quantity: number, extra: Partial<LimitOrderInput> = {}): LimitOrderInput => ({
  type: "limit",
  id,
  traderId: `t-${id}`,
  side,
  price,
  quantity,
  ...extra,
});

type Trade = Extract<EngineEvent, { type: "trade" }>;
const trades = (events: EngineEvent[]) =>
  events.filter((e): e is Trade => e.type === "trade").map((t) => [t.takerOrderId, t.makerOrderId, t.price, t.quantity]);

describe("call auction", () => {
  it("collects orders without matching, even when the book crosses", () => {
    const book = new OrderBook();
    expect(book.startAuction()).toMatchObject([{ type: "phase", phase: "auction" }]);
    book.submit(limit("b1", "buy", 105, 10));
    expect(book.submit(limit("s1", "sell", 95, 10)).map((e) => e.type)).toEqual(["accepted", "rested"]);
    expect(book.bestBid()).toBe(105);
    expect(book.bestAsk()).toBe(95);
  });

  it("refuses orders that cannot wait for the uncross", () => {
    const book = new OrderBook();
    book.startAuction();
    const reason = (events: EngineEvent[]) => (events[0]?.type === "rejected" ? events[0].reason : null);
    expect(reason(book.submit({ type: "market", id: "m", traderId: "t", side: "buy", quantity: 1 }))).toBe("not_allowed_in_auction");
    expect(reason(book.submit(limit("i", "buy", 100, 1, { timeInForce: "IOC" })))).toBe("not_allowed_in_auction");
    expect(reason(book.submit(limit("f", "buy", 100, 1, { timeInForce: "FOK" })))).toBe("not_allowed_in_auction");
    expect(book.submit({ type: "stop", id: "st", traderId: "t", side: "buy", quantity: 1, stopPrice: 120 })[1]?.type).toBe("stop_pending");
  });

  it("uncrosses at the price that trades the most, everyone at that one price", () => {
    const book = new OrderBook();
    book.startAuction();
    book.submit(limit("b1", "buy", 100, 10));
    book.submit(limit("b2", "buy", 99, 20));
    book.submit(limit("b3", "buy", 98, 10));
    book.submit(limit("a1", "sell", 97, 15));
    book.submit(limit("a2", "sell", 99, 10));
    book.submit(limit("a3", "sell", 101, 10));
    // Demand/supply: 97 -> 40/15, 98 -> 40/15, 99 -> 30/25, 100 -> 10/25. Most volume (25) at 99.
    expect(book.indicativeAuction()).toEqual({ price: 99, volume: 25, imbalance: 5 });

    const events = book.uncross();
    expect(trades(events)).toEqual([
      ["b1", "a1", 99, 10], // the 100 bid and the 97 offer both trade at 99
      ["b2", "a1", 99, 5],
      ["b2", "a2", 99, 10],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "phase", phase: "continuous", price: 99, volume: 25 });
    expect(book.phase).toBe("continuous");
    expect(book.bestBid()).toBe(99);
    expect(book.bestAsk()).toBe(101);
    expect(book.getOrder("b2")?.remaining).toBe(5);
  });

  it("breaks volume ties by smallest imbalance, then nearest the last price, then lowest", () => {
    // Equal volume (10) at 99 and 100; imbalance is 5 at 99 and 0 at 100.
    const imbalance = new OrderBook();
    imbalance.startAuction();
    imbalance.submit(limit("b1", "buy", 100, 10));
    imbalance.submit(limit("b2", "buy", 99, 5));
    imbalance.submit(limit("a1", "sell", 99, 10));
    expect(imbalance.indicativeAuction()).toMatchObject({ price: 100, volume: 10, imbalance: 0 });

    // Equal volume and imbalance at 100 and 101: no reference price, so the lowest wins...
    const setup = (book: OrderBook) => {
      book.startAuction();
      book.submit(limit("b1", "buy", 101, 10));
      book.submit(limit("a1", "sell", 99, 5));
      book.submit(limit("a2", "sell", 100, 5));
    };
    const fresh = new OrderBook();
    setup(fresh);
    expect(fresh.indicativeAuction()?.price).toBe(100);

    // ...but after a trade at 101, the price closest to it wins.
    const traded = new OrderBook();
    traded.submit(limit("x1", "sell", 101, 1));
    traded.submit(limit("x2", "buy", 101, 1));
    setup(traded);
    expect(traded.indicativeAuction()?.price).toBe(101);
  });

  it("counts hidden iceberg quantity and refills slices during the uncross", () => {
    const book = new OrderBook();
    book.startAuction();
    book.submit(limit("ice", "sell", 100, 30, { displayQuantity: 5 }));
    book.submit(limit("b1", "buy", 100, 12));
    expect(book.indicativeAuction()).toMatchObject({ price: 100, volume: 12 });
    expect(trades(book.uncross()).map((t) => t[3])).toEqual([5, 5, 2]);
    expect(book.getOrder("ice")).toMatchObject({ remaining: 18, visible: 3 });
  });

  it("resumes continuous trading with nothing traded when the book does not cross", () => {
    const book = new OrderBook();
    book.startAuction();
    book.submit(limit("b1", "buy", 99, 10));
    book.submit(limit("a1", "sell", 101, 10));
    expect(book.indicativeAuction()).toBeNull();
    expect(book.uncross()).toMatchObject([{ type: "phase", phase: "continuous", price: null, volume: 0 }]);
    // Continuous again: a crossing order trades immediately.
    expect(trades(book.submit(limit("b2", "buy", 101, 4)))).toEqual([["b2", "a1", 101, 4]]);
  });

  it("fires stops after the uncross, in continuous trading", () => {
    const book = new OrderBook();
    book.submit(limit("s0", "sell", 100, 1));
    book.submit(limit("b0", "buy", 100, 1)); // last price 100
    book.submit({ type: "stop", id: "st", traderId: "t", side: "sell", quantity: 3, stopPrice: 96 });
    book.submit(limit("rest", "buy", 90, 10));
    book.startAuction();
    book.submit(limit("b1", "buy", 95, 5));
    book.submit(limit("a1", "sell", 95, 5));
    const events = book.uncross();
    expect(events.map((e) => e.type)).toEqual(["trade", "phase", "triggered", "trade"]);
    expect(trades(events).at(-1)).toEqual(["st", "rest", 90, 3]);
  });

  it("ignores repeated phase commands and survives a snapshot mid-auction", () => {
    const book = new OrderBook();
    expect(book.uncross()).toEqual([]);
    book.startAuction();
    expect(book.startAuction()).toEqual([]);
    book.submit(limit("b1", "buy", 101, 5));
    book.submit(limit("a1", "sell", 99, 5));
    const restored = OrderBook.fromSnapshot(JSON.parse(JSON.stringify(book.snapshot())));
    expect(restored.phase).toBe("auction");
    expect(restored.uncross()).toEqual(book.uncross());
  });
});
