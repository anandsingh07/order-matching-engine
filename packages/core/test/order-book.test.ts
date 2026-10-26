import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/index.js";
import type { EngineEvent, LimitOrderInput, Side, TimeInForce } from "../src/types.js";

const limit = (id: string, side: Side, price: number, quantity: number, timeInForce?: TimeInForce): LimitOrderInput => ({
  type: "limit",
  id,
  traderId: "t1",
  side,
  price,
  quantity,
  ...(timeInForce === undefined ? {} : { timeInForce }),
});

type Trade = Extract<EngineEvent, { type: "trade" }>;

const trades = (events: EngineEvent[]) =>
  events
    .filter((e): e is Trade => e.type === "trade")
    .map(({ price, quantity, makerOrderId, takerOrderId }) => ({ price, quantity, makerOrderId, takerOrderId }));

const types = (events: EngineEvent[]) => events.map((e) => e.type);

describe("OrderBook", () => {
  it("rests a limit order when nothing crosses", () => {
    const book = new OrderBook();
    expect(types(book.submit(limit("b1", "buy", 100, 10)))).toEqual(["accepted", "rested"]);
    expect(book.bestBid()).toBe(100);
    expect(book.bestAsk()).toBeNull();
  });

  it("trades at the resting order's price", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "sell", 100, 10));
    const events = book.submit(limit("b1", "buy", 105, 4));
    expect(trades(events)).toEqual([{ price: 100, quantity: 4, makerOrderId: "s1", takerOrderId: "b1" }]);
    expect(book.getOrder("s1")?.remaining).toBe(6);
    expect(book.getOrder("b1")).toBeUndefined();
  });

  it("fills orders at the same price first come, first served", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "sell", 100, 5));
    book.submit(limit("s2", "sell", 100, 5));
    expect(trades(book.submit(limit("b1", "buy", 100, 7)))).toEqual([
      { price: 100, quantity: 5, makerOrderId: "s1", takerOrderId: "b1" },
      { price: 100, quantity: 2, makerOrderId: "s2", takerOrderId: "b1" },
    ]);
  });

  it("walks price levels from best to worst and rests the rest", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "sell", 100, 5));
    book.submit(limit("s2", "sell", 101, 5));
    book.submit(limit("s3", "sell", 103, 5));
    const events = book.submit(limit("b1", "buy", 102, 12));
    expect(trades(events).map((t) => [t.price, t.quantity])).toEqual([
      [100, 5],
      [101, 5],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "rested", orderId: "b1", price: 102, quantity: 2 });
    expect(book.bestBid()).toBe(102);
    expect(book.bestAsk()).toBe(103);
  });

  it("cancels the unfilled part of a market order", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "sell", 100, 3));
    const events = book.submit({ type: "market", id: "m1", traderId: "t2", side: "buy", quantity: 5 });
    expect(trades(events)).toEqual([{ price: 100, quantity: 3, makerOrderId: "s1", takerOrderId: "m1" }]);
    expect(events.at(-1)).toMatchObject({ type: "cancelled", remaining: 2, reason: "unfilled_remainder" });
  });

  it("cancels the unfilled part of an IOC limit order", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "sell", 100, 3));
    const events = book.submit(limit("b1", "buy", 101, 5, "IOC"));
    expect(types(events)).toEqual(["accepted", "trade", "cancelled"]);
    expect(book.bestBid()).toBeNull();
  });

  it("kills a FOK order that cannot be filled completely", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "sell", 100, 3));
    const events = book.submit(limit("b1", "buy", 100, 5, "FOK"));
    expect(types(events)).toEqual(["accepted", "cancelled"]);
    expect(events.at(-1)).toMatchObject({ reason: "fok_unfillable", remaining: 5 });
    expect(book.getOrder("s1")?.remaining).toBe(3);
  });

  it("fills a FOK order completely when there is enough liquidity", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "sell", 100, 3));
    book.submit(limit("s2", "sell", 101, 3));
    const events = book.submit(limit("b1", "buy", 101, 5, "FOK"));
    expect(trades(events).map((t) => t.quantity)).toEqual([3, 2]);
  });

  it("cancels a resting order and removes its empty level", () => {
    const book = new OrderBook();
    book.submit(limit("b1", "buy", 100, 10));
    expect(book.cancel("b1").at(-1)).toMatchObject({ type: "cancelled", remaining: 10, reason: "user" });
    expect(book.depth().bids).toEqual([]);
    expect(book.restingOrderCount).toBe(0);
  });

  it("rejects cancelling an unknown order", () => {
    const book = new OrderBook();
    expect(book.cancel("nope")).toMatchObject([{ type: "rejected", reason: "unknown_order" }]);
  });

  it("keeps time priority when an amend only reduces quantity", () => {
    const book = new OrderBook();
    book.submit(limit("b1", "buy", 100, 10));
    book.submit(limit("b2", "buy", 100, 10));
    expect(book.amend("b1", { quantity: 4 })).toMatchObject([{ type: "amended", keptPriority: true }]);
    expect(trades(book.submit(limit("s1", "sell", 100, 5))).map((t) => t.makerOrderId)).toEqual(["b1", "b2"]);
  });

  it("loses time priority when an amend increases quantity", () => {
    const book = new OrderBook();
    book.submit(limit("b1", "buy", 100, 10));
    book.submit(limit("b2", "buy", 100, 10));
    expect(book.amend("b1", { quantity: 20 })[0]).toMatchObject({ type: "amended", keptPriority: false });
    expect(trades(book.submit(limit("s1", "sell", 100, 5))).map((t) => t.makerOrderId)).toEqual(["b2"]);
  });

  it("trades immediately when an amended price crosses the spread", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "sell", 105, 5));
    book.submit(limit("b1", "buy", 100, 5));
    const events = book.amend("b1", { price: 105 });
    expect(types(events)).toEqual(["amended", "trade"]);
    expect(book.restingOrderCount).toBe(0);
  });

  it("rejects invalid orders", () => {
    const book = new OrderBook();
    book.submit(limit("b1", "buy", 100, 10));
    const reasonFor = (events: EngineEvent[]) => (events[0]?.type === "rejected" ? events[0].reason : null);
    expect(reasonFor(book.submit(limit("b1", "buy", 100, 10)))).toBe("duplicate_id");
    expect(reasonFor(book.submit(limit("b2", "buy", 100, 0)))).toBe("invalid_quantity");
    expect(reasonFor(book.submit(limit("b3", "buy", 100, 1.5)))).toBe("invalid_quantity");
    expect(reasonFor(book.submit(limit("b4", "buy", 0, 10)))).toBe("invalid_price");
    expect(reasonFor(book.submit(limit("b5", "buy", -1, 10)))).toBe("invalid_price");
    expect(reasonFor(book.amend("b1", { quantity: 0 }))).toBe("invalid_quantity");
  });

  it("accepts an id again once the original order has left the book", () => {
    const book = new OrderBook();
    book.submit(limit("b1", "buy", 100, 10));
    book.cancel("b1");
    expect(types(book.submit(limit("b1", "buy", 100, 10)))).toEqual(["accepted", "rested"]);
  });

  it("aggregates depth per price level, best first", () => {
    const book = new OrderBook();
    book.submit(limit("b1", "buy", 100, 5));
    book.submit(limit("b2", "buy", 100, 3));
    book.submit(limit("b3", "buy", 99, 1));
    book.submit(limit("s1", "sell", 101, 2));
    expect(book.depth()).toEqual({
      bids: [
        { price: 100, quantity: 8, orders: 2 },
        { price: 99, quantity: 1, orders: 1 },
      ],
      asks: [{ price: 101, quantity: 2, orders: 1 }],
    });
    expect(book.depth(1).bids).toHaveLength(1);
  });

  it("stamps every event with an increasing sequence number", () => {
    const book = new OrderBook();
    const all = [
      ...book.submit(limit("s1", "sell", 100, 5)),
      ...book.submit(limit("b1", "buy", 100, 3)),
      ...book.cancel("s1"),
    ];
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  });
});
