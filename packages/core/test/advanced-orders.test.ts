import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/index.js";
import type { EngineEvent, LimitOrderInput, SelfTradePrevention, Side, StopOrderInput } from "../src/types.js";

const limit = (
  id: string,
  traderId: string,
  side: Side,
  price: number,
  quantity: number,
  extra: Partial<LimitOrderInput> = {},
): LimitOrderInput => ({ type: "limit", id, traderId, side, price, quantity, ...extra });

const stop = (id: string, side: Side, stopPrice: number, quantity: number, extra: Partial<StopOrderInput> = {}): StopOrderInput => ({
  type: "stop",
  id,
  traderId: "t9",
  side,
  stopPrice,
  quantity,
  ...extra,
});

type Trade = Extract<EngineEvent, { type: "trade" }>;
const trades = (events: EngineEvent[]) =>
  events.filter((e): e is Trade => e.type === "trade").map((t) => [t.makerOrderId, t.takerOrderId, t.price, t.quantity]);
const types = (events: EngineEvent[]) => events.map((e) => e.type);

describe("iceberg orders", () => {
  it("shows only the display quantity in market depth", () => {
    const book = new OrderBook();
    const events = book.submit(limit("s1", "t1", "sell", 100, 50, { displayQuantity: 10 }));
    expect(events.at(-1)).toMatchObject({ type: "rested", quantity: 50, visible: 10 });
    expect(book.depth().asks).toEqual([{ price: 100, quantity: 10, orders: 1 }]);
    expect(book.getOrder("s1")).toMatchObject({ remaining: 50, visible: 10 });
  });

  it("refills from the reserve and goes to the back of the queue", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "t1", "sell", 100, 25, { displayQuantity: 10 }));
    book.submit(limit("s2", "t2", "sell", 100, 5));
    // Takes s1's first slice (10), then s2 (5), then s1's refilled slice.
    expect(trades(book.submit(limit("b1", "t3", "buy", 100, 18)))).toEqual([
      ["s1", "b1", 100, 10],
      ["s2", "b1", 100, 5],
      ["s1", "b1", 100, 3],
    ]);
    expect(book.getOrder("s1")).toMatchObject({ remaining: 12, visible: 7 });
  });

  it("lets a FOK order count the hidden reserve", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "t1", "sell", 100, 30, { displayQuantity: 5 }));
    const events = book.submit(limit("b1", "t2", "buy", 100, 30, { timeInForce: "FOK" }));
    expect(trades(events).reduce((sum, t) => sum + (t[3] as number), 0)).toBe(30);
  });

  it("cancels the visible and hidden quantity together", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "t1", "sell", 100, 30, { displayQuantity: 5 }));
    expect(book.cancel("s1")[0]).toMatchObject({ type: "cancelled", remaining: 30 });
  });

  it("rejects a display quantity on a non-GTC order", () => {
    const book = new OrderBook();
    const events = book.submit(limit("b1", "t1", "buy", 100, 30, { displayQuantity: 5, timeInForce: "IOC" }));
    expect(events).toMatchObject([{ type: "rejected", reason: "invalid_display_quantity" }]);
  });
});

describe("self-trade prevention", () => {
  const setup = (selfTrade: SelfTradePrevention) => {
    const book = new OrderBook();
    book.submit(limit("s1", "alice", "sell", 100, 10));
    book.submit(limit("s2", "bob", "sell", 100, 10));
    const events = book.submit(limit("b1", "alice", "buy", 100, 15, { selfTrade }));
    return { book, events };
  };

  it("allows the trade by default", () => {
    expect(trades(setup("allow").events)).toEqual([
      ["s1", "b1", 100, 10],
      ["s2", "b1", 100, 5],
    ]);
  });

  it("cancel_taker cancels the incoming order and leaves the book alone", () => {
    const { book, events } = setup("cancel_taker");
    expect(types(events)).toEqual(["accepted", "cancelled"]);
    expect(events[1]).toMatchObject({ orderId: "b1", remaining: 15, reason: "self_trade" });
    expect(book.getOrder("s1")?.remaining).toBe(10);
  });

  it("cancel_maker cancels the resting order and keeps matching", () => {
    const { events } = setup("cancel_maker");
    expect(events[1]).toMatchObject({ type: "cancelled", orderId: "s1", reason: "self_trade" });
    expect(trades(events)).toEqual([["s2", "b1", 100, 10]]);
    expect(events.at(-1)).toMatchObject({ type: "rested", orderId: "b1", quantity: 5 });
  });

  it("cancel_both cancels both orders", () => {
    const { book, events } = setup("cancel_both");
    expect(events.filter((e) => e.type === "cancelled").map((e) => e.orderId)).toEqual(["s1", "b1"]);
    expect(book.getOrder("s2")?.remaining).toBe(10);
  });

  it("kills a FOK order that would hit its own resting order first", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "alice", "sell", 100, 10));
    book.submit(limit("s2", "bob", "sell", 100, 10));
    const events = book.submit(limit("b1", "alice", "buy", 100, 5, { timeInForce: "FOK", selfTrade: "cancel_taker" }));
    expect(events.at(-1)).toMatchObject({ type: "cancelled", reason: "fok_unfillable" });
  });
});

