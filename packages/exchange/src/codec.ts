import type {
  AmendInput,
  BookSnapshot,
  CancelReason,
  DepthLevel,
  EngineCommand,
  EngineEvent,
  OrderInput,
  RejectReason,
  SelfTradePrevention,
  Side,
  TimeInForce,
  TradingPhase,
} from "@ome/core";
import type { Reply, Request } from "./protocol.js";

// Compact binary encoding for ring-buffer messages.
//
// JSON was 35% of the main thread's CPU in profiling. This codec writes numbers
// as little-endian float64 (every engine number is a safe integer or an
// invalid input that must survive unchanged, such as 1.5 or NaN), strings as
// a u32 byte length plus UTF-8 with an ASCII fast path, and enums as one byte.
// Optional fields carry a presence byte, and absent fields stay absent after
// decoding, so a decoded value has exactly the shape that was encoded.

const SIDES: readonly Side[] = ["buy", "sell"];
const ORDER_TYPES = ["limit", "market", "stop"] as const;
const TIME_IN_FORCE: readonly TimeInForce[] = ["GTC", "IOC", "FOK"];
const SELF_TRADE: readonly SelfTradePrevention[] = ["allow", "cancel_taker", "cancel_maker", "cancel_both"];
const REJECT_REASONS: readonly RejectReason[] = [
  "duplicate_id",
  "invalid_quantity",
  "invalid_price",
  "invalid_display_quantity",
  "invalid_stop_price",
  "unknown_order",
  "not_amendable",
  "not_allowed_in_auction",
];
const PHASES: readonly TradingPhase[] = ["continuous", "auction"];
const CANCEL_REASONS: readonly CancelReason[] = ["user", "unfilled_remainder", "fok_unfillable", "self_trade"];
const EVENT_TYPES = [
  "accepted",
  "rejected",
  "trade",
  "rested",
  "cancelled",
  "amended",
  "stop_pending",
  "triggered",
  "phase",
] as const satisfies readonly EngineEvent["type"][];
// New kinds go at the end, so existing ones keep their byte values.
const REQUEST_KINDS = ["command", "snapshot", "checkpoint", "shutdown", "depth", "indicative", "list", "delist"] as const satisfies readonly Request["kind"][];
const COMMAND_TYPES = ["submit", "cancel", "amend", "start_auction", "uncross"] as const satisfies readonly EngineCommand["type"][];

const REPLY_EVENTS = 0;
const REPLY_SNAPSHOT = 1;
const REPLY_ERROR = 2;
const REPLY_ACK = 3;
const REPLY_DEPTH = 4;
const REPLY_INDICATIVE = 5;

function writeLevels(w: Writer, levels: readonly DepthLevel[]): void {
  w.u32(levels.length);
  for (const level of levels) {
    w.f64(level.price);
    w.f64(level.quantity);
    w.f64(level.orders);
  }
}

function readLevels(r: Reader): DepthLevel[] {
  const out: DepthLevel[] = [];
  for (let n = r.u32(); n > 0; n--) out.push({ price: r.f64(), quantity: r.f64(), orders: r.f64() });
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function indexOf<T>(table: readonly T[], value: T, what: string): number {
  const i = table.indexOf(value);
  if (i === -1) throw new Error(`cannot encode ${what} ${String(value)}`);
  return i;
}

function at<T>(table: readonly T[], i: number, what: string): T {
  const value = table[i];
  if (value === undefined) throw new Error(`corrupt message: bad ${what} ${i}`);
  return value;
}

/** Growable output buffer. `bytes()` is a view that is only valid until the next write. */
export class Writer {
  private buf = new Uint8Array(64 * 1024);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  reset(): this {
    this.pos = 0;
    return this;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.pos++] = value;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, value, true);
    this.pos += 4;
  }

  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, value, true);
    this.pos += 8;
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
    this.u8(value === undefined ? 0 : indexOf(table, value, what) + 1);
  }

  str(value: string): void {
    const length = value.length;
    this.ensure(4 + length * 3);
    const start = this.pos + 4;
    let i = 0;
    for (; i < length; i++) {
      const c = value.charCodeAt(i);
      if (c > 0x7f) break;
      this.buf[start + i] = c;
    }
    const written = i === length ? length : textEncoder.encodeInto(value, this.buf.subarray(start)).written;
    this.view.setUint32(this.pos, written, true);
    this.pos = start + written;
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
}

export class Reader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  u32(): number {
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  f64(): number {
    const value = this.view.getFloat64(this.pos, true);
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
    const start = this.pos;
    this.pos += length;
    if (length <= 64) {
      let ascii = true;
      for (let i = start; i < this.pos; i++) {
        if (this.buf[i]! > 0x7f) {
          ascii = false;
          break;
        }
      }
      if (ascii) return String.fromCharCode.apply(null, this.buf.subarray(start, this.pos) as unknown as number[]);
    }
    return textDecoder.decode(this.buf.subarray(start, this.pos));
  }
}

// ---- commands ----

