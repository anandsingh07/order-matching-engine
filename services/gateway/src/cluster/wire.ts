import type { Socket } from "node:net";
import type { ClientMessage, ClientOrder, ServerMessage } from "../protocol.js";

// The link between front-end processes and the core process (see pool.ts and
// frontend.ts): length-prefixed frames on a named pipe (a Unix socket
// elsewhere), each carrying every record one side produced in an event-loop
// turn.
//
//   frame:  u32 payload bytes | u32 record count | records
//   record: u8 kind | fields
//
// Batching is what makes the link cheap. Measured between two processes
// with 64-byte records: one write per record costs 19 us to send and 16 us
// to receive; 256 records per write cost 0.4 + 0.5 us each. Under load a
// turn produces many records, so the cost per message falls as load rises.
//
// Numbers are float64 (every wire number is a safe integer), strings a u32
// byte length plus UTF-8, enums one byte, and optional fields carry a
// presence byte so absent fields stay absent.
//
// The hot messages (orders in; acks, rejects and execution reports out) are
// binary, and the front-end rebuilds the reports with the same field order
// gateway.ts uses, so the JSON a client receives is byte for byte what the
// single-process gateway sends. Everything else travels as its JSON text.

/** Front-end to core. */
export const HELLO = 1;
export const ATTACH = 2;
export const DETACH = 3;
export const ORDER = 4;
export const CANCEL = 5;
export const AMEND = 6;
export const SUBSCRIBE = 7;
export const UNSUBSCRIBE = 8;
export const HTTP = 9;
export const HTTP_ABORT = 10;

/** Core to front-end. */
export const ATTACHED = 20;
export const ACK = 21;
export const REJECT = 22;
export const EXECUTION = 23;
/** One connection's message, as JSON text. */
export const MESSAGE = 24;
/** A message for every connection on the front-end (Gateway.broadcast). */
export const ALL = 25;
/** Public market data for a channel, serialized once in the core; the front-end fans it out. */
export const CHANNEL = 26;
export const CHANNEL_ADD = 27;
export const CHANNEL_REMOVE = 28;
/** The channel's symbol was delisted. */
export const CHANNEL_GONE = 29;
export const HTTP_REPLY = 30;

const SIDES = ["buy", "sell"] as const;
const ORDER_TYPES = ["limit", "market", "stop"] as const;
const TIME_IN_FORCE = ["GTC", "IOC", "FOK"] as const;
const SELF_TRADE = ["allow", "cancel_taker", "cancel_maker", "cancel_both"] as const;
const LIQUIDITY = ["maker", "taker"] as const;
/** Execution events the link encodes; any other event travels as JSON. */
const EVENTS = ["accepted", "rejected", "rested", "fill", "cancelled", "amended", "stop_pending", "triggered"] as const;

function index<T>(table: readonly T[], value: T, what: string): number {
  const i = table.indexOf(value);
  if (i === -1) throw new Error(`cannot encode ${what} ${String(value)}`);
  return i;
}

function at<T>(table: readonly T[], i: number, what: string): T {
  const value = table[i];
  if (value === undefined) throw new Error(`corrupt link frame: bad ${what} ${i}`);
  return value;
}

/** Growable output buffer for one frame. */
export class Writer {
  private buf = Buffer.allocUnsafe(64 * 1024);
  private pos = 0;

  get length(): number {
    return this.pos;
  }

  reset(): void {
    this.pos = 0;
  }

