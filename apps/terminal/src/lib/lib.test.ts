import type { ExecutionMessage, Instrument } from "@ome/client";
import { describe, expect, it } from "vitest";
import { ladder } from "./depth";
import { buildOrder, phaseRefusal, type OrderForm } from "./order-form";
import { applyExecution, averageFillPrice, newOrder, type MyOrder } from "./orders";
import { applyFill, FLAT, unrealized } from "./positions";

const TCS: Instrument = { symbol: "TCS", name: "TCS", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 410_000 };
const BTC: Instrument = { symbol: "BTCUSDT", name: "BTC", currency: "USDT", priceScale: 100, quantityScale: 100_000, tickSize: 1, lotSize: 1, referencePrice: 8_000_000 };

const form = (over: Partial<OrderForm>): OrderForm => ({
  kind: "limit",
  side: "buy",
  price: "4100.00",
  stopPrice: "",
  quantity: "10",
  timeInForce: "GTC",
  display: "",
  ...over,
});

describe("positions (average cost)", () => {
  it("blends the average price when adding, realizes P&L when reducing", () => {
    let p = applyFill(FLAT, "buy", 100, 10);
    p = applyFill(p, "buy", 110, 10);
    expect(p).toEqual({ quantity: 20, averagePrice: 105, realized: 0 });
    p = applyFill(p, "sell", 120, 5);
    expect(p).toEqual({ quantity: 15, averagePrice: 105, realized: 75 });
    expect(unrealized(p, 100)).toBe(-75);
  });

  it("flips through flat at the fill price", () => {
    let p = applyFill(FLAT, "sell", 200, 4); // short 4 @ 200
    p = applyFill(p, "buy", 190, 10); // close 4 (+40), go long 6 @ 190
    expect(p).toEqual({ quantity: 6, averagePrice: 190, realized: 40 });
    p = applyFill(p, "sell", 195, 6);
    expect(p).toEqual({ quantity: 0, averagePrice: 0, realized: 70 });
    expect(unrealized(p, 1_000)).toBe(0);
  });
});

describe("order lifecycle from execution reports", () => {
  const exec = (m: Partial<ExecutionMessage> & { event: ExecutionMessage["event"] }) =>
    ({ type: "execution", symbol: "TCS", clientOrderId: "a1", time: 1, ...m }) as ExecutionMessage;

  it("tracks a limit order that partly fills, rests, then fills", () => {
    let o: MyOrder = newOrder("TCS", "a1", { type: "limit", side: "buy", price: 100, quantity: 10 }, 0);
    for (const m of [
      exec({ event: "accepted" }),
      exec({ event: "fill", side: "buy", price: 99, quantity: 4, liquidity: "taker" }),
      exec({ event: "rested", side: "buy", price: 100, quantity: 6, visible: 6 }),
    ]) o = applyExecution(o, m);
    expect(o).toMatchObject({ status: "partially_filled", filled: 4, remaining: 6 });
    o = applyExecution(o, exec({ event: "fill", side: "buy", price: 100, quantity: 6, liquidity: "maker" }));
    expect(o).toMatchObject({ status: "filled", filled: 10, remaining: 0 });
    expect(averageFillPrice(o)).toBe(99.6);
  });

  it("marks an IOC remainder as cancelled with the engine's reason", () => {
    let o = newOrder("TCS", "a1", { type: "limit", side: "sell", price: 100, quantity: 10, timeInForce: "IOC" }, 0);
    o = applyExecution(o, exec({ event: "fill", side: "sell", price: 100, quantity: 3, liquidity: "taker" }));
    o = applyExecution(o, exec({ event: "cancelled", remaining: 7, reason: "unfilled_remainder" }));
    expect(o).toMatchObject({ status: "cancelled", filled: 3, remaining: 0, reason: "unfilled_remainder" });
  });

  it("handles stops, amends, and reports for orders placed elsewhere", () => {
    let o = newOrder("TCS", "a1", { type: "stop", side: "sell", quantity: 5, stopPrice: 95 }, 0);
    o = applyExecution(o, exec({ event: "stop_pending", side: "sell", stopPrice: 95, quantity: 5 }));
    expect(o.status).toBe("stop_pending");
    o = applyExecution(o, exec({ event: "triggered", lastPrice: 95 }));
    expect(o.status).toBe("accepted");

    let r = newOrder("TCS", "a1", { type: "limit", side: "buy", price: 100, quantity: 10 }, 0);
    r = applyExecution(r, exec({ event: "rested", side: "buy", price: 100, quantity: 10, visible: 10 }));
    r = applyExecution(r, exec({ event: "amended", price: 105, quantity: 4, keptPriority: false }));
    expect(r).toMatchObject({ price: 105, remaining: 4, quantity: 4, status: "open" });

    const unknown = applyExecution(undefined, exec({ event: "rested", side: "sell", price: 120, quantity: 8, visible: 8 }));
    expect(unknown).toMatchObject({ side: "sell", price: 120, quantity: 8, remaining: 8, status: "open" });
  });
});

