import { mkdtempSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStream, OrderBook, type EngineCommand, type EngineEvent } from "@ome/core";
import { RustOrderBook } from "@ome/engine-rs";
import { Exchange, type EngineName } from "../src/index.js";

/**
 * Throughput of the sharded exchange as worker threads are added, compared
 * with a single in-process book (no threads, no messaging).
 *
 *   pnpm bench -- --ops=400000
 *   pnpm bench -- --engine=rust      # the Rust engine (WebAssembly) in-process and in every worker
 */

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const ops = Number(arg("ops") ?? 400_000);
const engine = (arg("engine") ?? "ts") as EngineName;
if (engine !== "ts" && engine !== "rust") throw new Error(`--engine must be ts or rust, got ${engine}`);
const Engine = engine === "rust" ? RustOrderBook : OrderBook;
const symbols = Array.from({ length: 16 }, (_, i) => `SYM${String(i + 1).padStart(2, "0")}`);
const streams = symbols.map((_, i) => new CommandStream(100 + i));
const work: { symbol: string; command: EngineCommand }[] = Array.from({ length: ops }, (_, i) => ({
  symbol: symbols[i % symbols.length]!,
  command: streams[i % symbols.length]!.next(),
}));
/** Requests in flight at once; the rest wait their turn, like a bounded gateway. */
const WINDOW = 20_000;

const rate = (count: number, ms: number) => Math.round(count / (ms / 1000)).toLocaleString("en-US").padStart(10);

function inProcess(): void {
  const books = new Map(symbols.map((s) => [s, new Engine()]));
  const start = performance.now();
  for (const { symbol, command } of work) books.get(symbol)!.apply(command);
  const ms = performance.now() - start;
  console.log(`in-process (no threads)  ${rate(ops, ms)} commands/sec`);
}

/**
 * Keeps up to WINDOW requests in flight continuously: whenever half the window
 * has completed, it is topped up again. A chunk-then-wait loop would leave the
 * workers idle while the main thread prepares the next chunk.
 */
function pipeline(exchange: Exchange): Promise<void> {
  return new Promise((resolve, reject) => {
    let sent = 0;
    let done = 0;
    const onReply = (_events: EngineEvent[]) => {
      done++;
      if (done === work.length) resolve();
      else if (sent - done <= WINDOW / 2) pump();
    };
    const pump = () => {
      while (sent < work.length && sent - done < WINDOW) {
        const { symbol, command } = work[sent++]!;
        exchange.send(symbol, command).then(onReply, reject);
      }
    };
    pump();
  });
}

async function sharded(workers: number, durable: boolean): Promise<void> {
  const dataDir = durable ? mkdtempSync(join(tmpdir(), "ome-xbench-")) : undefined;
  try {
    const exchange = Exchange.start({ symbols, workers, engine, ...(dataDir === undefined ? {} : { dataDir }) });
    // A harmless cancel per symbol starts every worker before timing begins.
    await Promise.all(symbols.map((s) => exchange.send(s, { type: "cancel", orderId: "warmup" })));
    const start = performance.now();
    await pipeline(exchange);
    const ms = performance.now() - start;
    await exchange.stop();
    const label = `${String(workers).padStart(2)} worker${workers === 1 ? " " : "s"}`;
    console.log(`${label}${durable ? " (durable)    " : "              "} ${rate(ops, ms)} commands/sec`);
  } finally {
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log(`\n${ops.toLocaleString("en-US")} commands over ${symbols.length} symbols, ${engine} engine, ${os.cpus()[0]?.model.trim()}\n`);
inProcess();
for (const workers of [1, 2, 4, 8]) await sharded(workers, false);
console.log("\nDurable mode: journal + fsync before every acknowledgement (group commit per batch)");
for (const workers of [1, 2, 4, 8]) await sharded(workers, true);
console.log();
