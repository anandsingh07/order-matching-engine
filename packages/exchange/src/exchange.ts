import { Worker } from "node:worker_threads";
import type { AuctionResult, BookSnapshot, Depth, EngineCommand, EngineEvent } from "@ome/core";
import { decodeReplies, encodeRequests } from "./codec.js";
import type { EngineName, Reply, Request, WorkerInit } from "./protocol.js";
import { RingBuffer } from "./ring-buffer.js";

export interface ExchangeOptions {
  /** Symbols listed at start; more can be added later with `list`. */
  symbols: string[];
  /** Worker threads; symbols are dealt round-robin. Defaults to min(symbols, 4). */
  workers?: number;
  /** Size of each ring buffer. Defaults to 4 MiB. */
  ringBytes?: number;
  /** Enables durability: a journal and snapshots per symbol under this directory. */
  dataDir?: string;
  /**
   * The matching engine in every worker. "ts" (the default) is @ome/core's
   * OrderBook; "rust" is @ome/engine-rs's RustOrderBook, the Rust engine
   * compiled to WebAssembly, which gives the same events and snapshots.
   * Journals and snapshots are the same for both, so a durable data
   * directory written with one engine recovers with the other.
   */
  engine?: EngineName;
}

export type EventListener = (symbol: string, events: EngineEvent[]) => void;

/** Requests per ring message; amortises encoding and wake-ups. */
const BATCH = 256;

interface Pending {
  symbol: string | null;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

interface Shard {
  worker: Worker;
  inbound: RingBuffer;
  outbound: RingBuffer;
  queue: Request[];
  flushScheduled: boolean;
  /** Waiting for the worker to free ring space; queued requests stay queued. */
  blocked: boolean;
}

const workerUrl = new URL("./worker.ts", import.meta.url).href;
const bootstrapUrl = new URL("./worker-bootstrap.mjs", import.meta.url);

/**
 * A multi-symbol exchange sharded across worker threads.
 *
 * Each symbol belongs to exactly one worker, and each worker has two
 * lock-free ring buffers: requests in, replies out. Commands for one symbol
 * are therefore processed strictly in the order they were sent, while
 * different workers run in parallel on separate cores.
 */
export class Exchange {
  private readonly shards: Shard[] = [];
  private readonly shardOf = new Map<string, Shard>();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<EventListener>();
  private nextId = 1;
  private stopping = false;
  private closed = false;
  private failure: Error | null = null;

  private constructor(
    /** The matching engine the workers run. */
    readonly engine: EngineName,
  ) {}

  static start(options: ExchangeOptions): Exchange {
    const engine = options.engine ?? "ts";
    // Checked here, not just typed: the gateway reads it from the environment.
    if (engine !== "ts" && engine !== "rust") throw new Error(`engine must be "ts" or "rust", got ${JSON.stringify(engine)}`);
    const exchange = new Exchange(engine);
    const symbols = [...new Set(options.symbols)];
    if (symbols.length === 0) throw new Error("at least one symbol is required");
    const count = Math.max(1, Math.min(options.workers ?? Math.min(symbols.length, 4), symbols.length));
    const ringBytes = options.ringBytes ?? 4 * 1024 * 1024;

    for (let i = 0; i < count; i++) {
      const owned = symbols.filter((_, j) => j % count === i);
      const inbound = RingBuffer.allocate(ringBytes);
      const outbound = RingBuffer.allocate(ringBytes);
      const init: WorkerInit = {
        entry: workerUrl,
        inbound,
        outbound,
        symbols: owned,
        dataDir: options.dataDir ?? null,
        engine,
      };
      const worker = new Worker(bootstrapUrl, { workerData: init });
      const shard: Shard = {
        worker,
        inbound: new RingBuffer(inbound),
        outbound: new RingBuffer(outbound),
        queue: [],
        flushScheduled: false,
        blocked: false,
      };
      worker.on("error", (error) => exchange.fail(error));
      worker.on("exit", (code) => {
        if (!exchange.stopping) exchange.fail(new Error(`worker ${i} exited with code ${code}`));
      });
      exchange.shards.push(shard);
      for (const symbol of owned) exchange.shardOf.set(symbol, shard);
      void exchange.readReplies(shard);
    }
    return exchange;
  }

  get symbols(): string[] {
    return [...this.shardOf.keys()];
  }

  /** Which worker thread holds a symbol's book (0-based), for monitoring and tests. */
  workerOf(symbol: string): number | undefined {
    const shard = this.shardOf.get(symbol);
    return shard === undefined ? undefined : this.shards.indexOf(shard);
  }

