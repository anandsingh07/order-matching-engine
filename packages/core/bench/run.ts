import os from "node:os";
import { OrderBook } from "../src/index.js";
import type { OrderInput } from "../src/types.js";

/**
 * Matching engine benchmark.
 *
 *   pnpm bench                      # 1M ops, seed 42
 *   pnpm bench -- --ops=5000000 --seed=7 --json
 *
 * The workload is generated up front from a seeded PRNG, so every run replays
 * the identical order flow. It is stored in typed arrays (not objects) so the
 * harness itself adds nothing for the garbage collector to scan; each order
 * object is built just before it is submitted, like a gateway decoding a
 * network message.
 */

const LIMIT = 0;
const MARKET = 1;
const CANCEL = 2;

const MIX = { passive: 0.6, aggressive: 0.15, market: 0.1, cancel: 0.15 };

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

function parseArgs(): { ops: number; seed: number; json: boolean } {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return {
    ops: Number(arg("ops") ?? 1_000_000),
    seed: Number(arg("seed") ?? 42),
    json: process.argv.includes("--json"),
  };
}

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

/**
 * Order flow around a randomly walking mid price (in ticks):
 * passive limits rest 1-50 ticks away, aggressive limits cross by up to
 * 5 ticks, market orders sweep, and cancels target recent resting orders.
 */
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
  // Ring buffer of recently placed passive orders, for cancels to target.
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

function step(book: OrderBook, w: Workload, i: number): number {
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

function measureThroughput(w: Workload): { ms: number; trades: number; resting: number } {
  const book = new OrderBook();
  let trades = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < w.length; i++) trades += step(book, w, i);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, trades, resting: book.restingOrderCount };
}

/** Per-operation latency in nanoseconds, sorted ascending. */
function measureLatency(w: Workload): Float64Array {
  const book = new OrderBook();
  const samples = new Float64Array(w.length);
  for (let i = 0; i < w.length; i++) {
    const start = process.hrtime.bigint();
    step(book, w, i);
    samples[i] = Number(process.hrtime.bigint() - start);
  }
  return samples.sort();
}

const percentile = (sorted: Float64Array, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

function main(): void {
  const { ops, seed, json } = parseArgs();

  // Let the JIT optimise the hot paths before measuring.
  measureThroughput(generate(Math.min(200_000, ops), seed + 1));

  const workload = generate(ops, seed);
  const throughput = measureThroughput(workload);
  const latency = measureLatency(workload);
  const result = {
    ops,
    seed,
    node: process.version,
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
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

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const n = (x: number) => x.toLocaleString("en-US");
  const us = (ns: number) => `${(ns / 1000).toFixed(2)} µs`;
  console.log(`\nWorkload   ${n(ops)} ops (60% passive limit, 15% aggressive limit, 10% market, 15% cancel), seed ${seed}`);
  console.log(`Machine    ${result.cpu}, Node ${result.node}`);
  console.log(`Throughput ${n(result.opsPerSec)} ops/sec (${n(result.totalMs)} ms total)`);
  console.log(
    `Latency    p50 ${us(result.latencyNs.p50)} | p90 ${us(result.latencyNs.p90)} | p99 ${us(result.latencyNs.p99)} | p99.9 ${us(result.latencyNs.p999)} | max ${us(result.latencyNs.max)}`,
  );
  console.log(`Book       ${n(result.trades)} trades, ${n(result.restingAtEnd)} orders resting at end\n`);
}

main();
