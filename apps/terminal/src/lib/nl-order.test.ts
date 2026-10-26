import type { ClientOrder, Instrument, ParseOrderReply } from "@ome/client";
import { describe, expect, it } from "vitest";
import { coveredOrders, failureText, FOK_DROPPED, reduce, STOP_TIF_DROPPED, sentRows, sourceLine, ticketPlan, type BoxState } from "./nl-order";
import { newOrder, type MyOrder } from "./orders";

const TCS: Instrument = { symbol: "TCS", name: "TCS", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 410_000 };
const BTC: Instrument = { symbol: "BTCUSDT", name: "BTC", currency: "USDT", priceScale: 100, quantityScale: 100_000, tickSize: 1, lotSize: 1, referencePrice: 8_000_000 };

describe("ticketPlan: what prefilling the ticket would really send", () => {
  it("round-trips limit, iceberg, stop, stop-limit and market orders exactly", () => {
    const orders: ClientOrder[] = [
      { type: "limit", side: "buy", price: 410_000, quantity: 10, timeInForce: "GTC" },
      { type: "limit", side: "buy", price: 410_000, quantity: 10, timeInForce: "IOC" },
      { type: "limit", side: "sell", price: 410_000, quantity: 3, timeInForce: "GTC", displayQuantity: 1 },
      { type: "stop", side: "sell", quantity: 3, stopPrice: 400_000 },
      { type: "stop", side: "buy", quantity: 3, stopPrice: 420_000, limitPrice: 421_000, timeInForce: "GTC" },
      { type: "market", side: "buy", quantity: 5 },
    ];
    for (const order of orders) {
      const plan = ticketPlan(TCS, order);
      expect(plan).toMatchObject({ sent: order, differences: [] });
    }
    expect(ticketPlan(TCS, orders[0]!)).toMatchObject({ form: { kind: "limit", side: "buy", price: "4100.00", quantity: "10", timeInForce: "GTC" } });
    expect(ticketPlan(TCS, orders[3]!)).toMatchObject({ form: { kind: "stop", stopPrice: "4000.00", price: "" } });
  });

  it("treats immediate-or-cancel on a market order as what the ticket sends anyway", () => {
    expect(ticketPlan(TCS, { type: "market", side: "buy", quantity: 5, timeInForce: "IOC" })).toMatchObject({ differences: [] });
  });

  it("says so when fill-or-kill on a market order cannot be kept", () => {
    const plan = ticketPlan(TCS, { type: "market", side: "buy", quantity: 5, timeInForce: "FOK" });
    expect(plan).toMatchObject({ sent: { type: "market", side: "buy", quantity: 5 }, differences: [FOK_DROPPED] });
  });

  it("says a plain stop loses its time in force, without calling it a market order", () => {
    for (const timeInForce of ["FOK", "IOC"] as const) {
      const plan = ticketPlan(TCS, { type: "stop", side: "sell", quantity: 3, stopPrice: 400_000, timeInForce });
      expect(plan).toMatchObject({ sent: { type: "stop", side: "sell", quantity: 3, stopPrice: 400_000 }, differences: [STOP_TIF_DROPPED] });
      expect(plan).not.toHaveProperty("sent.timeInForce");
    }
    // A stop limit keeps it.
    expect(ticketPlan(TCS, { type: "stop", side: "sell", quantity: 3, stopPrice: 400_000, limitPrice: 399_000, timeInForce: "FOK" })).toMatchObject({ differences: [] });
  });

  it("flags any other change, and refuses what the ticket cannot take", () => {
    // An iceberg showing the whole order is sent as a plain limit order.
    expect(ticketPlan(TCS, { type: "limit", side: "buy", price: 410_000, quantity: 2, timeInForce: "GTC", displayQuantity: 2 })).toMatchObject({
      differences: ["The ticket would send something different from what was read: check every field."],
    });
    expect(ticketPlan(TCS, { type: "limit", side: "buy", price: 410_001, quantity: 2 })).toEqual({ error: "The ticket cannot take this order: Price must be a multiple of 0.05." });
  });
});

