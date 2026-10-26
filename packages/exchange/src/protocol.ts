import type { AuctionResult, BookSnapshot, Depth, EngineCommand, EngineEvent } from "@ome/core";

/** Main thread -> worker. */
export type Request =
  | { kind: "command"; id: number; symbol: string; command: EngineCommand }
  | { kind: "snapshot"; id: number; symbol: string }
  /** Top `levels` price levels per side; cheap enough for live market data. */
  | { kind: "depth"; id: number; symbol: string; levels: number }
  /** What an uncross would do now (during an auction). */
  | { kind: "indicative"; id: number; symbol: string }
  /** Durable mode: write a snapshot for every book on the worker. */
  | { kind: "checkpoint"; id: number }
  | { kind: "shutdown"; id: number }
  /** Opens a book for a symbol on this worker (recovering it from disk in durable mode); a no-op if it is already open. */
  | { kind: "list"; id: number; symbol: string }
  /** Closes a symbol's book; in durable mode its files stay on disk. */
  | { kind: "delist"; id: number; symbol: string };

/** Worker -> main thread. Every request gets exactly one reply with its id. */
export type Reply =
  | { id: number; events: EngineEvent[] }
  | { id: number; snapshot: BookSnapshot }
  | { id: number; depth: Depth }
  | { id: number; indicative: AuctionResult | null }
  | { id: number; error: string }
  | { id: number };

/** The matching engine a worker runs: @ome/core's OrderBook, or @ome/engine-rs's RustOrderBook. */
export type EngineName = "ts" | "rust";

export interface WorkerInit {
  /** Module the bootstrap loads; lets tests reuse the bootstrap for fixtures. */
  entry: string;
  inbound: SharedArrayBuffer;
  outbound: SharedArrayBuffer;
  symbols: string[];
  /** When set, each symbol gets a DurableOrderBook in `<dataDir>/<symbol>`. */
  dataDir: string | null;
  engine: EngineName;
}