  /**
   * Adds books for new symbols while running, say a newly listed futures or
   * options series. Each goes to the worker with the fewest symbols. In
   * durable mode a symbol that was listed before recovers its book from disk.
   * Symbols that are already listed are left alone.
   *
   * The symbol is routed to its worker at once, so commands sent before this
   * resolves are queued behind the listing on the same ring and still arrive
   * in order.
   */
  async list(symbols: string[]): Promise<void> {
    const added = [...new Set(symbols)].filter((symbol) => !this.shardOf.has(symbol));
    const replies: Promise<Reply>[] = [];
    for (const symbol of added) {
      const counts = new Map(this.shards.map((shard) => [shard, 0]));
      for (const shard of this.shardOf.values()) counts.set(shard, counts.get(shard)! + 1);
      const shard = this.shards.reduce((best, s) => (counts.get(s)! < counts.get(best)! ? s : best));
      this.shardOf.set(symbol, shard);
      replies.push(this.request(shard, null, (id) => ({ kind: "list", id, symbol })));
    }
    const results = await Promise.allSettled(replies);
    // A book that failed to open must not keep receiving commands.
    results.forEach((result, i) => {
      if (result.status === "rejected") this.shardOf.delete(added[i]!);
    });
    const failed = results.find((result) => result.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  }

  /**
   * Removes symbols' books, say an expired series. Later requests for them are
   * refused as unknown symbols; in durable mode their files stay on disk.
   */
  async delist(symbols: string[]): Promise<void> {
    const replies: Promise<Reply>[] = [];
    for (const symbol of new Set(symbols)) {
      const shard = this.shardOf.get(symbol);
      if (shard === undefined) continue;
      this.shardOf.delete(symbol);
      replies.push(this.request(shard, null, (id) => ({ kind: "delist", id, symbol })));
    }
    await Promise.all(replies);
  }

  /** Sends a command; resolves with its events once processed (and, in durable mode, on disk). */
  async send(symbol: string, command: EngineCommand): Promise<EngineEvent[]> {
    const reply = await this.request(this.shardFor(symbol), symbol, (id) => ({ kind: "command", id, symbol, command }));
    return (reply as { events: EngineEvent[] }).events;
  }

  async snapshot(symbol: string): Promise<BookSnapshot> {
    const reply = await this.request(this.shardFor(symbol), null, (id) => ({ kind: "snapshot", id, symbol }));
    return (reply as { snapshot: BookSnapshot }).snapshot;
  }

  /** Top price levels per side, best first. */
  async depth(symbol: string, levels = 10): Promise<Depth> {
    const reply = await this.request(this.shardFor(symbol), null, (id) => ({ kind: "depth", id, symbol, levels }));
    return (reply as { depth: Depth }).depth;
  }

  /** During an auction: the price and volume an uncross would trade right now. */
  async indicative(symbol: string): Promise<AuctionResult | null> {
    const reply = await this.request(this.shardFor(symbol), null, (id) => ({ kind: "indicative", id, symbol }));
    return (reply as { indicative: AuctionResult | null }).indicative;
  }

  /** Durable mode: snapshot every book so recovery replays less journal. */
  async checkpoint(): Promise<void> {
    await Promise.all(this.shards.map((shard) => this.request(shard, null, (id) => ({ kind: "checkpoint", id }))));
  }

  /** Called with every command's events, in per-symbol order. Returns an unsubscribe function. */
  onEvents(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Finishes outstanding work, then stops the workers. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    const exits = this.shards.map((shard) => new Promise<void>((resolve) => shard.worker.once("exit", () => resolve())));
    const done = Promise.all(this.shards.map((shard) => this.request(shard, null, (id) => ({ kind: "shutdown", id }))));
    // Set after queuing the shutdowns: later requests are refused, and a
    // worker exiting after its shutdown reply is expected, not a failure.
    this.stopping = true;
    await Promise.race([done, Promise.all(exits)]);
    this.closed = true;
    await Promise.all(exits);
  }

  private shardFor(symbol: string): Shard {
    const shard = this.shardOf.get(symbol);
    if (shard === undefined) throw new Error(`unknown symbol ${symbol}`);
    return shard;
  }

  private request(shard: Shard, symbol: string | null, build: (id: number) => Request): Promise<Reply> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.stopping) return Promise.reject(new Error("exchange is stopped"));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { symbol, resolve, reject });
      shard.queue.push(build(id));
      if (shard.queue.length >= BATCH) this.flush(shard);
      else if (!shard.flushScheduled) {
        shard.flushScheduled = true;
        queueMicrotask(() => this.flush(shard));
      }
    });
  }

  /** Moves queued requests into the ring, waiting asynchronously whenever it is full. */
  private flush(shard: Shard): void {
    shard.flushScheduled = false;
    if (shard.blocked) return;
    while (shard.queue.length > 0) {
      let size = Math.min(BATCH, shard.queue.length);
      let bytes = encodeRequests(shard.queue.slice(0, size));
      while (bytes.length > shard.inbound.maxMessageBytes && size > 1) {
        size >>>= 1;
        bytes = encodeRequests(shard.queue.slice(0, size));
      }
      if (bytes.length > shard.inbound.maxMessageBytes) {
        const [request] = shard.queue.splice(0, 1);
        this.settle({ id: request!.id, error: `request of ${bytes.length} bytes is too large for the ring buffer` });
        continue;
      }
      if (!shard.inbound.tryWrite(bytes)) {
        shard.blocked = true;
        void shard.inbound.waitForSpaceAsync(100).then(() => {
          shard.blocked = false;
          this.flush(shard);
        });
        return;
      }
      shard.queue.splice(0, size);
    }
  }

  private async readReplies(shard: Shard): Promise<void> {
    while (!this.closed || this.pending.size > 0) {
      if (this.failure !== null) return;
      const messages = shard.outbound.readAll();
      if (messages.length === 0) {
        await shard.outbound.waitForDataAsync(100);
        continue;
      }
      for (const message of messages) {
        for (const reply of decodeReplies(message)) this.settle(reply);
      }
    }
  }

  private settle(reply: Reply): void {
    const pending = this.pending.get(reply.id);
    if (pending === undefined) return;
    this.pending.delete(reply.id);
    if ("error" in reply) {
      pending.reject(new Error(reply.error));
      return;
    }
    if ("events" in reply && pending.symbol !== null) {
      for (const listener of this.listeners) listener(pending.symbol, reply.events);
    }
    pending.resolve(reply);
  }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