describe("sentRows", () => {
  it("formats what will be sent as the ticket shows it", () => {
    expect(sentRows(BTC, { type: "limit", side: "sell", price: 8_000_000, quantity: 1000, timeInForce: "GTC" })).toEqual([
      { term: "Side", value: "Sell" },
      { term: "Instrument", value: "BTCUSDT" },
      { term: "Type", value: "Limit" },
      { term: "Quantity", value: "0.01000" },
      { term: "Price", value: "80000.00 USDT" },
      { term: "Time in force", value: "Good till cancelled" },
    ]);
    expect(sentRows(TCS, { type: "stop", side: "sell", quantity: 3, stopPrice: 400_000 }).map((r) => r.value)).toEqual(["Sell", "TCS", "Stop (market once triggered)", "3", "4000.00 INR"]);
    expect(sentRows(TCS, { type: "limit", side: "buy", price: 165_000, quantity: 3, timeInForce: "GTC", displayQuantity: 1 }).at(-1)).toEqual({ term: "Iceberg (show)", value: "1" });
  });
});

describe("coveredOrders", () => {
  const order = (id: string, symbol: string, side: "buy" | "sell", status: MyOrder["status"]): MyOrder => ({
    ...newOrder(symbol, id, { type: "limit", side, price: 100, quantity: 1 }, 0),
    status,
  });
  const orders = [order("a", "INFY", "buy", "open"), order("b", "INFY", "sell", "open"), order("c", "INFY", "buy", "filled"), order("d", "INFY", "buy", "cancelled"), order("e", "TCS", "buy", "stop_pending")];

  it("lists only working orders the cancel covers, by symbol and side", () => {
    const ids = (symbol: string | null, side: "buy" | "sell" | null) => coveredOrders({ kind: "cancel", symbol, side, summary: "" }, orders).map((o) => o.clientOrderId);
    expect(ids("INFY", null)).toEqual(["a", "b"]);
    expect(ids("INFY", "buy")).toEqual(["a"]);
    expect(ids(null, null)).toEqual(["a", "b", "e"]);
    expect(ids("HDFCBANK", null)).toEqual([]);
  });
});

describe("failureText and sourceLine", () => {
  it("explains why the gateway never read the text", () => {
    const failed = (status: number | null, extra: { retryAfterMs?: number } = {}) => failureText({ kind: "failed", status, message: "boom", ...extra });
    expect(failed(null)).toBe("Cannot reach the gateway.");
    expect(failed(401)).toBe("Your session has ended: reconnect.");
    expect(failed(404)).toBe("This gateway does not read plain-English orders.");
    expect(failed(408)).toBe("The gateway did not answer in 20 s.");
    expect(failed(413)).toBe("That is too long for one order.");
    expect(failed(429, { retryAfterMs: 2000 })).toBe("Too many requests: try again in 2 s.");
    expect(failed(429)).toBe("Too many requests: try again in 1 s.");
    expect(failed(500)).toBe("The gateway could not read that (boom).");
  });

  it("says who read the text and how long it took", () => {
    expect(sourceLine({ source: "rules", latencyMs: 0.3 })).toBe("Read by the built-in rules · 1 ms");
    expect(sourceLine({ source: "llm", model: "qwen2.5:1.5b", latencyMs: 1234 })).toBe("Read by qwen2.5:1.5b on this computer, checked against your words · 1.2 s");
  });
});

describe("the box's request state", () => {
  const reply: ParseOrderReply = { kind: "failed", status: null, message: "x" };

  it("keeps only the current request's reply", () => {
    let s: BoxState = { phase: "idle" };
    s = reduce(s, { type: "start", id: 1, text: "buy 1 tcs", at: 0 });
    s = reduce(s, { type: "start", id: 2, text: "buy 2 tcs", at: 5 });
    // The first request's late reply is dropped.
    expect(reduce(s, { type: "replied", id: 1, reply })).toBe(s);
    s = reduce(s, { type: "replied", id: 2, reply });
    expect(s).toEqual({ phase: "result", id: 2, text: "buy 2 tcs", reply });
    // A reply after the result is shown changes nothing either.
    expect(reduce(s, { type: "replied", id: 2, reply: { ...reply, message: "y" } })).toBe(s);
  });

  it("returns to idle on Stop, and drops the stopped request's reply", () => {
    let s = reduce({ phase: "idle" }, { type: "start", id: 3, text: "slowly", at: 0 });
    s = reduce(s, { type: "stopped" });
    expect(s).toEqual({ phase: "idle" });
    expect(reduce(s, { type: "replied", id: 3, reply })).toEqual({ phase: "idle" });
    expect(reduce({ phase: "result", id: 4, text: "t", reply }, { type: "cleared" })).toEqual({ phase: "idle" });
  });
});