function writeOrder(w: Writer, order: OrderInput): void {
  w.u8(indexOf(ORDER_TYPES, order.type, "order type"));
  w.str(order.id);
  w.str(order.traderId);
  w.u8(indexOf(SIDES, order.side, "side"));
  w.f64(order.quantity);
  w.optionalEnum(SELF_TRADE, order.selfTrade, "self-trade policy");
  w.optionalEnum(TIME_IN_FORCE, order.timeInForce, "time in force");
  if (order.type === "limit") {
    w.f64(order.price);
    w.optionalF64(order.displayQuantity);
  } else if (order.type === "stop") {
    w.f64(order.stopPrice);
    w.optionalF64(order.limitPrice);
  }
}

function readOrder(r: Reader): OrderInput {
  const type = at(ORDER_TYPES, r.u8(), "order type");
  const id = r.str();
  const traderId = r.str();
  const side = at(SIDES, r.u8(), "side");
  const quantity = r.f64();
  const selfTrade = r.optionalEnum(SELF_TRADE, "self-trade policy");
  const timeInForce = r.optionalEnum(TIME_IN_FORCE, "time in force");
  let order: OrderInput;
  if (type === "limit") {
    order = { type, id, traderId, side, quantity, price: r.f64() };
    const display = r.optionalF64();
    if (display !== undefined) order.displayQuantity = display;
    if (timeInForce !== undefined) order.timeInForce = timeInForce;
  } else if (type === "stop") {
    order = { type, id, traderId, side, quantity, stopPrice: r.f64() };
    const limitPrice = r.optionalF64();
    if (limitPrice !== undefined) order.limitPrice = limitPrice;
    if (timeInForce !== undefined) order.timeInForce = timeInForce;
  } else {
    order = { type, id, traderId, side, quantity };
    if (timeInForce !== undefined) order.timeInForce = timeInForce as "IOC" | "FOK";
  }
  if (selfTrade !== undefined) order.selfTrade = selfTrade;
  return order;
}

function writeCommand(w: Writer, command: EngineCommand): void {
  w.u8(indexOf(COMMAND_TYPES, command.type, "command type"));
  switch (command.type) {
    case "submit":
      writeOrder(w, command.order);
      return;
    case "cancel":
      w.str(command.orderId);
      return;
    case "amend":
      w.str(command.orderId);
      w.optionalF64(command.changes.price);
      w.optionalF64(command.changes.quantity);
      return;
    case "start_auction":
    case "uncross":
      return;
  }
}

function readCommand(r: Reader): EngineCommand {
  const type = at(COMMAND_TYPES, r.u8(), "command type");
  if (type === "submit") return { type, order: readOrder(r) };
  if (type === "start_auction" || type === "uncross") return { type };
  const orderId = r.str();
  if (type === "cancel") return { type, orderId };
  const changes: AmendInput = {};
  const price = r.optionalF64();
  const quantity = r.optionalF64();
  if (price !== undefined) changes.price = price;
  if (quantity !== undefined) changes.quantity = quantity;
  return { type, orderId, changes };
}

// ---- events ----

function writeEvent(w: Writer, e: EngineEvent): void {
  w.u8(indexOf(EVENT_TYPES, e.type, "event type"));
  w.f64(e.seq);
  if (e.type !== "trade" && e.type !== "phase") w.str(e.orderId);
  switch (e.type) {
    case "accepted":
      return;
    case "rejected":
      w.u8(indexOf(REJECT_REASONS, e.reason, "reject reason"));
      return;
    case "trade":
      w.f64(e.price);
      w.f64(e.quantity);
      w.str(e.makerOrderId);
      w.str(e.makerTraderId);
      w.str(e.takerOrderId);
      w.str(e.takerTraderId);
      w.u8(indexOf(SIDES, e.takerSide, "side"));
      return;
    case "rested":
      w.u8(indexOf(SIDES, e.side, "side"));
      w.f64(e.price);
      w.f64(e.quantity);
      w.f64(e.visible);
      return;
    case "cancelled":
      w.f64(e.remaining);
      w.u8(indexOf(CANCEL_REASONS, e.reason, "cancel reason"));
      return;
    case "amended":
      w.f64(e.price);
      w.f64(e.quantity);
      w.u8(e.keptPriority ? 1 : 0);
      return;
    case "stop_pending":
      w.u8(indexOf(SIDES, e.side, "side"));
      w.f64(e.stopPrice);
      w.f64(e.quantity);
      return;
    case "triggered":
      w.f64(e.lastPrice);
      return;
    case "phase":
      w.u8(indexOf(PHASES, e.phase, "phase"));
      w.optionalF64(e.price ?? undefined);
      w.f64(e.volume);
  }
}

