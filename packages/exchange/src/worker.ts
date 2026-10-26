import { join } from "node:path";
import { workerData } from "node:worker_threads";
import { OrderBook, type AuctionResult, type BookSnapshot, type Depth, type EngineCommand, type EngineEvent } from "@ome/core";
import { DurableOrderBook, type EngineClass } from "@ome/journal";
import { RustOrderBook } from "@ome/engine-rs";
import { decodeRequests, encodeReplies } from "./codec.js";
import type { Reply, Request, WorkerInit } from "./protocol.js";
import { RingBuffer } from "./ring-buffer.js";

// One shard of the exchange: owns a set of symbols (fixed at start, plus any
// listed later) and processes their commands in arrival order on its own thread.

interface Book {
  apply(command: EngineCommand): EngineEvent[];
  snapshot(): BookSnapshot;
  depth(levels: number): Depth;
  indicativeAuction(): AuctionResult | null;
}

const init = workerData as WorkerInit;
const inbound = new RingBuffer(init.inbound);
const outbound = new RingBuffer(init.outbound);

/** Every book on this worker runs the same engine. Both have OrderBook's API. */
const Engine: EngineClass = init.engine === "rust" ? RustOrderBook : OrderBook;

const durable = new Map<string, DurableOrderBook>();
const books = new Map<string, Book>();

/** Opens a symbol's book; in durable mode, recovering whatever its directory already holds. */
function open(symbol: string): void {
  if (books.has(symbol)) return;
  if (init.dataDir === null) {
    books.set(symbol, new Engine());
    return;
  }
  // Synced explicitly after each batch below, so never on its own.
  const book = DurableOrderBook.open(join(init.dataDir, symbol), {
    fsync: "batch",
    batchSize: Number.MAX_SAFE_INTEGER,
    engine: Engine,
  });
  durable.set(symbol, book);
  books.set(symbol, {
    apply: (command) => book.apply(command),
    snapshot: () => book.book.snapshot(),
    depth: (levels) => book.book.depth(levels),
    indicativeAuction: () => book.book.indicativeAuction(),
  });
}

for (const symbol of init.symbols) open(symbol);

function handle(request: Request, touched: Set<DurableOrderBook>): Reply {
  switch (request.kind) {
    case "command": {
      const book = books.get(request.symbol);
      if (book === undefined) return { id: request.id, error: `unknown symbol ${request.symbol}` };
      const d = durable.get(request.symbol);
      if (d !== undefined) touched.add(d);
      return { id: request.id, events: book.apply(request.command) };
    }
    case "snapshot": {
      const book = books.get(request.symbol);
      if (book === undefined) return { id: request.id, error: `unknown symbol ${request.symbol}` };
      return { id: request.id, snapshot: book.snapshot() };
    }
    case "depth": {
      const book = books.get(request.symbol);
      if (book === undefined) return { id: request.id, error: `unknown symbol ${request.symbol}` };
      return { id: request.id, depth: book.depth(request.levels) };
    }
    case "indicative": {
      const book = books.get(request.symbol);
      if (book === undefined) return { id: request.id, error: `unknown symbol ${request.symbol}` };
      return { id: request.id, indicative: book.indicativeAuction() };
    }
    case "checkpoint":
      for (const book of durable.values()) book.snapshot();
      return { id: request.id };
    case "list":
      try {
        open(request.symbol);
      } catch (error) {
        return { id: request.id, error: `cannot list ${request.symbol}: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { id: request.id };
    case "delist": {
      const d = durable.get(request.symbol);
      if (d !== undefined) {
        // Commands earlier in this batch are journaled but not yet synced.
        touched.delete(d);
        d.close();
        durable.delete(request.symbol);
      }
      books.delete(request.symbol);
      return { id: request.id };
    }
    case "shutdown":
      return { id: request.id };
  }
}

/** Writes replies, splitting batches that are too big for one message. */
function send(replies: Reply[]): void {
  if (replies.length === 0) return;
  const bytes = encodeReplies(replies);
  if (bytes.length > outbound.maxMessageBytes && replies.length > 1) {
    const middle = replies.length >>> 1;
    send(replies.slice(0, middle));
    send(replies.slice(middle));
    return;
  }
  while (!outbound.tryWrite(bytes)) outbound.waitForSpace(100);
}

let running = true;
while (running) {
  const messages = inbound.readAll();
  if (messages.length === 0) {
    inbound.waitForData(1000);
    continue;
  }
  const replies: Reply[] = [];
  const touched = new Set<DurableOrderBook>();
  for (const message of messages) {
    for (const request of decodeRequests(message)) {
      replies.push(handle(request, touched));
      if (request.kind === "shutdown") running = false;
    }
  }
  // Group commit: everything in this batch reaches disk before any of it is
  // acknowledged.
  for (const book of touched) book.sync();
  send(replies);
}

for (const book of durable.values()) book.close();
