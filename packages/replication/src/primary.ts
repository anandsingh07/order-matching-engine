import { createServer, type Server, type Socket } from "node:net";
import type { EngineCommand, EngineEvent } from "@ome/core";
import type { DurableOrderBook } from "@ome/journal";
import { lines, send, type ReplicaMessage } from "./protocol.js";

export interface PrimaryOptions {
  port: number;
  host?: string;
  epoch: number;
  /**
   * sync:  a command is acknowledged once it is on disk here and on the
   *        replica. A failover can then never lose an acknowledged command,
   *        and a primary cut off from its replica cannot acknowledge anything,
   *        so a split brain cannot accept conflicting orders. Without a
   *        replica, acknowledgements wait.
   * async: acknowledged once on disk here; the replica follows behind. Keeps
   *        trading without a replica, but a failover can lose the last few
   *        acknowledged commands.
   */
  mode?: "sync" | "async";
  heartbeatMs?: number;
  /** Recent commands kept for a replica that reconnects; one further behind gets a snapshot. */
  backlog?: number;
}

interface Waiting {
  n: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * The primary side of primary/replica replication. It wraps a durable book:
 * every command is journaled and applied here, then streamed to the replica,
 * which journals and applies it too. The engine is deterministic, so the
 * same commands give the replica exactly the same state.
 */
export class Primary {
  private readonly server: Server;
  private replica: Socket | null = null;
  private replicaAcked = 0;
  private backlog: { n: number; command: EngineCommand }[] = [];
  private readonly waiting: Waiting[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private flushScheduled = false;
  private fencedBy: number | null = null;
  private readonly mode: "sync" | "async";
  private readonly backlogSize: number;

  private constructor(
    readonly book: DurableOrderBook,
    readonly epoch: number,
    options: PrimaryOptions,
    private readonly onFenced: (epoch: number) => void,
  ) {
    this.mode = options.mode ?? "sync";
    this.backlogSize = options.backlog ?? 50_000;
    this.server = createServer((socket) => this.accept(socket));
    this.timer = setInterval(() => {
      if (this.replica !== null) send(this.replica, { t: "heartbeat", n: this.book.lastCommand });
    }, options.heartbeatMs ?? 100);
  }

  static async start(book: DurableOrderBook, options: PrimaryOptions, onFenced: (epoch: number) => void = () => {}): Promise<Primary> {
    const primary = new Primary(book, options.epoch, options, onFenced);
    await new Promise<void>((resolve) => primary.server.listen(options.port, options.host ?? "127.0.0.1", resolve));
    return primary;
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  get replicaConnected(): boolean {
    return this.replica !== null;
  }

  /** Set once a replica with a higher epoch has shown up: this node must stop acting as primary. */
  get fenced(): boolean {
    return this.fencedBy !== null;
  }

  /**
   * Journals and applies a command and starts replicating it. `acknowledged`
   * resolves when the command may be confirmed to whoever sent it.
   */
  apply(command: EngineCommand): { n: number; events: EngineEvent[]; acknowledged: Promise<void> } {
    if (this.fencedBy !== null) throw new Error(`fenced: a node with epoch ${this.fencedBy} has taken over`);
    const events = this.book.apply(command);
    const n = this.book.lastCommand;
    this.backlog.push({ n, command });
    // Trim in chunks rather than one shift per command.
    if (this.backlog.length > 2 * this.backlogSize) this.backlog = this.backlog.slice(-this.backlogSize);
    if (this.replica !== null) send(this.replica, { t: "command", n, command });
    const acknowledged = new Promise<void>((resolve, reject) => this.waiting.push({ n, resolve, reject }));
    this.scheduleFlush();
    return { n, events, acknowledged };
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.replica?.destroy();
    for (const w of this.waiting.splice(0)) w.reject(new Error("primary closed"));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Group commit: one fsync for everything applied in this turn of the event loop. */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.book.durableCommand < this.book.lastCommand) this.book.sync();
      this.settle();
    });
  }

  private settle(): void {
    const safe = Math.min(this.book.durableCommand, this.mode === "sync" ? this.replicaAcked : Infinity);
    while (this.waiting.length > 0 && this.waiting[0]!.n <= safe) this.waiting.shift()!.resolve();
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.replica === socket) this.replica = null;
    });
    socket.on(
      "data",
      lines<ReplicaMessage>((message) => {
        if (message.t === "hello") this.hello(socket, message.epoch, message.last);
        else if (socket === this.replica) {
          this.replicaAcked = Math.max(this.replicaAcked, message.n);
          this.settle();
        }
      }),
    );
  }

  private hello(socket: Socket, epoch: number, last: number): void {
    if (epoch > this.epoch) {
      // The replica has been promoted since this node was primary: step down.
      this.fencedBy = epoch;
      for (const w of this.waiting.splice(0)) w.reject(new Error(`fenced: a node with epoch ${epoch} has taken over`));
      socket.destroy();
      this.onFenced(epoch);
      return;
    }
    this.replica?.destroy(); // the newest replica connection wins
    this.replica = socket;
    send(socket, { t: "welcome", epoch: this.epoch });
    const oldest = this.backlog[0]?.n ?? this.book.lastCommand + 1;
    // A replica from an older epoch may hold commands that were never
    // acknowledged and that this primary does not have. Whatever it says it
    // has, it starts again from a snapshot, as does one too far behind.
    // Acknowledgements count for the replica connected now, and only for what it actually holds.
    if (epoch < this.epoch || last > this.book.lastCommand || last < oldest - 1) {
      this.replicaAcked = 0;
      send(socket, { t: "snapshot", n: this.book.lastCommand, snapshot: this.book.book.snapshot() });
    } else {
      this.replicaAcked = last;
      for (const r of this.backlog) if (r.n > last) send(socket, { t: "command", n: r.n, command: r.command });
    }
    // Everything applied from here on is streamed live, in order, by apply().
  }
}
