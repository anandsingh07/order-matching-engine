import { CommandStream, OrderBook, type AmendInput, type EngineEvent, type OrderInput, type SelfTradePrevention } from "@ome/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
// The core package's own generators, so both engines face exactly the command
// mix the TypeScript engine is tested against (invalid inputs included).
import { CommandDriver, commandArb, type BookLike, type Command } from "../../core/test/commands.js";
import { RustOrderBook } from "../src/index.js";

// FC_RUNS raises the count for deep runs, e.g. FC_RUNS=20000 pnpm test.
const runs = Number(process.env.FC_RUNS ?? 300);

/**
 * JSON plus markers for what JSON would blur: NaN and the infinities (null in
 * JSON), -0 (0 in JSON) and undefined (dropped). Equal fingerprints mean equal
 * values with the same key order, so serialised events are byte-identical too.
 */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number" && (!Number.isFinite(v) || Object.is(v, -0))) return `#${Object.is(v, -0) ? "-0" : String(v)}`;
    return v === undefined ? "#undefined" : v;
  });
}

/**
 * Compares fingerprints first and builds expect's readable diff only on a
 * mismatch. Shrinking a failure replays thousands of sequences, and a dozen
 * expect calls per command made one shrink take minutes.
 */
function expectIdentical<T>(rust: T, ts: T): void {
  if (fingerprint(rust) === fingerprint(ts)) return;
  expect(rust).toEqual(ts);
  expect(fingerprint(rust)).toBe(fingerprint(ts));
}

/** Every public query, so they must all agree, not just the events. */
const stateOf = (book: RustOrderBook | OrderBook, liveIds: number) => ({
  depth: book.depth(Number.MAX_SAFE_INTEGER),
  bestBid: book.bestBid(),
  bestAsk: book.bestAsk(),
  lastTradePrice: book.lastTradePrice(),
  restingOrderCount: book.restingOrderCount,
  pendingStopCount: book.pendingStopCount,
  phase: book.phase,
  indicativeAuction: book.indicativeAuction(),
  liveIds,
});

function expectSameState(rust: RustOrderBook, ts: OrderBook): void {
  // Every live id is interned once, and nothing else is.
  expectIdentical(stateOf(rust, rust.idStats.live), stateOf(ts, ts.restingOrderCount + ts.pendingStopCount));
}

describe("Rust engine vs. TypeScript engine: seeded command streams", () => {
  // Every command type, including icebergs, stops, amends and a call
  // auction every 2,000 commands.
  for (const seed of [1, 7, 42]) {
    it(`seed ${seed}: identical events for 150,000 commands, identical state throughout`, () => {
      const rust = new RustOrderBook();
      const ts = new OrderBook();
      const stream = new CommandStream(seed);
      let trades = 0;
      let crossedAuctions = 0;
      for (let n = 1; n <= 150_000; n++) {
        const command = stream.next();
        const expected = ts.apply(command);
        const actual = rust.apply(command);
        // Wrapped, so a failure names the command number and the command.
        expectIdentical({ n, command, events: actual }, { n, command, events: expected });
        for (const e of expected) if (e.type === "trade") trades++;
        if (n % 1_000 === 0) expectSameState(rust, ts);
        // The stream starts an auction at n % 2,000 = 1,000 and uncrosses at
        // 1,150, so the check above always lands on an empty auction book or
        // in continuous trading. While an auction is collecting orders, the
        // indicative result (imbalance included, which no event carries) is
        // compared after every command, and the whole state just before the uncross.
        if (ts.phase === "auction") {
          const indicative = ts.indicativeAuction();
          expectIdentical({ n, indicative: rust.indicativeAuction() }, { n, indicative });
          if (indicative !== null) crossedAuctions++;
        }
        if (n % 2_000 === 1_149) {
          expectSameState(rust, ts);
          expectIdentical(rust.snapshot(), ts.snapshot());
        }
        if (n % 25_000 === 0) expectIdentical(rust.snapshot(), ts.snapshot());
      }
      expectIdentical(rust.snapshot(), ts.snapshot());
      // The stream must have exercised a deep, active book, and the
      // auction checks must have compared real (crossed) auctions: about
      // 10,800 of the 11,250 in-auction commands of each seed.
      expect(trades).toBeGreaterThan(50_000);
      expect(ts.restingOrderCount).toBeGreaterThan(1_000);
      expect(crossedAuctions).toBeGreaterThan(10_000);
    }, 120_000);
  }
});

