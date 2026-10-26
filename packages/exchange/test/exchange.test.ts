import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStream, OrderBook, type EngineEvent } from "@ome/core";
import { describe, expect, it } from "vitest";
import { Exchange, type EngineName } from "../src/index.js";

const ENGINES: EngineName[] = ["ts", "rust"];
const SYMBOLS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "ITC"];

/** Interleaves seeded command streams across symbols in a seeded pseudo-random order. */
function* interleaved(count: number, seed: number) {
  const streams = SYMBOLS.map((_, i) => new CommandStream(seed + i));
  let x = seed;
  for (let i = 0; i < count; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const s = x % SYMBOLS.length;
    yield { symbol: SYMBOLS[s]!, command: streams[s]!.next() };
  }
}

// Every test below runs once per engine. The single-threaded book each run is
// compared with is always @ome/core's OrderBook, so with the Rust engine in
// the workers these are cross-engine equivalence tests too.
describe.each(ENGINES)("Exchange (%s engine)", (engine) => {
  it("gives every symbol exactly the events a single-threaded book would", async () => {
    const exchange = Exchange.start({ symbols: SYMBOLS, workers: 3, engine });
    const books = new Map(SYMBOLS.map((s) => [s, new OrderBook()]));
    const expected = new Map(SYMBOLS.map((s) => [s, [] as EngineEvent[]]));
    const seen = new Map(SYMBOLS.map((s) => [s, [] as EngineEvent[]]));
    exchange.onEvents((symbol, events) => seen.get(symbol)!.push(...events));

    const replies: Promise<EngineEvent[]>[] = [];
    for (const { symbol, command } of interleaved(30_000, 5)) {
      expected.get(symbol)!.push(...books.get(symbol)!.apply(command));
      replies.push(exchange.send(symbol, command));
    }
    await Promise.all(replies);

    for (const symbol of SYMBOLS) {
      expect(seen.get(symbol)).toEqual(expected.get(symbol));
      expect(await exchange.snapshot(symbol)).toEqual(books.get(symbol)!.snapshot());
      expect(await exchange.depth(symbol, 5)).toEqual(books.get(symbol)!.depth(5));
    }
    await exchange.stop();
  }, 60_000);

  it("stays correct when tiny ring buffers force constant back-pressure", async () => {
    const exchange = Exchange.start({ symbols: SYMBOLS, workers: 2, ringBytes: 64 * 1024, engine });
    const books = new Map(SYMBOLS.map((s) => [s, new OrderBook()]));
    const replies: Promise<EngineEvent[]>[] = [];
    const expected: EngineEvent[][] = [];
    for (const { symbol, command } of interleaved(10_000, 9)) {
      expected.push(books.get(symbol)!.apply(command));
      replies.push(exchange.send(symbol, command));
    }
    expect(await Promise.all(replies)).toEqual(expected);
    await exchange.stop();
  }, 60_000);

  it("recovers every symbol's state after a restart in durable mode", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ome-exchange-"));
    try {
      const books = new Map(SYMBOLS.map((s) => [s, new OrderBook()]));
      const first = Exchange.start({ symbols: SYMBOLS, workers: 3, dataDir, engine });
      const commands = [...interleaved(6_000, 21)];
      await Promise.all(
        commands.slice(0, 3_000).map(({ symbol, command }) => {
          books.get(symbol)!.apply(command);
          return first.send(symbol, command);
        }),
      );
      await first.checkpoint();
      await Promise.all(
        commands.slice(3_000).map(({ symbol, command }) => {
          books.get(symbol)!.apply(command);
          return first.send(symbol, command);
        }),
      );
      await first.stop();

      // Different worker count on restart: state is per symbol, not per worker.
      const second = Exchange.start({ symbols: SYMBOLS, workers: 2, dataDir, engine });
      for (const symbol of SYMBOLS) expect(await second.snapshot(symbol)).toEqual(books.get(symbol)!.snapshot());
      await second.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a request too large for the ring instead of crashing", async () => {
    const exchange = Exchange.start({ symbols: ["TCS"], ringBytes: 1024, engine });
    const huge = { type: "cancel" as const, orderId: "x".repeat(2_000) };
    await expect(exchange.send("TCS", huge)).rejects.toThrow(/too large/);
    expect(await exchange.send("TCS", { type: "cancel", orderId: "small" })).toMatchObject([{ type: "rejected" }]);
    await exchange.stop();
  });

  it("rejects unknown symbols and requests after stop", async () => {
    const exchange = Exchange.start({ symbols: ["TCS"], engine });
    await expect(exchange.send("NOPE", { type: "cancel", orderId: "x" })).rejects.toThrow(/unknown symbol/);
    await exchange.stop();
    await expect(exchange.send("TCS", { type: "cancel", orderId: "x" })).rejects.toThrow(/stopped/);
  });
});

