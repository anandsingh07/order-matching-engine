import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { OrderBook, type BookSnapshot, type EngineCommand, type EngineEvent } from "@ome/core";
import { decodeChecked, decodeSegment, encodeChecked, encodeRecord } from "./record.js";

/**
 * always: write and fsync every command; nothing acknowledged is ever lost.
 * batch:  group commit, with one write and one fsync per `batchSize` commands.
 *         Much faster; `durableCommand` tells you what may be acknowledged.
 * never:  write every command but leave flushing to the OS; survives a
 *         process crash, not power loss.
 */
export type FsyncPolicy = "always" | "batch" | "never";

export interface DurableOptions {
  fsync?: FsyncPolicy;
  batchSize?: number;
  /** Snapshots to keep; older snapshots and the journal they cover are deleted. */
  keepSnapshots?: number;
  /**
   * The matching engine to journal: @ome/core's OrderBook (the default) or a
   * drop-in with the same API, such as @ome/engine-rs's RustOrderBook. The
   * journal holds commands and the snapshots hold BookSnapshot JSON, so a
   * directory written with one engine opens with the other.
   */
  engine?: EngineClass;
}

/** The read-only part of OrderBook. Writes must go through the journal. */
export type ReadonlyOrderBook = Pick<
  OrderBook,
  | "bestBid"
  | "bestAsk"
  | "lastTradePrice"
  | "depth"
  | "getOrder"
  | "getStopOrder"
  | "snapshot"
  | "restingOrderCount"
  | "pendingStopCount"
  | "phase"
  | "indicativeAuction"
>;

/** What the journal needs from an engine: the read-only API, plus `apply`. */
export type Engine = ReadonlyOrderBook & Pick<OrderBook, "apply">;

/** An engine class: `new` for an empty book, `fromSnapshot` to restore one. OrderBook itself is one. */
export interface EngineClass {
  new (): Engine;
  fromSnapshot(snapshot: BookSnapshot): Engine;
}

const pad = (n: number) => String(n).padStart(12, "0");
const segmentName = (firstN: number) => `journal-${pad(firstN)}.log`;
const snapshotName = (n: number) => `snapshot-${pad(n)}.json`;

/** Files named `<prefix><number><suffix>`, sorted by number. */
function listNumbered(dir: string, prefix: string, suffix: string): { n: number; path: string }[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .map((f) => ({ n: Number(f.slice(prefix.length, -suffix.length)), path: join(dir, f) }))
    .filter((f) => Number.isSafeInteger(f.n))
    .sort((a, b) => a.n - b.n);
}

function readSnapshot(path: string): BookSnapshot | null {
  const json = decodeChecked(readFileSync(path, "utf8"));
  if (json === null) return null;
  try {
    return JSON.parse(json) as BookSnapshot;
  } catch {
    return null;
  }
}