function readEvent(r: Reader): EngineEvent {
  const type = at(EVENT_TYPES, r.u8(), "event type");
  const seq = r.f64();
  const orderId = type === "trade" || type === "phase" ? "" : r.str();
  switch (type) {
    case "accepted":
      return { type, seq, orderId };
    case "rejected":
      return { type, seq, orderId, reason: at(REJECT_REASONS, r.u8(), "reject reason") };
    case "trade":
      return {
        type,
        seq,
        price: r.f64(),
        quantity: r.f64(),
        makerOrderId: r.str(),
        makerTraderId: r.str(),
        takerOrderId: r.str(),
        takerTraderId: r.str(),
        takerSide: at(SIDES, r.u8(), "side"),
      };
    case "rested":
      return { type, seq, orderId, side: at(SIDES, r.u8(), "side"), price: r.f64(), quantity: r.f64(), visible: r.f64() };
    case "cancelled":
      return { type, seq, orderId, remaining: r.f64(), reason: at(CANCEL_REASONS, r.u8(), "cancel reason") };
    case "amended":
      return { type, seq, orderId, price: r.f64(), quantity: r.f64(), keptPriority: r.u8() === 1 };
    case "stop_pending":
      return { type, seq, orderId, side: at(SIDES, r.u8(), "side"), stopPrice: r.f64(), quantity: r.f64() };
    case "triggered":
      return { type, seq, orderId, lastPrice: r.f64() };
    case "phase":
      return { type, seq, phase: at(PHASES, r.u8(), "phase"), price: r.optionalF64() ?? null, volume: r.f64() };
  }
}

// ---- batches ----

const shared = new Writer();

/** Encodes into a shared buffer; the result is only valid until the next encode call. */
export function encodeRequests(requests: readonly Request[]): Uint8Array {
  const w = shared.reset();
  w.u32(requests.length);
  for (const request of requests) {
    w.u8(indexOf(REQUEST_KINDS, request.kind, "request kind"));
    w.f64(request.id);
    if (request.kind === "command") {
      w.str(request.symbol);
      writeCommand(w, request.command);
    } else if (request.kind === "snapshot" || request.kind === "indicative" || request.kind === "list" || request.kind === "delist") {
      w.str(request.symbol);
    } else if (request.kind === "depth") {
      w.str(request.symbol);
      w.u32(request.levels);
    }
  }
  return w.bytes();
}

export function decodeRequests(bytes: Uint8Array): Request[] {
  const r = new Reader(bytes);
  const out: Request[] = [];
  for (let n = r.u32(); n > 0; n--) {
    const kind = at(REQUEST_KINDS, r.u8(), "request kind");
    const id = r.f64();
    if (kind === "command") {
      const symbol = r.str();
      out.push({ kind, id, symbol, command: readCommand(r) });
    } else if (kind === "snapshot" || kind === "indicative" || kind === "list" || kind === "delist") out.push({ kind, id, symbol: r.str() });
    else if (kind === "depth") out.push({ kind, id, symbol: r.str(), levels: r.u32() });
    else out.push({ kind, id });
  }
  return out;
}

/** Encodes into a shared buffer; the result is only valid until the next encode call. */
export function encodeReplies(replies: readonly Reply[]): Uint8Array {
  const w = shared.reset();
  w.u32(replies.length);
  for (const reply of replies) {
    if ("events" in reply) {
      w.u8(REPLY_EVENTS);
      w.f64(reply.id);
      w.u32(reply.events.length);
      for (const e of reply.events) writeEvent(w, e);
    } else if ("snapshot" in reply) {
      // Rare and large: JSON keeps the snapshot format in one place.
      w.u8(REPLY_SNAPSHOT);
      w.f64(reply.id);
      w.str(JSON.stringify(reply.snapshot));
    } else if ("depth" in reply) {
      w.u8(REPLY_DEPTH);
      w.f64(reply.id);
      writeLevels(w, reply.depth.bids);
      writeLevels(w, reply.depth.asks);
    } else if ("indicative" in reply) {
      w.u8(REPLY_INDICATIVE);
      w.f64(reply.id);
      w.u8(reply.indicative === null ? 0 : 1);
      if (reply.indicative !== null) {
        w.f64(reply.indicative.price);
        w.f64(reply.indicative.volume);
        w.f64(reply.indicative.imbalance);
      }
    } else if ("error" in reply) {
      w.u8(REPLY_ERROR);
      w.f64(reply.id);
      w.str(reply.error);
    } else {
      w.u8(REPLY_ACK);
      w.f64(reply.id);
    }
  }
  return w.bytes();
}

export function decodeReplies(bytes: Uint8Array): Reply[] {
  const r = new Reader(bytes);
  const out: Reply[] = [];
  for (let n = r.u32(); n > 0; n--) {
    const kind = r.u8();
    const id = r.f64();
    if (kind === REPLY_EVENTS) {
      const events: EngineEvent[] = [];
      for (let k = r.u32(); k > 0; k--) events.push(readEvent(r));
      out.push({ id, events });
    } else if (kind === REPLY_SNAPSHOT) out.push({ id, snapshot: JSON.parse(r.str()) as BookSnapshot });
    else if (kind === REPLY_DEPTH) out.push({ id, depth: { bids: readLevels(r), asks: readLevels(r) } });
    else if (kind === REPLY_INDICATIVE) {
      out.push({ id, indicative: r.u8() === 0 ? null : { price: r.f64(), volume: r.f64(), imbalance: r.f64() } });
    }
    else if (kind === REPLY_ERROR) out.push({ id, error: r.str() });
    else if (kind === REPLY_ACK) out.push({ id });
    else throw new Error(`corrupt message: bad reply kind ${kind}`);
  }
  return out;
}
