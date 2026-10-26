import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/index.js";
import { CommandDriver, commandArb } from "./commands.js";
import { ReferenceOrderBook } from "./reference-engine.js";

// FC_RUNS raises the count for deep runs, e.g. FC_RUNS=20000 pnpm test.
const runs = Number(process.env.FC_RUNS ?? 300);

describe("OrderBook vs. naive reference engine", () => {
  it(
    "produces identical events and book state for any sequence of commands",
    () => {
      fc.assert(
        // size "max" spreads lengths over the whole range; the default keeps them near 10.
        fc.property(fc.array(commandArb(), { maxLength: 300, size: "max" }), (commands) => {
          const fast = new OrderBook();
          const reference = new ReferenceOrderBook();
          const driver = new CommandDriver();
          for (const command of commands) {
            const [fastEvents, referenceEvents] = driver.apply([fast, reference], command);
            expect(fastEvents).toEqual(referenceEvents);
            expect(fast.depth(Number.MAX_SAFE_INTEGER)).toEqual(reference.depth(Number.MAX_SAFE_INTEGER));
            expect(fast.bestBid()).toBe(reference.bestBid());
            expect(fast.bestAsk()).toBe(reference.bestAsk());
            expect(fast.lastTradePrice()).toBe(reference.lastTradePrice());
            expect(fast.pendingStopCount).toBe(reference.pendingStopCount);
            expect(fast.phase).toBe(reference.phase);
            // The fast sweep must agree with brute force over every price.
            expect(fast.indicativeAuction()).toEqual(reference.indicativeAuction());
          }
        }),
        { numRuns: runs },
      );
    },
    Math.max(10_000, runs * 50),
  );
});