  /** A copy of what was written: the writer's buffer is reused. */
  take(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.pos));
  }

  setU32(at: number, value: number): void {
    this.buf.writeUInt32LE(value, at);
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.pos++] = value;
  }

  u32(value: number): void {
    this.ensure(4);
    this.pos = this.buf.writeUInt32LE(value, this.pos);
  }

  f64(value: number): void {
    this.ensure(8);
    this.pos = this.buf.writeDoubleLE(value, this.pos);
  }

  optionalF64(value: number | undefined): void {
    if (value === undefined) this.u8(0);
    else {
      this.u8(1);
      this.f64(value);
    }
  }

  /** Enum as one byte, 0 meaning "not set". */
  optionalEnum<T>(table: readonly T[], value: T | undefined, what: string): void {
    this.u8(value === undefined ? 0 : index(table, value, what) + 1);
  }

  str(value: string): void {
    this.ensure(4 + value.length * 3);
    const written = this.buf.write(value, this.pos + 4, "utf8");
    this.buf.writeUInt32LE(written, this.pos);
    this.pos += 4 + written;
  }

  /** A request id: a string or an integer, as the client sent it. */
  reqId(value: string | number): void {
    if (typeof value === "string") {
      this.u8(0);
      this.str(value);
    } else {
      this.u8(1);
      this.f64(value);
    }
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
}

export class Reader {
  private pos: number;

