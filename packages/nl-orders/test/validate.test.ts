import { formatPrice, formatQuantity, type ClientOrder } from "@ome/client";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toProposal, type MarketInstrument, type OrderFields, type Proposal } from "../src/index.ts";

const instruments = JSON.parse(readFileSync(new URL("./fixtures/instruments.json", import.meta.url), "utf8")) as MarketInstrument[];
const fields = (f: Partial<OrderFields>): OrderFields => ({
  intent: "order", side: "buy", symbol: "TCS", orderType: null, quantity: "10", price: null, stopPrice: null, timeInForce: null, displayQuantity: null, explanation: "", ...f,
});
const propose = (f: Partial<OrderFields>) => toProposal(fields(f), instruments);
const orderOf = (p: Proposal) => {
  if (p.kind !== "order") throw new Error(`expected an order, got ${JSON.stringify(p)}`);
  return p;
};
const problemsOf = (p: Proposal) => (p.kind === "unclear" ? p.problems.map((x) => x.field) : []);

describe("normalising to the wire format", () => {
  it("converts display units to integer ticks and units on each instrument's scale", () => {
    expect(orderOf(propose({ price: "4100.50" })).order).toEqual({ type: "limit", side: "buy", price: 410050, quantity: 10, timeInForce: "GTC" });
    expect(orderOf(propose({ symbol: "BTCUSDT", quantity: "0.05", side: "sell", orderType: "market" })).order).toEqual({ type: "market", side: "sell", quantity: 5000 });
  });

  it("infers the order type from the prices given", () => {
    expect(orderOf(propose({ price: "4100" })).order.type).toBe("limit");
    expect(orderOf(propose({ side: "sell", stopPrice: "4000" })).order).toEqual({ type: "stop", side: "sell", quantity: 10, stopPrice: 400000 });
    expect(orderOf(propose({ side: "sell", stopPrice: "4000", price: "3990" })).order).toEqual({
      type: "stop", side: "sell", quantity: 10, stopPrice: 400000, limitPrice: 399000, timeInForce: "GTC",
    });
    // A "stop" with a limit price, or a "limit" with a trigger, is a stop-limit.
    expect(orderOf(propose({ side: "sell", orderType: "stop", stopPrice: "4000", price: "3990" })).order).toHaveProperty("limitPrice", 399000);
    expect(orderOf(propose({ side: "sell", orderType: "limit", stopPrice: "4000", price: "3990" })).order).toHaveProperty("limitPrice", 399000);
  });

  it("makes no price a market order, and says so", () => {
    const p = orderOf(propose({}));
    expect(p.order).toEqual({ type: "market", side: "buy", quantity: 10 });
    expect(p.summary).toBe("Buy 10 TCS at market");
    expect(p.warnings.join(" ")).toMatch(/market order/);
  });

  it("checks tick and lot sizes instead of rounding", () => {
    expect(problemsOf(propose({ price: "4100.03" }))).toEqual(["price"]);
    expect(problemsOf(propose({ quantity: "2.5" }))).toEqual(["quantity"]);
    expect(problemsOf(propose({ symbol: "BTCUSDT", quantity: "0.000001" }))).toEqual(["quantity"]);
    expect(problemsOf(propose({ quantity: "-5" }))).toEqual(["quantity"]);
    expect(problemsOf(propose({ quantity: "0" }))).toEqual(["quantity"]);
    const p = propose({ price: "4100.03" });
    expect(p.summary).toContain("multiple of 0.05");
  });

  it("names every missing field", () => {
    expect(problemsOf(propose({ side: null, symbol: null, quantity: null }))).toEqual(["side", "symbol", "quantity"]);
    expect(problemsOf(propose({ orderType: "limit" }))).toEqual(["price"]);
    expect(problemsOf(propose({ orderType: "stop" }))).toEqual(["stopPrice"]);
    expect(problemsOf(propose({ orderType: "stop_limit", stopPrice: "4200" }))).toEqual(["price"]);
    expect(problemsOf(propose({ orderType: "market", price: "4100" }))).toEqual(["price"]);
  });

  it("refuses instruments that are not listed, whatever the parser said", () => {
    expect(problemsOf(propose({ symbol: "AAPL" }))).toEqual(["symbol"]);
    expect(problemsOf(toProposal({ ...fields({}), intent: "cancel", symbol: "AAPL" }, instruments))).toEqual(["symbol"]);
  });

  it("applies the ticket's iceberg rules", () => {
    expect(orderOf(propose({ price: "4100", quantity: "100", displayQuantity: "10" })).order).toHaveProperty("displayQuantity", 10);
    expect(problemsOf(propose({ price: "4100", quantity: "100", displayQuantity: "10", timeInForce: "IOC" }))).toEqual(["displayQuantity"]);
    expect(problemsOf(propose({ quantity: "100", displayQuantity: "10" }))).toEqual(["displayQuantity"]); // market
    const whole = orderOf(propose({ price: "4100", quantity: "10", displayQuantity: "10" }));
    expect(whole.order).not.toHaveProperty("displayQuantity");
    expect(whole.warnings.join(" ")).toMatch(/whole order shows/);
  });

  it("drops GTC from a market order with a warning; keeps IOC and FOK", () => {
    const gtc = orderOf(propose({ orderType: "market", timeInForce: "GTC" }));
    expect(gtc.order).toEqual({ type: "market", side: "buy", quantity: 10 });
    expect(gtc.warnings.join(" ")).toMatch(/good-till-cancelled/);
    expect(orderOf(propose({ orderType: "market", timeInForce: "FOK" })).order).toHaveProperty("timeInForce", "FOK");
  });

  it("warns about prices far from the market", () => {
    expect(orderOf(propose({ price: "41" })).warnings.join(" ")).toMatch(/99% below the current 4100.00/);
    expect(orderOf(propose({ side: "sell", stopPrice: "4000" })).warnings).toEqual([]);
  });

  it("refuses a stop that would trigger at once, and names the bracket it usually is", () => {
    // "buy 100 tcs at 4100 sl 4000": an entry and its stop loss, two orders.
    const bracket = propose({ side: "buy", price: "4100", stopPrice: "4000" });
    expect(problemsOf(bracket)).toEqual(["stopPrice"]);
    expect(bracket.summary).toContain("a buy stop must be above the current 4100.00, or it triggers at once; if it is a stop loss for this buy, that is a second order");
    expect(problemsOf(propose({ side: "buy", stopPrice: "4100" }))).toEqual(["stopPrice"]); // at the market is not above it
    expect(problemsOf(propose({ side: "sell", stopPrice: "4200" }))).toEqual(["stopPrice"]);
    expect(orderOf(propose({ side: "buy", stopPrice: "4200", price: "4210" })).order).toMatchObject({ stopPrice: 420_000, limitPrice: 421_000 });
    // The caller's live price is used when it has one.
    const moved = instruments.map((i) => (i.symbol === "TCS" ? { ...i, lastPrice: 380_000 } : i));
    expect(problemsOf(toProposal(fields({ side: "sell", stopPrice: "4000" }), moved))).toEqual(["stopPrice"]);
    expect(orderOf(toProposal(fields({ side: "buy", stopPrice: "4000" }), moved)).order.type).toBe("stop");
  });

  it("passes unclear and cancel intents through", () => {
    expect(toProposal({ ...fields({}), intent: "unclear", explanation: "two orders" }, instruments)).toEqual({
      kind: "unclear", problems: [{ field: "text", message: "two orders" }], summary: "two orders",
    });
    expect(toProposal({ ...fields({ side: null }), intent: "cancel" }, instruments)).toEqual({ kind: "cancel", symbol: "TCS", side: null, summary: "Cancel your open TCS orders" });
    expect(toProposal({ ...fields({ symbol: null, side: "sell" }), intent: "cancel" }, instruments)).toMatchObject({ kind: "cancel", symbol: null, side: "sell", summary: "Cancel all your open sell orders" });
  });

  it("any valid order, written out in display units, comes back as exactly the same wire order", () => {
    const arbitraryOrder = fc
      .record({
        instrument: fc.constantFrom(...instruments),
        side: fc.constantFrom("buy" as const, "sell" as const),
        kind: fc.constantFrom("limit", "market", "stop", "stop_limit"),
        lots: fc.integer({ min: 1, max: 1_000_000 }),
        ticks: fc.integer({ min: 1, max: 2_000_000 }),
        stopTicks: fc.integer({ min: 1, max: 2_000_000 }),
        tif: fc.constantFrom("GTC" as const, "IOC" as const, "FOK" as const, undefined),
        displayLots: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
      })
      .map(({ instrument, side, kind, lots, ticks, stopTicks, tif, displayLots }) => {
        const quantity = lots * instrument.lotSize;
        const price = ticks * instrument.tickSize;
        const stopPrice = stopTicks * instrument.tickSize;
        let order: ClientOrder;
        if (kind === "market") order = tif === "GTC" || tif === undefined ? { type: "market", side, quantity } : { type: "market", side, quantity, timeInForce: tif };
        else if (kind === "limit") {
          order = { type: "limit", side, price, quantity, timeInForce: tif ?? "GTC" };
          const display = displayLots === undefined ? undefined : displayLots * instrument.lotSize;
          if (display !== undefined && display < quantity && order.timeInForce === "GTC") order.displayQuantity = display;
        } else if (kind === "stop") order = tif === undefined ? { type: "stop", side, quantity, stopPrice } : { type: "stop", side, quantity, stopPrice, timeInForce: tif };
        else order = { type: "stop", side, quantity, stopPrice, limitPrice: price, timeInForce: tif ?? "GTC" };
        return { instrument, order };
      })
      // Stops on the side of the market that would trigger at once are refused (tested above).
      .filter(({ instrument, order }) => order.type !== "stop" || (order.side === "buy" ? order.stopPrice > instrument.lastPrice! : order.stopPrice < instrument.lastPrice!));
    fc.assert(
      fc.property(arbitraryOrder, ({ instrument, order }) => {
        const f = fields({
          symbol: instrument.symbol,
          side: order.side,
          quantity: formatQuantity(instrument, order.quantity),
          orderType: order.type === "stop" ? (order.limitPrice === undefined ? "stop" : "stop_limit") : order.type,
          price: order.type === "limit" ? formatPrice(instrument, order.price) : order.type === "stop" && order.limitPrice !== undefined ? formatPrice(instrument, order.limitPrice) : null,
          stopPrice: order.type === "stop" ? formatPrice(instrument, order.stopPrice) : null,
          timeInForce: order.timeInForce ?? null,
          displayQuantity: order.type === "limit" && order.displayQuantity !== undefined ? formatQuantity(instrument, order.displayQuantity) : null,
        });
        const p = toProposal(f, instruments);
        expect(p.kind).toBe("order");
        if (p.kind === "order") expect(p.order).toEqual(order);
      }),
    );
  });
});
