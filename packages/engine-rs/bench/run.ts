import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { OrderBook, type EngineEvent, type OrderInput } from "@ome/core";
import * as P from "../src/protocol.js";
import { RustOrderBook } from "../src/rust-order-book.js";
import { instantiate, type EngineExports } from "../src/wasm.js";

/**
 * The TypeScript engine against the Rust engine compiled to WebAssembly, on
 * the workload of packages/core/bench/run.ts.
 *
 *   pnpm --filter @ome/engine-rs bench                       # 1M ops, seed 42, all three engines
 *   pnpm --filter @ome/engine-rs bench -- --ops=5000000 --engine=core --json
 *
 * Engines:
 *   ts    @ome/core OrderBook.
 *   rust  RustOrderBook: the same API, so ids are interned, each command is
 *         encoded into wasm memory, and events are decoded into the same objects.
 *   core  The Rust engine alone: the workload pre-encoded into wasm memory.
 *         Throughput comes from a loop inside wasm (one call per 64K
 *         commands), latency from one wasm call per command. No strings and
 *         no event objects, which isolates the cost of the boundary.
 *
 * Without --engine, each engine runs in its own child process, so V8 never
 * sees two book types at one call site and one engine's heap cannot slow
 * the next one's garbage collector.
 */

const LIMIT = 0;
const MARKET = 1;
const CANCEL = 2;

const MIX = { passive: 0.6, aggressive: 0.15, market: 0.1, cancel: 0.15 };
const ENGINES = ["ts", "rust", "core"] as const;
type Engine = (typeof ENGINES)[number];

interface Workload {
  length: number;
  kind: Uint8Array;
  /** 0 = buy, 1 = sell. */
  side: Uint8Array;
  price: Int32Array;
  quantity: Int32Array;
  trader: Int32Array;
  /** The order's own number, or the target's number for a cancel. */
  orderNo: Int32Array;
}

interface Result {
  engine: Engine;
  ops: number;
  seed: number;
  node: string;
  cpu: string;
  /** The measuring process's scheduling priority (os.getPriority()). */
  priority: number;
  opsPerSec: number;
  totalMs: number;
  trades: number;
  restingAtEnd: number;
  latencyNs: { p50: number; p90: number; p99: number; p999: number; max: number };
}

function parseArgs(): { ops: number; seed: number; json: boolean; engine: Engine | undefined } {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const engine = arg("engine");
  if (engine !== undefined && !(ENGINES as readonly string[]).includes(engine)) throw new Error(`--engine must be one of ${ENGINES.join(", ")}`);
  return {
    ops: Number(arg("ops") ?? 1_000_000),
    seed: Number(arg("seed") ?? 42),
    json: process.argv.includes("--json"),
    engine: engine as Engine | undefined,
  };
}

// ---- The workload: identical to packages/core/bench/run.ts, so the numbers compare. ----

/** Small, fast, seedable PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(count: number, seed: number): Workload {
  const random = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const w: Workload = {
    length: count,
    kind: new Uint8Array(count),
    side: new Uint8Array(count),
    price: new Int32Array(count),
    quantity: new Int32Array(count),
    trader: new Int32Array(count),
    orderNo: new Int32Array(count),
  };
  const recent = new Int32Array(10_000);
  let recentCount = 0;
  let mid = 10_000;
  let next = 0;

  for (let i = 0; i < count; i++) {
    if (i % 100 === 0) mid = Math.max(100, mid + int(-1, 1));
    const sell = random() < 0.5;
    const sign = sell ? 1 : -1;
    const r = random();
    w.side[i] = sell ? 1 : 0;
    w.trader[i] = int(1, 1000);
    w.quantity[i] = int(1, 100);

    if (r >= 1 - MIX.cancel && recentCount > 0) {
      w.kind[i] = CANCEL;
      w.orderNo[i] = recent[int(0, Math.min(recentCount, recent.length) - 1)]!;
      continue;
    }
    w.orderNo[i] = ++next;
    if (r < MIX.passive) {
      w.kind[i] = LIMIT;
      w.price[i] = mid + sign * int(1, 50);
      recent[recentCount++ % recent.length] = next;
    } else if (r < MIX.passive + MIX.aggressive) {
      w.kind[i] = LIMIT;
      w.price[i] = mid - sign * int(0, 5);
    } else {
      w.kind[i] = MARKET;
    }
  }
  return w;
}

// ---- Engines behind the OrderBook API (ts, rust): the core benchmark's step(). ----

interface Book {
  submit(input: OrderInput): EngineEvent[];
  cancel(orderId: string): EngineEvent[];
  readonly restingOrderCount: number;
}

function step(book: Book, w: Workload, i: number): number {
  const id = `o${w.orderNo[i]}`;
  let events;
  if (w.kind[i] === CANCEL) {
    events = book.cancel(id);
  } else {
    const common = { id, traderId: `t${w.trader[i]}`, side: w.side[i] === 1 ? "sell" : "buy", quantity: w.quantity[i]! } as const;
    const input: OrderInput =
      w.kind[i] === LIMIT ? { type: "limit", ...common, price: w.price[i]! } : { type: "market", ...common };
    events = book.submit(input);
  }
  let trades = 0;
  for (const e of events) if (e.type === "trade") trades++;
  return trades;
}

interface Runner {
  throughput(w: Workload): { ms: number; trades: number; resting: number };
  /** Per-operation latency in nanoseconds, sorted ascending. */
  latency(w: Workload): Float64Array;
}