describe.each(ENGINES)("Exchange dynamic listing (%s engine)", (engine) => {
  const LISTED = ["TCS-F", "TCS-C4100", "TCS-P4100", "INFY-F", "INFY-C1850"];

  it("lists symbols while running, and they match a single-threaded book like the starting ones", async () => {
    const exchange = Exchange.start({ symbols: ["TCS", "INFY"], workers: 2, engine });
    const all = ["TCS", "INFY", ...LISTED];
    const books = new Map(all.map((s) => [s, new OrderBook()]));
    const streams = new Map(all.map((s, i) => [s, new CommandStream(40 + i)]));
    const seen = new Map(all.map((s) => [s, [] as EngineEvent[]]));
    exchange.onEvents((symbol, events) => seen.get(symbol)!.push(...events));

    const replies: Promise<EngineEvent[]>[] = [];
    const send = (symbol: string) => {
      const command = streams.get(symbol)!.next();
      books.get(symbol)!.apply(command);
      replies.push(exchange.send(symbol, command));
    };
    for (let i = 0; i < 2_000; i++) send(i % 2 === 0 ? "TCS" : "INFY");
    // Not awaited: commands sent straight after listing queue behind it and still arrive in order.
    const listed = exchange.list(LISTED);
    for (let i = 0; i < 20_000; i++) send(all[i % all.length]!);
    await listed;
    await Promise.all(replies);

    expect(exchange.symbols.sort()).toEqual([...all].sort());
    for (const symbol of all) {
      expect(await exchange.snapshot(symbol)).toEqual(books.get(symbol)!.snapshot());
      expect(seen.get(symbol)!.length).toBeGreaterThan(0);
    }
    // Listing an existing symbol again leaves its book alone.
    await exchange.list(["TCS-F"]);
    expect(await exchange.snapshot("TCS-F")).toEqual(books.get("TCS-F")!.snapshot());
    await exchange.stop();
  }, 60_000);

  it("places each listed symbol on the worker with the fewest", async () => {
    const exchange = Exchange.start({ symbols: ["A", "B", "C"], workers: 3, engine });
    await exchange.list(["D", "E", "F", "G"]);
    // Ties go to the lowest worker: D, E and F fill the three, G goes back to the first.
    expect(["A", "B", "C", "D", "E", "F", "G"].map((s) => exchange.workerOf(s))).toEqual([0, 1, 2, 0, 1, 2, 0]);
    await exchange.delist(["B", "E"]);
    await exchange.list(["H"]);
    expect(exchange.workerOf("H")).toBe(1);
    expect(exchange.workerOf("B")).toBeUndefined();
    for (const symbol of exchange.symbols) {
      expect(await exchange.send(symbol, { type: "cancel", orderId: "none" })).toMatchObject([{ type: "rejected", reason: "unknown_order" }]);
    }
    await exchange.stop();
  });

  it("refuses a delisted symbol, and relists it as a fresh book in memory", async () => {
    const exchange = Exchange.start({ symbols: ["TCS"], engine });
    await exchange.list(["TCS-F"]);
    const order = { type: "limit" as const, id: "a", traderId: "u1", side: "buy" as const, price: 100, quantity: 5 };
    await exchange.send("TCS-F", { type: "submit", order });
    await exchange.delist(["TCS-F", "NEVER-LISTED"]);
    expect(exchange.symbols).toEqual(["TCS"]);
    await expect(exchange.send("TCS-F", { type: "cancel", orderId: "a" })).rejects.toThrow(/unknown symbol/);
    await exchange.list(["TCS-F"]);
    expect((await exchange.snapshot("TCS-F")).bids).toEqual([]);
    await exchange.stop();
  });

  it("recovers listed symbols from disk in durable mode, including after a delist", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ome-exchange-list-"));
    try {
      const books = new Map(LISTED.map((s) => [s, new OrderBook()]));
      const first = Exchange.start({ symbols: ["TCS"], workers: 2, dataDir, engine });
      await first.list(LISTED);
      const streams = LISTED.map((_, i) => new CommandStream(70 + i));
      const replies: Promise<EngineEvent[]>[] = [];
      for (let i = 0; i < 5_000; i++) {
        const k = i % LISTED.length;
        const command = streams[k]!.next();
        books.get(LISTED[k]!)!.apply(command);
        replies.push(first.send(LISTED[k]!, command));
      }
      await Promise.all(replies);
      await first.checkpoint();
      // A delisted book is closed, but its journal stays on disk.
      await first.delist(["INFY-F"]);
      await first.stop();

      // Restart with only the starting symbols, then list the series again.
      const second = Exchange.start({ symbols: ["TCS"], workers: 3, dataDir, engine });
      await second.list(LISTED);
      for (const symbol of LISTED) expect(await second.snapshot(symbol)).toEqual(books.get(symbol)!.snapshot());
      await second.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("Exchange engines", () => {
  it("runs the TypeScript engine unless told otherwise, and refuses an unknown one", async () => {
    const exchange = Exchange.start({ symbols: ["TCS"] });
    expect(exchange.engine).toBe("ts");
    await exchange.stop();
    expect(() => Exchange.start({ symbols: ["TCS"], engine: "wasm" as EngineName })).toThrow(/engine must be "ts" or "rust", got "wasm"/);
  });

  it.each([
    ["ts", "rust"],
    ["rust", "ts"],
  ] as const)("recovers a durable directory written by the %s engine with the %s engine, and trades on", async (from, to) => {
    const dataDir = mkdtempSync(join(tmpdir(), "ome-exchange-switch-"));
    try {
      const books = new Map(SYMBOLS.map((s) => [s, new OrderBook()]));
      const commands = [...interleaved(9_000, 33)];
      const sendAll = (exchange: Exchange, slice: typeof commands) =>
        Promise.all(
          slice.map(({ symbol, command }) => {
            const expected = books.get(symbol)!.apply(command);
            return exchange.send(symbol, command).then((events) => expect(events).toEqual(expected));
          }),
        );

      const first = Exchange.start({ symbols: SYMBOLS, workers: 2, dataDir, engine: from });
      await sendAll(first, commands.slice(0, 3_000));
      // Recovery then starts from a snapshot and replays the journal after it.
      await first.checkpoint();
      await sendAll(first, commands.slice(3_000, 6_000));
      await first.stop();

      const second = Exchange.start({ symbols: SYMBOLS, workers: 3, dataDir, engine: to });
      expect(second.engine).toBe(to);
      for (const symbol of SYMBOLS) expect(await second.snapshot(symbol)).toEqual(books.get(symbol)!.snapshot());
      // Resting orders from before the switch can still be filled, cancelled and amended.
      await sendAll(second, commands.slice(6_000));
      for (const symbol of SYMBOLS) expect(await second.snapshot(symbol)).toEqual(books.get(symbol)!.snapshot());
      await second.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  // The engines' events are identical, so this tells them apart by how they
  // fail. A known @ome/core bug (see packages/engine-rs/test/rust-order-book.test.ts):
  // an uncross whose volume rounds past 2^53 throws a TypeError in the
  // TypeScript engine and traps in the Rust one. A worker whose engine throws
  // stops, and the exchange fails with its error. When the core is fixed,
  // this test fails and needs another way to tell the engines apart.
  it.each(ENGINES)("hands the %s engine to its workers", async (engine) => {
    const exchange = Exchange.start({ symbols: ["TCS"], engine });
    const submit = (id: string, traderId: string, side: "buy" | "sell", quantity: number) =>
      exchange.send("TCS", { type: "submit", order: { type: "limit", id, traderId, side, price: 100, quantity } });
    await exchange.send("TCS", { type: "start_auction" });
    await submit("b1", "t1", "buy", 2 ** 53 - 1);
    await submit("b2", "t1", "buy", 4);
    await submit("a1", "t2", "sell", 2 ** 53 - 1);
    await submit("a2", "t2", "sell", 4);
    const failure = engine === "rust" ? /unreachable/ : /Cannot read properties of undefined/;
    await expect(exchange.send("TCS", { type: "uncross" })).rejects.toThrow(failure);
    await expect(exchange.stop()).rejects.toThrow(failure);
  });
});