/** Writes a file so that it either fully exists under its final name or not at all. */
function writeAtomically(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * An order book (OrderBook, or another engine with its API) with a
 * write-ahead journal and snapshots.
 *
 * Every command is appended to the journal before the engine applies it.
 * The engine is deterministic, so replaying the journal on top of the latest
 * snapshot rebuilds exactly the state it had, including sequence numbers.
 *
 * Directory layout:
 *   snapshot-<n>.json   state after command n (checksummed, written atomically)
 *   journal-<n>.log     commands from n onward; a new segment starts at each snapshot
 */
export class DurableOrderBook {
  private fd: number;
  private segmentStart: number;
  private lastN: number;
  private durableN: number;
  private pending: Buffer[] = [];
  private readonly fsync: FsyncPolicy;
  private readonly batchSize: number;
  private readonly keepSnapshots: number;

  private constructor(
    readonly dir: string,
    private readonly inner: Engine,
    lastN: number,
    options: DurableOptions,
  ) {
    this.fsync = options.fsync ?? "always";
    this.batchSize = options.batchSize ?? 1000;
    this.keepSnapshots = Math.max(1, options.keepSnapshots ?? 2);
    this.lastN = lastN;
    this.durableN = lastN;
    const segments = listNumbered(dir, "journal-", ".log");
    this.segmentStart = segments.at(-1)?.n ?? lastN + 1;
    this.fd = openSync(join(dir, segmentName(this.segmentStart)), "a");
  }

  /** Opens (or creates) a book in `dir`, recovering from the latest snapshot and journal. */
  static open(dir: string, options: DurableOptions = {}): DurableOrderBook {
    mkdirSync(dir, { recursive: true });

    const engine = options.engine ?? OrderBook;
    let book = new engine();
    let lastN = 0;
    // Newest valid snapshot wins. Invalid ones newer than it are deleted, so
    // pruning can never keep a useless snapshot while deleting the journal a
    // good one needs.
    let found = false;
    for (const snap of listNumbered(dir, "snapshot-", ".json").reverse()) {
      if (found) break;
      const snapshot = readSnapshot(snap.path);
      if (snapshot === null) {
        rmSync(snap.path);
        continue;
      }
      book = engine.fromSnapshot(snapshot);
      lastN = snap.n;
      found = true;
    }

    const segments = listNumbered(dir, "journal-", ".log");
    segments.forEach((segment, i) => {
      const data = readFileSync(segment.path);
      const { records, validBytes } = decodeSegment(data, segment.n, segment.path);
      for (const record of records) {
        if (record.n <= lastN) continue;
        if (record.n !== lastN + 1) throw new Error(`Journal gap: expected command ${lastN + 1}, found ${record.n}`);
        book.apply(record.command);
        lastN = record.n;
      }
      if (validBytes < data.length) {
        if (i !== segments.length - 1) throw new Error(`Torn record in non-final segment ${segment.path}`);
        truncateSync(segment.path, validBytes);
      }
    });

    return new DurableOrderBook(dir, book, lastN, options);
  }

  /**
   * Replaces whatever is in `dir` with this snapshot, as the state after
   * command `n`, and opens it. A replica that is too far behind its primary
   * starts again this way.
   */
  static restore(dir: string, snapshot: BookSnapshot, n: number, options: DurableOptions = {}): DurableOrderBook {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) if (/^(journal-|snapshot-)/.test(f)) rmSync(join(dir, f));
    writeAtomically(join(dir, snapshotName(n)), encodeChecked(JSON.stringify(snapshot)));
    return DurableOrderBook.open(dir, options);
  }

  /** Journals the command, then applies it. */
  apply(command: EngineCommand): EngineEvent[] {
    const n = this.lastN + 1;
    const record = encodeRecord(n, command);
    this.lastN = n;
    if (this.fsync === "batch") {
      // Group commit: one write and one fsync per batch. Nothing in the batch
      // has been acknowledged yet, so holding it in memory loses nothing promised.
      this.pending.push(record);
      if (this.pending.length >= this.batchSize) this.sync();
    } else {
      writeSync(this.fd, record);
      if (this.fsync === "always") this.sync();
      else this.durableN = n;
    }
    return this.inner.apply(command);
  }

  /** Forces everything applied so far to disk. */
  sync(): void {
    if (this.pending.length > 0) {
      writeSync(this.fd, Buffer.concat(this.pending));
      this.pending = [];
    }
    fsyncSync(this.fd);
    this.durableN = this.lastN;
  }

  /** Saves the full state, starts a new journal segment, and prunes old files. */
  snapshot(): void {
    this.sync();
    const n = this.lastN;
    writeAtomically(join(this.dir, snapshotName(n)), encodeChecked(JSON.stringify(this.inner.snapshot())));

    if (this.segmentStart !== n + 1) {
      closeSync(this.fd);
      this.segmentStart = n + 1;
      this.fd = openSync(join(this.dir, segmentName(this.segmentStart)), "a");
    }
    this.prune();
  }

  close(): void {
    this.sync();
    closeSync(this.fd);
  }

  get book(): ReadonlyOrderBook {
    return this.inner;
  }

  /** Number of the last command applied. */
  get lastCommand(): number {
    return this.lastN;
  }

  /** Commands up to this number are safely on disk and may be acknowledged. */
  get durableCommand(): number {
    return this.durableN;
  }

  private prune(): void {
    const snapshots = listNumbered(this.dir, "snapshot-", ".json");
    const kept = snapshots.slice(-this.keepSnapshots);
    for (const old of snapshots.slice(0, -this.keepSnapshots)) rmSync(old.path);
    const oldestKept = kept[0];
    if (oldestKept === undefined) return;
    // A segment ends just before the next one starts. It can go once every
    // command in it is covered by the oldest snapshot we keep. The current
    // (last) segment has no successor, so it is never deleted.
    const segments = listNumbered(this.dir, "journal-", ".log");
    segments.forEach((segment, i) => {
      const next = segments[i + 1];
      if (next !== undefined && next.n <= oldestKept.n + 1) rmSync(segment.path);
    });
  }
}