const bookRunner = (make: () => Book): Runner => ({
  throughput(w) {
    const book = make();
    let trades = 0;
    const start = process.hrtime.bigint();
    for (let i = 0; i < w.length; i++) trades += step(book, w, i);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { ms, trades, resting: book.restingOrderCount };
  },
  latency(w) {
    const book = make();
    const samples = new Float64Array(w.length);
    for (let i = 0; i < w.length; i++) {
      const start = process.hrtime.bigint();
      step(book, w, i);
      samples[i] = Number(process.hrtime.bigint() - start);
    }
    return samples.sort();
  },
});

// ---- The Rust engine alone (core). ----

/** Commands per batch: big enough that call overhead vanishes, small enough to keep the buffer at 4 MB. */
const CHUNK = 65_536;

/**
 * Writes commands [from, from + count) into the engine's batch buffer. Order
 * numbers are the handles (they are unique), and trader numbers the trader
 * handles, which is what the wrapper's interning would produce.
 */
function encode(wasm: EngineExports, w: Workload, from: number, count: number): void {
  const pointer = wasm.batch_buffer(count);
  const f = new Float64Array(wasm.memory.buffer, pointer, count * P.CMD_WORDS);
  for (let k = 0; k < count; k++) {
    const i = from + k;
    const o = k * P.CMD_WORDS;
    f[o + 1] = w.orderNo[i]!;
    if (w.kind[i] === CANCEL) {
      f[o] = P.header(P.OP_CANCEL);
      continue;
    }
    f[o] = P.header(P.OP_SUBMIT, w.kind[i] === LIMIT ? P.KIND_LIMIT : P.KIND_MARKET, w.side[i]!, P.TIF_ABSENT);
    f[o + 2] = w.trader[i]!;
    f[o + 3] = w.quantity[i]!;
    f[o + 4] = w.price[i]!;
  }
}

const coreRunner: Runner = {
  throughput(w) {
    const wasm = instantiate();
    let trades = 0;
    let ns = 0n;
    for (let from = 0; from < w.length; from += CHUNK) {
      const count = Math.min(CHUNK, w.length - from);
      encode(wasm, w, from, count); // not timed: a real feed would arrive already encoded
      const start = process.hrtime.bigint();
      trades += wasm.run_batch(count);
      ns += process.hrtime.bigint() - start;
    }
    return { ms: Number(ns) / 1e6, trades, resting: wasm.resting_count() };
  },
  latency(w) {
    const wasm = instantiate();
    const samples = new Float64Array(w.length);
    for (let from = 0; from < w.length; from += CHUNK) {
      const count = Math.min(CHUNK, w.length - from);
      encode(wasm, w, from, count);
      for (let k = 0; k < count; k++) {
        const start = process.hrtime.bigint();
        wasm.step(k);
        samples[from + k] = Number(process.hrtime.bigint() - start);
      }
    }
    return samples.sort();
  },
};

const runners: Record<Engine, Runner> = {
  ts: bookRunner(() => new OrderBook()),
  rust: bookRunner(() => new RustOrderBook()),
  core: coreRunner,
};

