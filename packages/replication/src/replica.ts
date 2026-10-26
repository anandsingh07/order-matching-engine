import { connect, type Socket } from "node:net";
import { DurableOrderBook, type DurableOptions } from "@ome/journal";
import { lines, readEpoch, send, writeEpoch, type PrimaryMessage } from "./protocol.js";

export interface ReplicaOptions {
  port: number;
  host?: string;
  /** Silence from the primary for this long means it is gone, and this replica takes over. */
  failoverMs?: number;
  /** Delay between attempts to reach the primary. */
  retryMs?: number;
  durable?: DurableOptions;
  /** Called once, on promotion, with the book and the new epoch: start a Primary on it. */
  onPromote?: (book: DurableOrderBook, epoch: number) => void;
}

/**
 * The replica side: follows a primary, journaling and applying every command
 * it receives, and acknowledging each batch only once it is on disk. If the
 * primary falls silent, it promotes itself with a higher epoch.
 *
 * It only promotes after it has followed a primary, so two replicas started
 * together do not both take over. Telling "the primary crashed" from "the
 * network between us broke" is impossible from here; sync replication is
 * what makes a wrong guess safe (see PrimaryOptions.mode).
 */
export class Replica {
  private bookValue: DurableOrderBook;
  private epochValue: number;
  private socket: Socket | null = null;
  private accepted = false;
  private followed = false;
  private lastHeard = 0;
  private promoted = false;
  private closed = false;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly failoverMs: number;

  private constructor(
    readonly dir: string,
    private readonly options: ReplicaOptions,
  ) {
    this.bookValue = DurableOrderBook.open(dir, this.durable);
    this.epochValue = readEpoch(dir);
    this.failoverMs = options.failoverMs ?? 1_000;
    this.watchdog = setInterval(() => this.check(), Math.max(10, this.failoverMs / 4));
    this.connect();
  }

  static start(dir: string, options: ReplicaOptions): Replica {
    return new Replica(dir, options);
  }

  get book(): DurableOrderBook {
    return this.bookValue;
  }

  get epoch(): number {
    return this.epochValue;
  }

  get isPromoted(): boolean {
    return this.promoted;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retry);
    this.socket?.destroy();
    if (!this.promoted) this.bookValue.close();
  }

  private get durable(): DurableOptions {
    // Each batch received is synced before it is acknowledged (group commit).
    return { fsync: "batch", batchSize: 1_000_000, ...this.options.durable };
  }

  private connect(): void {
    if (this.closed || this.promoted) return;
    const socket = connect(this.options.port, this.options.host ?? "127.0.0.1");
    this.socket = socket;
    this.accepted = false;
    socket.setNoDelay(true);
    socket.on("connect", () => send(socket, { t: "hello", epoch: this.epochValue, last: this.bookValue.lastCommand }));
    const parse = lines<PrimaryMessage>((m) => this.handle(socket, m));
    socket.on("data", (chunk: Buffer) => {
      if (this.closed || this.promoted) return;
      const before = this.bookValue.lastCommand;
      parse(chunk);
      if (this.accepted && this.bookValue.lastCommand !== before) {
        this.bookValue.sync();
        send(socket, { t: "ack", n: this.bookValue.lastCommand });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.closed && !this.promoted) this.retry = setTimeout(() => this.connect(), this.options.retryMs ?? 100);
    });
  }

  private handle(socket: Socket, m: PrimaryMessage): void {
    if (m.t === "welcome") {
      if (m.epoch < this.epochValue) {
        socket.destroy(); // a primary from before a failover: refuse it
        return;
      }
      if (m.epoch > this.epochValue) writeEpoch(this.dir, (this.epochValue = m.epoch));
      this.accepted = true;
      this.followed = true;
    }
    if (!this.accepted) return;
    this.lastHeard = Date.now();
    if (m.t === "snapshot") {
      this.bookValue.close();
      this.bookValue = DurableOrderBook.restore(this.dir, m.snapshot, m.n, this.durable);
      send(socket, { t: "ack", n: m.n });
    } else if (m.t === "command") {
      if (m.n !== this.bookValue.lastCommand + 1) {
        socket.destroy(); // out of step: reconnect, and the primary resends or snapshots
        return;
      }
      this.bookValue.apply(m.command);
    }
  }

  private check(): void {
    if (this.promoted || this.closed || !this.followed) return;
    if (Date.now() - this.lastHeard > this.failoverMs) this.promote();
  }

  private promote(): void {
    this.promoted = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retry);
    this.socket?.destroy();
    this.bookValue.sync();
    writeEpoch(this.dir, (this.epochValue += 1));
    this.options.onPromote?.(this.bookValue, this.epochValue);
  }
}
