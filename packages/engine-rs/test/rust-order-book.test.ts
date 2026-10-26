import { CommandStream, OrderBook, type BookSnapshot, type EngineEvent } from "@ome/core";
import { describe, expect, it } from "vitest";
import { RustOrderBook } from "../src/index.js";

// Compile-time: RustOrderBook has every public member of OrderBook with a
// compatible type, so it can replace it anywhere (`pnpm typecheck` fails if not).
type PublicOrderBook = Pick<OrderBook, keyof OrderBook>;
const asCore: PublicOrderBook = new RustOrderBook();
const restore: (snapshot: BookSnapshot) => PublicOrderBook = RustOrderBook.fromSnapshot;
void asCore;
void restore;

const roundTrip = (snapshot: BookSnapshot): BookSnapshot => JSON.parse(JSON.stringify(snapshot)) as BookSnapshot;

describe("RustOrderBook", () => {
  it("restores the TypeScript engine's snapshots, and the TypeScript engine restores its", () => {
    const ts = new OrderBook();
    const rust = new RustOrderBook();
    const stream = new CommandStream(3);
    for (let i = 0; i < 30_000; i++) {
      const command = stream.next();
      ts.apply(command);
      rust.apply(command);
    }
    const snapshot = ts.snapshot();
    // A deep book with icebergs and pending stops, so the restore has something to get wrong.
    expect(snapshot.stops.length).toBeGreaterThan(0);
    expect([...snapshot.bids, ...snapshot.asks].some((o) => o.hidden > 0)).toBe(true);
    expect(JSON.stringify(rust.snapshot())).toBe(JSON.stringify(snapshot));

    // Cross over: the Rust engine continues from the TypeScript snapshot and
    // vice versa, and all four books must stay identical.
    const rustFromTs = RustOrderBook.fromSnapshot(roundTrip(snapshot));
    const tsFromRust = OrderBook.fromSnapshot(roundTrip(rust.snapshot()));
    expect(rustFromTs.snapshot()).toEqual(snapshot);
    for (let i = 0; i < 30_000; i++) {
      const command = stream.next();
      const expected = ts.apply(command);
      expect(rust.apply(command)).toEqual(expected);
      expect(rustFromTs.apply(command)).toEqual(expected);
      expect(tsFromRust.apply(command)).toEqual(expected);
    }
    expect(rustFromTs.snapshot()).toEqual(ts.snapshot());
    expect(tsFromRust.snapshot()).toEqual(ts.snapshot());
  }, 30_000);

  it("restores a FOK stop whose trader has no resting order, and fires it", () => {
    // Found by the core snapshot property run against this engine: restoring
    // a stop did not register its trader, so when the stop triggered, the
    // FOK liquidity check read past the end of an array and wasm trapped.
    const ts = new OrderBook();
    ts.submit({ type: "stop", id: "st", traderId: "t2", side: "buy", stopPrice: 95, quantity: 1, timeInForce: "FOK" });
    ts.submit({ type: "limit", id: "s1", traderId: "t1", side: "sell", price: 95, quantity: 2 });
    const rust = RustOrderBook.fromSnapshot(roundTrip(ts.snapshot()));
    const buy = { type: "limit", id: "b1", traderId: "t1", side: "buy", price: 95, quantity: 1 } as const;
    const expected = ts.submit(buy);
    expect(expected.map((e) => e.type)).toEqual(["accepted", "trade", "triggered", "trade"]);
    expect(rust.submit(buy)).toEqual(expected);
  });

  it("restores a snapshot taken mid-auction", () => {
    const ts = new OrderBook();
    ts.startAuction();
    ts.submit({ type: "limit", id: "b1", traderId: "t1", side: "buy", price: 101, quantity: 5 });
    ts.submit({ type: "limit", id: "a1", traderId: "t2", side: "sell", price: 99, quantity: 5 });
    const rust = RustOrderBook.fromSnapshot(roundTrip(ts.snapshot()));
    expect(rust.phase).toBe("auction");
    expect(rust.indicativeAuction()).toEqual(ts.indicativeAuction());
    expect(rust.uncross()).toEqual(ts.uncross());
  });

  it("rejects an unknown snapshot version", () => {
    const snapshot = { ...new RustOrderBook().snapshot(), version: 2 } as unknown as BookSnapshot;
    expect(() => RustOrderBook.fromSnapshot(snapshot)).toThrow(/version/);
  });

  it("recycles order handles, so ids do not accumulate", () => {
    // Remembering every id ever seen would be the unbounded memory the
    // TypeScript engine removed. The handle table must stay at the peak
    // number of live orders, not grow with the number of commands.
    const rust = new RustOrderBook();
    const stream = new CommandStream(11);
    let peakLive = 0;
    for (let i = 0; i < 100_000; i++) {
      rust.apply(stream.next());
      const { live } = rust.idStats;
      expect(live).toBe(rust.restingOrderCount + rust.pendingStopCount);
      peakLive = Math.max(peakLive, live);
    }
    // One extra slot: the id of the command in flight before it is known to be live.
    expect(rust.idStats.slots).toBeLessThanOrEqual(peakLive + 1);
    expect(rust.idStats.slots).toBeLessThan(20_000);
  }, 30_000);

  it("matches the TypeScript engine when one order sweeps a deep book (wasm memory grows mid-command)", () => {
    // 150,000 resting orders, then one market order that takes them all:
    // 150,000 trades from a single call, far beyond the initial output
    // buffer and memory, so the wrapper must re-read the moved buffer.
    // (Compared as JSON: toEqual on 150,000 events takes far longer than both engines.)
    const ts = new OrderBook();
    const rust = new RustOrderBook();
    const tsRested: EngineEvent[] = [];
    const rustRested: EngineEvent[] = [];
    for (let i = 0; i < 150_000; i++) {
      const order = { type: "limit", id: `s${i}`, traderId: `t${i % 97}`, side: "sell", price: 1_000 + (i % 500), quantity: 1 + (i % 7) } as const;
      tsRested.push(...ts.submit(order));
      rustRested.push(...rust.submit(order));
    }
    expect(JSON.stringify(rustRested)).toBe(JSON.stringify(tsRested));
    const sweep = { type: "market", id: "sweep", traderId: "whale", side: "buy", quantity: 10_000_000 } as const;
    const expected = ts.submit(sweep);
    const actual = rust.submit(sweep);
    expect(actual.filter((e) => e.type === "trade")).toHaveLength(150_000);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(actual.at(-1)).toEqual(expected.at(-1));
    expect(rust.restingOrderCount).toBe(0);
    expect(rust.idStats).toEqual({ live: 0, slots: 150_001 });
  }, 30_000);

  it("keeps separate books separate", () => {
    const a = new RustOrderBook();
    const b = new RustOrderBook();
    a.submit({ type: "limit", id: "x", traderId: "t", side: "buy", price: 100, quantity: 5 });
    expect(a.bestBid()).toBe(100);
    expect(b.bestBid()).toBeNull();
    // The same id is free in the other book.
    expect(b.submit({ type: "limit", id: "x", traderId: "t", side: "sell", price: 101, quantity: 5 })[1]).toMatchObject({ type: "rested" });
    expect(a.depth()).toEqual({ bids: [{ price: 100, quantity: 5, orders: 1 }], asks: [] });
  });

  it("answers order lookups like the TypeScript engine", () => {
    const ts = new OrderBook();
    const rust = new RustOrderBook();
    for (const book of [ts, rust]) {
      book.submit({ type: "limit", id: "ice", traderId: "t1", side: "sell", price: 105, quantity: 40, displayQuantity: 10 });
      book.submit({ type: "stop", id: "st", traderId: "t2", side: "buy", stopPrice: 110, limitPrice: 112, quantity: 3 });
    }
    expect(rust.getOrder("ice")).toEqual(ts.getOrder("ice"));
    expect(rust.getOrder("ice")).toEqual({ id: "ice", traderId: "t1", side: "sell", price: 105, remaining: 40, visible: 10 });
    expect(rust.getStopOrder("st")).toEqual(ts.getStopOrder("st"));
    expect(rust.getOrder("st")).toBeUndefined();
    expect(rust.getStopOrder("ice")).toBeUndefined();
    expect(rust.getOrder("missing")).toBeUndefined();
    expect(rust.depth(0)).toEqual(ts.depth(0));
  });

  it("refuses enum strings outside the TypeScript types instead of guessing", () => {
    // The TypeScript engine has no defined behaviour to copy here (it echoes
    // "SELL" in its events, and an unknown self-trade policy makes it loop
    // forever at the trader's own order), so a silent mapping would let the
    // engines drift apart unnoticed.
    const rust = new RustOrderBook();
    rust.submit({ type: "limit", id: "m", traderId: "t", side: "sell", price: 100, quantity: 5 });
    const order = { type: "limit", id: "k", traderId: "t", side: "buy", price: 100, quantity: 5 } as const;
    expect(() => rust.submit({ ...order, side: "SELL" as never })).toThrow(/Invalid side "SELL"/);
    expect(() => rust.submit({ ...order, timeInForce: "DAY" as never })).toThrow(/Invalid timeInForce "DAY"/);
    expect(() => rust.submit({ ...order, selfTrade: "bogus" as never })).toThrow(/Invalid selfTrade "bogus"/);
    const snapshot = rust.snapshot();
    expect(() => RustOrderBook.fromSnapshot({ ...snapshot, asks: [{ ...snapshot.asks[0]!, side: "Sell" as never }] })).toThrow(/Invalid side/);
    // Nothing was half-applied: no event, no sequence number, no interned id.
    expect(rust.snapshot()).toEqual(snapshot);
    expect(rust.idStats.live).toBe(1);
    // Absent fields still take the defaults, as in the TypeScript engine.
    const ts = new OrderBook();
    ts.submit({ type: "limit", id: "m", traderId: "t", side: "sell", price: 100, quantity: 5 });
    expect(rust.submit({ ...order, timeInForce: undefined, selfTrade: undefined })).toEqual(ts.submit({ ...order, timeInForce: undefined, selfTrade: undefined }));
  });

  // The order of f64 additions matters past 2^53, and the auction is where
  // it shows: an iceberg level's size is visible + hidden, summed first and
  // then added to the running supply or demand, exactly as order-book.ts
  // does. (FOK sums cannot show it: they stop as soon as they reach the
  // order's quantity, and any sum that rounds is already past 2^53, above
  // every valid quantity, so the decision is the same either way.) The
  // fast-check property near 2^53 found a planted reordering only after 85
  // of its runs; these two books catch it every time, one per side.
  it("sums auction supply and demand in the TypeScript engine's order past 2^53", () => {
    const big = 2 ** 53 - 1;
    // A level of visible 3 and hidden 2^53 - 2: its size 2^53 + 1 rounds to 2^53.
    const icebergLevel = (book: OrderBook | RustOrderBook, side: "buy" | "sell", price: number) => {
      book.submit({ type: "limit", id: `${side}-ice`, traderId: "t1", side, price, quantity: big, displayQuantity: 1 });
      book.submit({ type: "limit", id: `${side}-two`, traderId: "t1", side, price, quantity: 2 });
    };
    const supplySide = (book: OrderBook | RustOrderBook) => {
      book.startAuction();
      book.submit({ type: "limit", id: "a1", traderId: "t1", side: "sell", price: 100, quantity: 1 });
      icebergLevel(book, "sell", 101);
      book.submit({ type: "limit", id: "b1", traderId: "t2", side: "buy", price: 101, quantity: big });
      book.submit({ type: "limit", id: "b2", traderId: "t2", side: "buy", price: 101, quantity: big });
      return book;
    };
    const demandSide = (book: OrderBook | RustOrderBook) => {
      book.startAuction();
      book.submit({ type: "limit", id: "b1", traderId: "t2", side: "buy", price: 100, quantity: 1 });
      icebergLevel(book, "buy", 101);
      book.submit({ type: "limit", id: "a1", traderId: "t1", side: "sell", price: 100, quantity: big });
      book.submit({ type: "limit", id: "a2", traderId: "t1", side: "sell", price: 100, quantity: big });
      return book;
    };
    // Supply at 101 is 1 + (3 + (2^53 - 2)) = 2^53; adding 3 and then the
    // hidden part would give 2^53 + 2.
    const ts1 = supplySide(new OrderBook());
    expect(ts1.indicativeAuction()).toEqual({ price: 101, volume: 2 ** 53, imbalance: 2 ** 53 - 2 });
    expect(supplySide(new RustOrderBook()).indicativeAuction()).toEqual(ts1.indicativeAuction());
    // Demand at 100 is 1 + size(101) = 2^53 the same way (bids are summed in
    // ascending price order), against 2^53 + 2 for the reordered sum.
    const ts2 = demandSide(new OrderBook());
    expect(ts2.indicativeAuction()).toEqual({ price: 100, volume: 2 ** 53, imbalance: -(2 ** 53 - 2) });
    expect(demandSide(new RustOrderBook()).indicativeAuction()).toEqual(ts2.indicativeAuction());
  });

  it("fails like the TypeScript engine when an auction's volume rounds past 2^53", () => {
    // A known @ome/core bug, found by the parity tests: each quantity is a
    // valid safe integer, but 2^53 - 1 + 4 rounds up to 2^53 + 4 in a level
    // total, so the uncross tries to trade one unit more than the book holds
    // and runs out of orders. The Rust engine keeps f64 totals to stay
    // identical, so it fails at the same point (a wasm trap). When the core
    // is fixed, this test fails, and the Rust port must get the same fix.
    const crossing = (book: OrderBook | RustOrderBook) => {
      book.startAuction();
      book.submit({ type: "limit", id: "b1", traderId: "t1", side: "buy", price: 100, quantity: 2 ** 53 - 1 });
      book.submit({ type: "limit", id: "b2", traderId: "t1", side: "buy", price: 100, quantity: 4 });
      book.submit({ type: "limit", id: "a1", traderId: "t2", side: "sell", price: 100, quantity: 2 ** 53 - 1 });
      book.submit({ type: "limit", id: "a2", traderId: "t2", side: "sell", price: 100, quantity: 4 });
      return book;
    };
    const ts = crossing(new OrderBook());
    const rust = crossing(new RustOrderBook());
    expect(rust.depth()).toEqual(ts.depth());
    expect(ts.indicativeAuction()).toEqual({ price: 100, volume: 2 ** 53 + 4, imbalance: 0 });
    expect(rust.indicativeAuction()).toEqual(ts.indicativeAuction());
    expect(() => ts.uncross()).toThrow(TypeError);
    expect(() => rust.uncross()).toThrow(/unreachable/);
  });
});