const percentile = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

function measure(engine: Engine, ops: number, seed: number): Result {
  const runner = runners[engine];
  // Let the JIT optimise the hot paths before measuring.
  runner.throughput(generate(Math.min(200_000, ops), seed + 1));
  const workload = generate(ops, seed);
  const throughput = runner.throughput(workload);
  const latency = runner.latency(workload);
  return {
    engine,
    ops,
    seed,
    node: process.version,
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    priority: os.getPriority(),
    opsPerSec: Math.round(ops / (throughput.ms / 1000)),
    totalMs: Math.round(throughput.ms),
    trades: throughput.trades,
    restingAtEnd: throughput.resting,
    latencyNs: {
      p50: percentile(latency, 50),
      p90: percentile(latency, 90),
      p99: percentile(latency, 99),
      p999: percentile(latency, 99.9),
      max: latency[latency.length - 1]!,
    },
  };
}

/** The environment variable that hands this process's priority to the measuring children. */
const PRIORITY_ENV = "OME_BENCH_PRIORITY";

/**
 * Runs each engine in a fresh child process. A child inherits this
 * process's CPU affinity but not, on Windows, its priority class, so the
 * priority goes along in the environment and the child raises its own:
 * pinning the parent to High would otherwise leave the processes that
 * actually measure at Normal.
 */
function measureAll(): Result[] {
  const script = fileURLToPath(import.meta.url);
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--engine=") && a !== "--json");
  const env = { ...process.env, [PRIORITY_ENV]: String(os.getPriority()) };
  return ENGINES.map((engine) => {
    const out = execFileSync(process.execPath, [...process.execArgv, script, ...args, `--engine=${engine}`, "--json"], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
      env,
    });
    return JSON.parse(out) as Result;
  });
}

/** Takes the parent's priority, if it sent one; the result reports what the child really ran at. */
function inheritPriority(): void {
  const wanted = process.env[PRIORITY_ENV];
  if (wanted === undefined || Number(wanted) === os.getPriority()) return;
  try {
    os.setPriority(Number(wanted));
  } catch (error) {
    // Raising priority can need privileges (on Linux, for instance); measure anyway and say so.
    console.error(`Could not set priority ${wanted}: ${(error as Error).message}`);
  }
}

/** Windows priority classes as Node reports them; other values print as numbers. */
const priorityName = (priority: number): string =>
  Object.entries(os.constants.priority).find(([, value]) => value === priority)?.[0].replace("PRIORITY_", "").toLowerCase() ?? String(priority);

function main(): void {
  const { ops, seed, json, engine } = parseArgs();
  if (engine !== undefined) inheritPriority();
  const results = engine === undefined ? measureAll() : [measure(engine, ops, seed)];
  if (json) {
    console.log(JSON.stringify(engine === undefined ? results : results[0], null, 2));
    return;
  }
  const n = (x: number) => x.toLocaleString("en-US");
  const us = (ns: number) => `${(ns / 1000).toFixed(2)} µs`;
  const first = results[0]!;
  console.log(`\nWorkload   ${n(ops)} ops (60% passive limit, 15% aggressive limit, 10% market, 15% cancel), seed ${seed}`);
  const priorities = [...new Set(results.map((r) => priorityName(r.priority)))].join(", ");
  console.log(`Machine    ${first.cpu}, Node ${first.node}, measured at ${priorities} priority\n`);
  for (const r of results) {
    const l = r.latencyNs;
    console.log(
      `${r.engine.padEnd(5)} ${n(r.opsPerSec).padStart(11)} ops/sec | p50 ${us(l.p50)} | p90 ${us(l.p90)} | p99 ${us(l.p99)} | p99.9 ${us(l.p999)} | max ${us(l.max)}`,
    );
  }
  // The engines must agree on the outcome, or the comparison means nothing.
  const outcomes = new Set(results.map((r) => `${r.trades}/${r.restingAtEnd}`));
  console.log(`\nBook       ${n(first.trades)} trades, ${n(first.restingAtEnd)} orders resting at end${outcomes.size > 1 ? " -- ENGINES DISAGREE" : " (all engines agree)"}\n`);
  if (outcomes.size > 1) process.exitCode = 1;
}

main();