  constructor(
    private readonly buf: Buffer,
    start: number,
    private readonly end: number,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  u32(): number {
    this.need(4);
    const value = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return value;
  }

  optionalF64(): number | undefined {
    return this.u8() === 0 ? undefined : this.f64();
  }

  optionalEnum<T>(table: readonly T[], what: string): T | undefined {
    const i = this.u8();
    return i === 0 ? undefined : at(table, i - 1, what);
  }

  str(): string {
    const length = this.u32();
    this.need(length);
    const start = this.pos;
    this.pos += length;
    return this.buf.toString("utf8", start, this.pos);
  }

  reqId(): string | number {
    return this.u8() === 0 ? this.str() : this.f64();
  }

  private need(bytes: number): void {
    if (this.pos + bytes > this.end) throw new Error("corrupt link frame: record runs past the frame");
  }
}

// ---- trading requests (front-end -> core) ----

export type TradeMessage = Extract<ClientMessage, { op: "order" | "cancel" | "amend" }>;

/** Writes an order, cancel or amend for connection `conn`. */
export function writeTrade(w: Writer, conn: number, m: TradeMessage): void {
  w.u32(conn);
  w.reqId(m.reqId);
  w.str(m.symbol);
  w.str(m.clientOrderId);
  if (m.op === "order") {
    const o = m.order;
    w.u8(index(ORDER_TYPES, o.type, "order type"));
    w.u8(index(SIDES, o.side, "side"));
    w.f64(o.quantity);
    if (o.type === "limit") {
      w.f64(o.price);
      w.optionalF64(o.displayQuantity);
    } else if (o.type === "stop") {
      w.f64(o.stopPrice);
      w.optionalF64(o.limitPrice);
    }
    w.optionalEnum<string>(TIME_IN_FORCE, o.timeInForce, "time in force");
    w.optionalEnum<string>(SELF_TRADE, o.selfTrade, "self-trade policy");
  } else if (m.op === "amend") {
    w.optionalF64(m.price);
    w.optionalF64(m.quantity);
  }
}

/** Reads what writeTrade wrote for record `kind` (ORDER, CANCEL or AMEND). */
export function readTrade(r: Reader, kind: number): { conn: number; message: TradeMessage } {
  const conn = r.u32();
  const reqId = r.reqId();
  const symbol = r.str();
  const clientOrderId = r.str();
  if (kind === CANCEL) return { conn, message: { op: "cancel", reqId, symbol, clientOrderId } };
  if (kind === AMEND) {
    const price = r.optionalF64();
    const quantity = r.optionalF64();
    return {
      conn,
      message: {
        op: "amend",
        reqId,
        symbol,
        clientOrderId,
        ...(price === undefined ? {} : { price }),
        ...(quantity === undefined ? {} : { quantity }),
      },
    };
  }
  const type = at(ORDER_TYPES, r.u8(), "order type");
  const side = at(SIDES, r.u8(), "side");
  const quantity = r.f64();
  let order: ClientOrder;
  if (type === "limit") {
    order = { type, side, price: r.f64(), quantity };
    const displayQuantity = r.optionalF64();
    if (displayQuantity !== undefined) order.displayQuantity = displayQuantity;
  } else if (type === "stop") {
    order = { type, side, quantity, stopPrice: r.f64() };
    const limitPrice = r.optionalF64();
    if (limitPrice !== undefined) order.limitPrice = limitPrice;
  } else {
    order = { type, side, quantity };
  }
  const timeInForce = r.optionalEnum(TIME_IN_FORCE, "time in force");
  if (timeInForce !== undefined) (order as { timeInForce?: string }).timeInForce = timeInForce;
  const selfTrade = r.optionalEnum(SELF_TRADE, "self-trade policy");
  if (selfTrade !== undefined) order.selfTrade = selfTrade;
  return { conn, message: { op: "order", reqId, symbol, clientOrderId, order } };
}

// ---- replies (core -> front-end) ----

type Ack = Extract<ServerMessage, { type: "ack" }>;
type Reject = Extract<ServerMessage, { type: "reject" }>;
type ExecutionMessage = Extract<ServerMessage, { type: "execution" }>;

/** Whether writeReply can encode this message in binary; other messages go as JSON (MESSAGE). */
export function isBinaryReply(m: ServerMessage): m is Ack | Reject | ExecutionMessage {
  return m.type === "ack" || m.type === "reject" || (m.type === "execution" && (EVENTS as readonly string[]).includes(m.event));
}

/** The record kind writeReply uses for `m`. */
export function replyKind(m: Ack | Reject | ExecutionMessage): number {
  return m.type === "ack" ? ACK : m.type === "reject" ? REJECT : EXECUTION;
}

export function writeReply(w: Writer, conn: number, m: Ack | Reject | ExecutionMessage): void {
  w.u32(conn);
  if (m.type === "ack") {
    w.reqId(m.reqId);
    w.str(m.clientOrderId);
    return;
  }
  if (m.type === "reject") {
    w.reqId(m.reqId);
    if (m.clientOrderId === undefined) w.u8(0);
    else {
      w.u8(1);
      w.str(m.clientOrderId);
    }
    w.str(m.reason);
    return;
  }
  w.str(m.symbol);
  w.str(m.clientOrderId);
  w.f64(m.time);
  w.u8(index<string>(EVENTS, m.event, "execution event"));
  switch (m.event) {
    case "accepted":
      break;
    case "rejected":
      w.str(m.reason);
      break;
    case "rested":
      w.u8(index(SIDES, m.side, "side"));
      w.f64(m.price);
      w.f64(m.quantity);
      w.f64(m.visible);
      break;
    case "fill":
      w.u8(index(SIDES, m.side, "side"));
      w.f64(m.price);
      w.f64(m.quantity);
      w.u8(index(LIQUIDITY, m.liquidity, "liquidity"));
      break;
    case "cancelled":
      w.f64(m.remaining);
      w.str(m.reason);
      break;
    case "amended":
      w.f64(m.price);
      w.f64(m.quantity);
      w.u8(m.keptPriority ? 1 : 0);
      break;
    case "stop_pending":
      w.u8(index(SIDES, m.side, "side"));
      w.f64(m.stopPrice);
      w.f64(m.quantity);
      break;
    case "triggered":
      w.f64(m.lastPrice);
      break;
  }
}

/** Rebuilds a reply with the field order gateway.ts gives it, so its JSON is identical. */
export function readReply(r: Reader, kind: number): { conn: number; message: ServerMessage } {
  const conn = r.u32();
  if (kind === ACK) {
    const reqId = r.reqId();
    return { conn, message: { type: "ack", reqId, clientOrderId: r.str() } };
  }
  if (kind === REJECT) {
    const reqId = r.reqId();
    const clientOrderId = r.u8() === 0 ? undefined : r.str();
    const reason = r.str();
    return { conn, message: clientOrderId === undefined ? { type: "reject", reqId, reason } : { type: "reject", reqId, clientOrderId, reason } };
  }
  const symbol = r.str();
  const clientOrderId = r.str();
  const time = r.f64();
  const event = at(EVENTS, r.u8(), "execution event");
  const head = { type: "execution", symbol, clientOrderId, time } as const;
  let message: ExecutionMessage;
  switch (event) {
    case "accepted":
      message = { ...head, event };
      break;
    case "rejected":
      message = { ...head, event, reason: r.str() } as ExecutionMessage;
      break;
    case "rested":
      message = { ...head, event, side: at(SIDES, r.u8(), "side"), price: r.f64(), quantity: r.f64(), visible: r.f64() };
      break;
    case "fill":
      message = { ...head, event, side: at(SIDES, r.u8(), "side"), price: r.f64(), quantity: r.f64(), liquidity: at(LIQUIDITY, r.u8(), "liquidity") };
      break;
    case "cancelled":
      message = { ...head, event, remaining: r.f64(), reason: r.str() } as ExecutionMessage;
      break;
    case "amended":
      message = { ...head, event, price: r.f64(), quantity: r.f64(), keptPriority: r.u8() === 1 };
      break;
    case "stop_pending":
      message = { ...head, event, side: at(SIDES, r.u8(), "side"), stopPrice: r.f64(), quantity: r.f64() };
      break;
    case "triggered":
      message = { ...head, event, lastPrice: r.f64() };
      break;
  }
  return { conn, message };
}

// ---- the link ----

/** Frames longer than this are refused as corrupt. */
const MAX_FRAME = 256 << 20;

/**
 * One end of a link. Records are appended with `begin(kind)` and the
 * fields that follow; everything begun in a turn goes out as one frame from
 * setImmediate. Incoming frames are reassembled from the stream (a frame may
 * arrive in many chunks, or many frames in one) and handed to `onRecord`
 * record by record. A record that does not decode closes the link.
 */
export class Link {
  readonly w = new Writer();
  private records = 0;
  private scheduled = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** Bytes the pending data must reach before it can be parsed. */
  private need = 0;
  framesOut = 0;
  recordsOut = 0;