describe("order book ladder", () => {
  it("accumulates totals from the touch and scales bars on one axis", () => {
    const l = ladder(
      [
        { price: 99, quantity: 5, orders: 1 },
        { price: 98, quantity: 15, orders: 2 },
      ],
      [{ price: 101, quantity: 10, orders: 1 }],
      10,
    );
    expect(l.bids.map((r) => [r.total, r.share])).toEqual([
      [5, 0.25],
      [20, 1],
    ]);
    expect(l.asks.map((r) => [r.total, r.share])).toEqual([[10, 0.5]]);
    expect(l).toMatchObject({ spread: 2, mid: 100 });
    expect(ladder([], [], 5)).toMatchObject({ spread: null, mid: null });
  });
});

describe("order form", () => {
  it("converts typed decimals to exact integer ticks", () => {
    expect(buildOrder(TCS, form({ price: "4100.05" }))).toEqual({
      ok: true,
      order: { type: "limit", side: "buy", price: 410_005, quantity: 10, timeInForce: "GTC" },
    });
    expect(buildOrder(BTC, form({ price: "80605.82", quantity: "0.0125" }))).toMatchObject({
      ok: true,
      order: { price: 8_060_582, quantity: 1_250 },
    });
  });

  it("explains what is wrong before anything is sent", () => {
    expect(buildOrder(TCS, form({ quantity: "" }))).toEqual({ ok: false, error: "Enter a quantity" });
    // Never silently drop digits the user typed.
    expect(buildOrder(TCS, form({ quantity: "2.5" }))).toEqual({ ok: false, error: "Quantity must be a whole number" });
    expect(buildOrder(TCS, form({ price: "4100.003" }))).toEqual({ ok: false, error: "Price can have at most 2 decimal places" });
    expect(buildOrder(TCS, form({ price: "4100.0500", quantity: "10.000" }))).toMatchObject({ ok: true, order: { price: 410_005, quantity: 10 } });
    expect(buildOrder(TCS, form({ price: "4100.03" }))).toEqual({ ok: false, error: "Price must be a multiple of 0.05" });
    expect(buildOrder(TCS, form({ price: "abc" }))).toEqual({ ok: false, error: "Price must be a positive number" });
    expect(buildOrder(TCS, form({ kind: "stop", stopPrice: "" }))).toEqual({ ok: false, error: "Enter a stop price" });
    expect(buildOrder(TCS, form({ display: "5", timeInForce: "IOC" }))).toEqual({ ok: false, error: "Iceberg orders must be GTC" });
  });

  it("builds market, stop, stop-limit and iceberg orders", () => {
    expect(buildOrder(TCS, form({ kind: "market", price: "" }))).toEqual({ ok: true, order: { type: "market", side: "buy", quantity: 10 } });
    expect(buildOrder(TCS, form({ kind: "stop", stopPrice: "4200", price: "" }))).toEqual({
      ok: true,
      order: { type: "stop", side: "buy", quantity: 10, stopPrice: 420_000 },
    });
    expect(buildOrder(TCS, form({ kind: "stop", stopPrice: "4200", price: "4205" }))).toMatchObject({
      ok: true,
      order: { stopPrice: 420_000, limitPrice: 420_500 },
    });
    expect(buildOrder(TCS, form({ display: "2" }))).toMatchObject({ ok: true, order: { displayQuantity: 2 } });
    // A display size at or above the full size is just a normal order.
    expect(buildOrder(TCS, form({ display: "10" }))).not.toMatchObject({ order: { displayQuantity: 10 } });
  });
});

describe("order refusals in an auction", () => {
  const continuous = { auction: false, underlyingInAuction: null };
  const auction = { auction: true, underlyingInAuction: null };

  it("refuses market and non-GTC limit orders only while the symbol is in an auction", () => {
    const refusal = "During an auction only GTC limit and stop orders are accepted";
    expect(phaseRefusal(form({ kind: "market" }), auction)).toBe(refusal);
    expect(phaseRefusal(form({ timeInForce: "IOC" }), auction)).toBe(refusal);
    expect(phaseRefusal(form({}), auction)).toBeNull();
    expect(phaseRefusal(form({ kind: "stop", timeInForce: "IOC" }), auction)).toBeNull();
    // The ticket works the message out again on every render: when the symbol reopens it goes.
    expect(phaseRefusal(form({ kind: "market" }), continuous)).toBeNull();
    expect(phaseRefusal(form({ timeInForce: "FOK" }), continuous)).toBeNull();
  });

  it("refuses any futures or options order while the underlying is in an auction", () => {
    expect(phaseRefusal(form({}), { auction: false, underlyingInAuction: "TCS" })).toBe("TCS is in an auction; its futures and options trade again when it reopens");
    expect(phaseRefusal(form({}), continuous)).toBeNull();
  });
});