describe("stop orders", () => {
  it("waits off the book until a trade reaches the stop price", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "t1", "sell", 100, 5));
    book.submit(limit("b0", "t2", "buy", 100, 1)); // last price 100
    expect(types(book.submit(stop("st1", "sell", 98, 3)))).toEqual(["accepted", "stop_pending"]);
    expect(book.depth().asks).toEqual([{ price: 100, quantity: 4, orders: 1 }]);
    expect(book.pendingStopCount).toBe(1);
  });

  it("triggers a sell stop as a market order when the price falls to it", () => {
    const book = new OrderBook();
    book.submit(limit("b1", "t1", "buy", 100, 5));
    book.submit(limit("b2", "t1", "buy", 97, 5));
    book.submit(limit("s0", "t2", "sell", 100, 1)); // last 100
    book.submit(stop("st1", "sell", 98, 4));
    const events = book.submit(limit("s1", "t2", "sell", 97, 5)); // trades 4 @100, then 1 @97
    expect(types(events)).toContain("triggered");
    expect(events.find((e) => e.type === "triggered")).toMatchObject({ orderId: "st1", lastPrice: 97 });
    expect(trades(events).at(-1)).toEqual(["b2", "st1", 97, 4]);
  });

  it("enters a stop-limit order at its limit price", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "t1", "sell", 100, 2));
    book.submit(limit("b0", "t2", "buy", 99, 1));
    book.submit(limit("s0", "t2", "sell", 99, 1)); // last 99
    book.submit(stop("st1", "buy", 100, 5, { limitPrice: 101 }));
    const events = book.submit(limit("b1", "t3", "buy", 100, 1)); // last 100: triggers
    expect(trades(events)).toEqual([
      ["s1", "b1", 100, 1],
      ["s1", "st1", 100, 1],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "rested", orderId: "st1", price: 101, quantity: 4 });
  });

  it("cascades when one stop's trades trigger the next", () => {
    const book = new OrderBook();
    book.submit(limit("b1", "t1", "buy", 100, 1));
    book.submit(limit("b2", "t1", "buy", 99, 1));
    book.submit(limit("b3", "t1", "buy", 98, 1));
    book.submit(limit("s0", "t2", "sell", 101, 1));
    book.submit(limit("b0", "t3", "buy", 101, 1)); // last 101
    book.submit(stop("st1", "sell", 100, 1));
    book.submit(stop("st2", "sell", 99, 1));
    const events = book.submit(limit("s1", "t2", "sell", 100, 1)); // 100 -> st1 hits 99 -> st2 hits 98
    expect(events.filter((e) => e.type === "triggered").map((e) => e.orderId)).toEqual(["st1", "st2"]);
    expect(book.lastTradePrice()).toBe(98);
  });

  it("rejects a stop that would trigger immediately", () => {
    const book = new OrderBook();
    book.submit(limit("s1", "t1", "sell", 100, 5));
    book.submit(limit("b1", "t2", "buy", 100, 1)); // last 100
    expect(book.submit(stop("st1", "buy", 100, 1))).toMatchObject([{ type: "rejected", reason: "invalid_stop_price" }]);
  });

  it("can be cancelled but not amended while pending", () => {
    const book = new OrderBook();
    book.submit(stop("st1", "buy", 105, 3));
    expect(book.amend("st1", { quantity: 1 })).toMatchObject([{ type: "rejected", reason: "not_amendable" }]);
    expect(book.cancel("st1")).toMatchObject([{ type: "cancelled", remaining: 3, reason: "user" }]);
    expect(book.pendingStopCount).toBe(0);
  });
});