  constructor(
    readonly socket: Socket,
    private readonly onRecord: (r: Reader, kind: number) => void,
    private readonly onError: (error: Error) => void = () => socket.destroy(),
  ) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  /** Starts a record; write its fields into `w` before anything else is begun. */
  begin(kind: number): Writer {
    if (this.records === 0) {
      this.w.reset();
      this.w.u32(0); // payload bytes, filled in by flush
      this.w.u32(0); // record count
      if (!this.scheduled) {
        this.scheduled = true;
        setImmediate(() => this.flush());
      }
    }
    this.records++;
    this.w.u8(kind);
    return this.w;
  }

  /** Writes what has been begun as one frame now (normally done once per turn). */
  flush(): void {
    this.scheduled = false;
    if (this.records === 0) return;
    this.w.setU32(0, this.w.length - 4);
    this.w.setU32(4, this.records);
    this.recordsOut += this.records;
    this.framesOut++;
    this.records = 0;
    if (!this.socket.destroyed) this.socket.write(this.w.take());
  }

  /** Feeds raw bytes from the stream (exported for tests). */
  receive(chunk: Buffer): void {
    if (this.pending.length > 0) {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      if (this.pendingBytes < this.need) return;
      chunk = Buffer.concat(this.pending, this.pendingBytes);
      this.pending = [];
      this.pendingBytes = 0;
    }
    let off = 0;
    try {
      while (chunk.length - off >= 4) {
        const length = chunk.readUInt32LE(off);
        if (length < 4 || length > MAX_FRAME) throw new Error(`corrupt link frame: length ${length}`);
        if (chunk.length - off - 4 < length) break;
        const end = off + 4 + length;
        const r = new Reader(chunk, off + 4, end);
        for (let n = r.u32(); n > 0; n--) this.onRecord(r, r.u8());
        if (!r.done) throw new Error("corrupt link frame: bytes left over");
        off = end;
      }
    } catch (error) {
      this.pending = [];
      this.pendingBytes = 0;
      this.onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (off < chunk.length) {
      const rest = chunk.subarray(off);
      this.pending = [rest];
      this.pendingBytes = rest.length;
      this.need = rest.length >= 4 ? 4 + rest.readUInt32LE(0) : 4;
    }
  }
}
