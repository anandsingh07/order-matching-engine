import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/index.js";
import type { EngineEvent } from "../src/types.js";
import { CommandDriver, commandArb } from "./commands.js";

const run = (amends: boolean, check: (book: OrderBook, events: EngineEvent[], driver: CommandDriver) => void) =>
  fc.assert(
    fc.property(fc.array(commandArb({ amends }), { maxLength: 300, size: "max" }), (commands) => {
      const book = new OrderBook();
      const driver = new CommandDriver();
      for (const command of commands) {
        const [events] = driver.apply([book], command);
        check(book, events!, driver);
      }
    }),
    { numRuns: 200 },
  );

describe("OrderBook invariants", () => {
  it("never leaves the book crossed while trading continuously", () => {
    // During an auction the book may cross on purpose; the uncross must clear it.
    run(true, (book) => {
      const bid = book.bestBid();
      const ask = book.bestAsk();
      if (book.phase === "continuous" && bid !== null && ask !== null) expect(bid).toBeLessThan(ask);
    });
  });

  it("uncrosses at one price, inside every trader's limit, for the announced volume", () => {
    run(true, (book, events) => {
      const phase = events.find((e) => e.type === "phase" && e.phase === "continuous");
      if (phase?.type !== "phase") return;
      // Trades before the phase event belong to the uncross; after it, stops may trade.
      const auctionTrades = events.slice(0, events.indexOf(phase)).filter((e) => e.type === "trade");
      expect(auctionTrades.reduce((sum, t) => sum + t.quantity, 0)).toBe(phase.volume);
      for (const t of auctionTrades) expect(t.price).toBe(phase.price);
      if (phase.volume === 0) expect(phase.price).toBeNull();
    });
  });

  it("depth totals always match the resting orders", () => {
    run(true, (book) => {
      const { bids, asks } = book.depth(Number.MAX_SAFE_INTEGER);
      const orders = [...bids, ...asks].reduce((sum, level) => sum + level.orders, 0);
      expect(orders).toBe(book.restingOrderCount);
      for (const level of [...bids, ...asks]) expect(level.quantity).toBeGreaterThan(0);
    });
  });

  it("never creates or loses quantity", () => {
    // Without amends, every accepted order's quantity must end up exactly
    // traded, cancelled, still resting, or still waiting as a stop. An id can
    // be reused once its order has left the book, so each reuse starts a
    // fresh tally.
    fc.assert(
      fc.property(fc.array(commandArb({ amends: false }), { maxLength: 300, size: "max" }), (commands) => {
        const book = new OrderBook();
        const driver = new CommandDriver();
        const accepted = new Map<string, number>();
        const settled = new Map<string, number>();
        const add = (id: string, qty: number) => settled.set(id, (settled.get(id) ?? 0) + qty);

        for (const command of commands) {
          const quantity = command.kind === "limit" || command.kind === "market" || command.kind === "stop" ? command.quantity : 0;
          const [events] = driver.apply([book], command);
          for (const e of events!) {
            if (e.type === "accepted") {
              const previous = accepted.get(e.orderId);
              if (previous !== undefined) expect(settled.get(e.orderId) ?? 0).toBe(previous);
              accepted.set(e.orderId, quantity);
              settled.set(e.orderId, 0);
            }
            if (e.type === "trade") {
              add(e.makerOrderId, e.quantity);
              add(e.takerOrderId, e.quantity);
            }
            if (e.type === "cancelled") add(e.orderId, e.remaining);
          }
        }
        for (const [id, quantity] of accepted) {
          const open = (book.getOrder(id)?.remaining ?? 0) + (book.getStopOrder(id)?.quantity ?? 0);
          expect((settled.get(id) ?? 0) + open).toBe(quantity);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("only trades within each order's limit price", () => {
    fc.assert(
      fc.property(fc.array(commandArb({ amends: false }), { maxLength: 300, size: "max" }), (commands) => {
        const book = new OrderBook();
        const driver = new CommandDriver();
        const limits = new Map<string, { side: "buy" | "sell"; price: number }>();
        for (const command of commands) {
          const [events] = driver.apply([book], command);
          if (command.kind === "limit") {
            // The command's own order is the one its first event accepts. (Not the
            // newest id: a reused id plus a triggered stop would mix up the two.)
            const first = events![0];
            if (first?.type !== "accepted") continue;
            limits.set(first.orderId, { side: command.side, price: command.price });
          }
          // Every trade, continuous or auction, respects both orders' limit prices.
          for (const e of events!) {
            if (e.type !== "trade") continue;
            for (const id of [e.takerOrderId, e.makerOrderId]) {
              const own = limits.get(id);
              if (own === undefined) continue;
              if (own.side === "buy") expect(e.price).toBeLessThanOrEqual(own.price);
              else expect(e.price).toBeGreaterThanOrEqual(own.price);
            }
          }
          for (const e of events!) if (e.type === "cancelled") limits.delete(e.orderId);
        }
      }),
      { numRuns: 200 },
    );
  });
});