describe("Rust engine vs. TypeScript engine: random sequences (fast-check)", () => {
  const compare = (commands: Command[]) => {
    const rust = new RustOrderBook();
    const ts = new OrderBook();
    const driver = new CommandDriver();
    for (const command of commands) {
      const [actual, expected] = driver.apply<RustOrderBook | OrderBook>([rust, ts], command);
      expectIdentical(actual, expected);
      expectSameState(rust, ts);
    }
    expectIdentical(rust.snapshot(), ts.snapshot());
    const lookups = (book: RustOrderBook | OrderBook) => driver.ids.map((id) => [id, book.getOrder(id), book.getStopOrder(id)]);
    expectIdentical(lookups(rust), lookups(ts));
  };

  it(
    "produces identical events and book state for any sequence of commands",
    () => {
      // size "max" spreads lengths over the whole range; the default keeps them near 10.
      fc.assert(fc.property(fc.array(commandArb(), { maxLength: 300, size: "max" }), compare), { numRuns: runs });
    },
    Math.max(20_000, runs * 100),
  );

  // Values no TypeScript type allows but a buggy caller could still send:
  // NaN, infinities, -0, integers past 2^53, fractions and non-numbers. The
  // TypeScript engine rejects all of them through Number.isSafeInteger, and
  // the wasm boundary (where everything becomes an f64) must not change that.
  const hostile = fc.constantFrom<unknown>(NaN, Infinity, -Infinity, -0, 2 ** 53, 2 ** 53 + 2, 1e300, Number.MIN_VALUE, 0.5, null, "100", true);
  const fields = fc.constantFrom("price", "quantity", "display", "stopPrice", "limitPrice");
  const perturbed = fc
    .tuple(commandArb(), fields, hostile)
    .map(([command, field, value]) => (field in command ? ({ ...command, [field]: value } as Command) : command));

  it(
    "agrees on hostile numeric inputs",
    () => {
      const mixed = fc.oneof({ weight: 4, arbitrary: commandArb() }, { weight: 1, arbitrary: perturbed });
      fc.assert(fc.property(fc.array(mixed, { maxLength: 200, size: "max" }), compare), { numRuns: Math.ceil(runs / 2) });
    },
    Math.max(20_000, runs * 100),
  );

  // The rarest paths, made common: FOK orders under every self-trade policy,
  // against books full of icebergs. A planted bug in the Rust FOK check
  // (counting the iceberg reserve queued ahead of the trader's own order)
  // showed up in only 1.2% of the uniform sequences above and never in the
  // seeded streams; these sequences expose it 6.2% of the time.
  const selfTradePolicy = fc.constantFrom<SelfTradePrevention>("allow", "cancel_taker", "cancel_maker", "cancel_both");
  const fokHeavy = fc.tuple(commandArb(), fc.nat(9), fc.integer({ min: 1, max: 5 }), selfTradePolicy).map(([command, roll, slice, selfTrade]): Command => {
    if (command.kind === "limit" && roll < 4) return { ...command, tif: "GTC", display: slice, selfTrade };
    if (command.kind === "limit" && roll < 8) return { ...command, tif: "FOK", display: undefined, selfTrade };
    if (command.kind === "market" && roll < 8) return { ...command, tif: "FOK", selfTrade };
    return command;
  });

  it(
    "agrees on FOK orders and self-trade prevention against icebergs",
    () => {
      fc.assert(fc.property(fc.array(fokHeavy, { maxLength: 300, size: "max" }), compare), { numRuns: Math.ceil(runs / 2) });
    },
    Math.max(20_000, runs * 100),
  );

  // Valid quantities near 2^53, where level totals, FOK sums and auction
  // volumes stop adding exactly. This is why the Rust engine keeps
  // quantities in f64: it must round exactly where the TypeScript engine
  // does, in the same order.
  const huge = fc.constantFrom(2 ** 53 - 1, 2 ** 52 + 1, 2 ** 52, 3 * 2 ** 50 + 7);
  const withHuge = fc.oneof(
    { weight: 3, arbitrary: commandArb() },
    {
      weight: 1,
      // Only on new orders, and with a large iceberg slice if any: a slice of
      // 1 on a 2^53 reserve would take ~2^53 trades in either engine.
      arbitrary: fc.tuple(commandArb(), huge, fc.boolean()).map(([command, quantity, sliced]): Command => {
        if (command.kind === "limit") return { ...command, quantity, display: sliced ? Math.floor(quantity / 3) : undefined };
        if (command.kind === "market" || command.kind === "stop") return { ...command, quantity };
        return command;
      }),
    },
  );

  it(
    "agrees on valid quantities near 2^53, where sums round, and fails where the TypeScript engine fails",
    () => {
      fc.assert(
        fc.property(fc.array(withHuge, { maxLength: 200, size: "max" }), (commands) => {
          const rust = new Guarded(new RustOrderBook());
          const ts = new Guarded(new OrderBook());
          const driver = new CommandDriver();
          for (const command of commands) {
            const [actual, expected] = driver.apply([rust, ts], command);
            // A known @ome/core bug: an uncross whose volume rounded up past
            // what the book holds runs out of orders and throws. Parity means
            // the Rust engine fails at the same command (a wasm trap); both
            // books are half-updated after that, so the sequence ends there.
            expect(rust.failed).toBe(ts.failed);
            if (ts.failed) return;
            expectIdentical(actual, expected);
            expectSameState(rust.book, ts.book);
          }
          expectIdentical(rust.book.snapshot(), ts.book.snapshot());
        }),
        { numRuns: Math.ceil(runs / 2) },
      );
    },
    Math.max(20_000, runs * 100),
  );
});

/** Records a throw as an outcome to compare, instead of failing the test. */
class Guarded<B extends RustOrderBook | OrderBook> implements BookLike {
  failed = false;

  constructor(readonly book: B) {}

  submit(input: OrderInput): EngineEvent[] {
    return this.run(() => this.book.submit(input));
  }

  cancel(orderId: string): EngineEvent[] {
    return this.run(() => this.book.cancel(orderId));
  }

  amend(orderId: string, changes: AmendInput): EngineEvent[] {
    return this.run(() => this.book.amend(orderId, changes));
  }

  startAuction(): EngineEvent[] {
    return this.run(() => this.book.startAuction());
  }

  uncross(): EngineEvent[] {
    return this.run(() => this.book.uncross());
  }

  private run(f: () => EngineEvent[]): EngineEvent[] {
    try {
      return f();
    } catch {
      this.failed = true;
      return [];
    }
  }
}
