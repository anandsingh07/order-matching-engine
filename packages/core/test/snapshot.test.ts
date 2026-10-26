import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CommandStream, OrderBook } from "../src/index.js";
import type { BookSnapshot } from "../src/types.js";
import { CommandDriver, commandArb } from "./commands.js";

const roundTrip = (snapshot: BookSnapshot): BookSnapshot => JSON.parse(JSON.stringify(snapshot)) as BookSnapshot;

describe("snapshots", () => {
  it("a restored book behaves exactly like the original from then on", () => {
    fc.assert(
      fc.property(
        fc.array(commandArb(), { maxLength: 200, size: "max" }),
        fc.array(commandArb(), { maxLength: 200, size: "max" }),
        (before, after) => {
          const original = new OrderBook();
          const driver = new CommandDriver();
          for (const command of before) driver.apply([original], command);

          const restored = OrderBook.fromSnapshot(roundTrip(original.snapshot()));
          expect(restored.snapshot()).toEqual(original.snapshot());

          for (const command of after) {
            const [a, b] = driver.apply([original, restored], command);
            expect(b).toEqual(a);
          }
          expect(restored.snapshot()).toEqual(original.snapshot());
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps queue order, iceberg reserves and pending stops", () => {
    const book = new OrderBook();
    const stream = new CommandStream(1);
    for (let i = 0; i < 5_000; i++) book.apply(stream.next());
    const snapshot = book.snapshot();
    expect(snapshot.stops.length).toBeGreaterThan(0);
    expect([...snapshot.bids, ...snapshot.asks].some((o) => o.hidden > 0)).toBe(true);
    expect(OrderBook.fromSnapshot(roundTrip(snapshot)).snapshot()).toEqual(snapshot);
  });

  it("rejects an unknown snapshot version", () => {
    const snapshot = { ...new OrderBook().snapshot(), version: 2 } as unknown as BookSnapshot;
    expect(() => OrderBook.fromSnapshot(snapshot)).toThrow(/version/);
  });
});
