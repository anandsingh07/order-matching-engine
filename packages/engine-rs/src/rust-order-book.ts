import type {
  AmendInput,
  AuctionResult,
  BookSnapshot,
  CancelReason,
  Depth,
  DepthLevel,
  EngineCommand,
  EngineEvent,
  OrderInput,
  OrderView,
  RejectReason,
  RestingOrderSnapshot,
  SelfTradePrevention,
  Side,
  StopOrderSnapshot,
  StopOrderView,
  TimeInForce,
  TradingPhase,
} from "@ome/core";
import * as P from "./protocol.js";
import { instantiate, type EngineExports } from "./wasm.js";

// Enum tables in the order of the Rust constants (rust/src/protocol.rs).
const SIDES: readonly Side[] = ["buy", "sell"];
const TIFS: readonly TimeInForce[] = ["GTC", "IOC", "FOK"];
const SELF_TRADE: readonly SelfTradePrevention[] = ["allow", "cancel_taker", "cancel_maker", "cancel_both"];
const PHASES: readonly TradingPhase[] = ["continuous", "auction"];
const REJECT: readonly RejectReason[] = [
  "not_allowed_in_auction",
  "duplicate_id",
  "invalid_quantity",
  "invalid_price",
  "invalid_display_quantity",
  "invalid_stop_price",
  "unknown_order",
  "not_amendable",
];
const CANCEL: readonly CancelReason[] = ["user", "unfilled_remainder", "fok_unfillable", "self_trade"];

/**
 * A field value as the engine's validation should see it. The TypeScript
 * engine rejects anything `Number.isSafeInteger` refuses, including
 * non-numbers; a Float64Array would silently turn null into 0 and "5" into 5.
 */
const num = (value: unknown): number => (typeof value === "number" ? value : NaN);

/**
 * Enum strings outside the TypeScript types are a caller bug, and they are
 * refused here rather than mapped. The TypeScript engine has no defined
 * behaviour for them to copy: it trades "SELL" as a sell but echoes "SELL"
 * in its events, keeps an unknown time in force verbatim in a stop's
 * snapshot, and loops forever when an unknown self-trade policy meets the
 * trader's own order. A silent mapping would make the two engines differ
 * without anyone noticing. The gateway validates every enum before any engine.
 */
function outOfType(field: string, value: unknown): never {
  throw new TypeError(`Invalid ${field} ${JSON.stringify(value)}`);
}

const sideCode = (side: Side): number => (side === "buy" ? 0 : side === "sell" ? 1 : outOfType("side", side));

// Absent (or null, which `??` also treats as absent in the TypeScript engine).
const tifCode = (tif: TimeInForce | undefined): number =>
  tif == null ? P.TIF_ABSENT : tif === "GTC" ? P.GTC : tif === "IOC" ? P.IOC : tif === "FOK" ? P.FOK : outOfType("timeInForce", tif);

function selfTradeCode(policy: SelfTradePrevention | undefined): number {
  const code = SELF_TRADE.indexOf(policy ?? "allow");
  return code >= 0 ? code : outOfType("selfTrade", policy);
}

const priceOrNull = (price: number): number | null => (Number.isNaN(price) ? null : price);

/**
 * The @ome/core OrderBook API, backed by the Rust engine compiled to
 * WebAssembly. Same commands, same events (to the key order), same
 * snapshots, which the differential tests check event by event.
 *
 * Strings never cross into wasm. Order and trader ids are interned here to
 * integer handles; a command is written into a fixed block of linear memory
 * and run with one argument-free call; events come back as f64 records and
 * become the same objects the TypeScript engine returns.
 *
 * Order handles are recycled: after every command the engine reports which
 * handles' orders are gone, and only live ids stay in the map. Keeping every
 * id ever seen would be the unbounded memory the TypeScript engine removed.
 */
export class RustOrderBook {
  private readonly wasm: EngineExports;
  /** Byte offset of the shared Io block. */
  private readonly io: number;
  private f64 = new Float64Array(0);
  private u32 = new Uint32Array(0);

  /** Order handle -> id (live orders, plus the ids of the command in flight). */
  private readonly ids: string[] = [];
  private readonly handles = new Map<string, number>();
  private readonly spareHandles: number[] = [];
  /** Traders are few and long-lived, so their handles are kept, as the TypeScript pool keeps trader numbers. */
  private readonly traders: string[] = [];
  private readonly traderHandles = new Map<string, number>();

  constructor() {
    this.wasm = instantiate();
    this.io = this.wasm.io_ptr();
  }

  static fromSnapshot(snapshot: BookSnapshot): RustOrderBook {
    if (snapshot.version !== 1) throw new Error(`Unsupported snapshot version ${String(snapshot.version)}`);
    const book = new RustOrderBook();
    const w = book.wasm;
    w.restore_state(snapshot.phase === "auction" ? 1 : 0, snapshot.seq, snapshot.arrival, snapshot.lastPrice ?? NaN);
    for (const o of [...snapshot.bids, ...snapshot.asks]) {
      const display = o.display ?? -1;
      w.restore_order(book.handle(o.id), book.trader(o.traderId), sideCode(o.side), o.price, o.visible, o.hidden, display, selfTradeCode(o.selfTrade));
    }
    for (const s of snapshot.stops) {
      const { stopPrice, quantity, arrival } = s;
      const limitPrice = s.limitPrice ?? NaN;
      w.restore_stop(book.handle(s.id), book.trader(s.traderId), sideCode(s.side), stopPrice, limitPrice, quantity, tifCode(s.timeInForce), selfTradeCode(s.selfTrade), arrival);
    }
    return book;
  }

  apply(command: EngineCommand): EngineEvent[] {
    switch (command.type) {
      case "submit":
        return this.submit(command.order);
      case "cancel":
        return this.cancel(command.orderId);
      case "amend":
        return this.amend(command.orderId, command.changes);
      case "start_auction":
        return this.startAuction();
      case "uncross":
        return this.uncross();
    }
  }

  get phase(): TradingPhase {
    return PHASES[this.wasm.phase()]!;
  }

  startAuction(): EngineEvent[] {
    this.view()[this.io >> 3] = P.header(P.OP_START_AUCTION);
    return this.run();
  }

  uncross(): EngineEvent[] {
    this.view()[this.io >> 3] = P.header(P.OP_UNCROSS);
    return this.run();
  }

  indicativeAuction(): AuctionResult | null {
    if (this.wasm.indicative_auction() === 0) return null;
    const f = this.view();
    const i = this.outIndex();
    return { price: f[i]!, volume: f[i + 1]!, imbalance: f[i + 2]! };
  }

  snapshot(): BookSnapshot {
    this.wasm.snapshot();
    const f = this.view();
    let i = this.outIndex();
    const phase = PHASES[f[i]!]!;
    const seq = f[i + 1]!;
    const arrival = f[i + 2]!;
    const lastPrice = priceOrNull(f[i + 3]!);
    const bidCount = f[i + 4]!;
    const askCount = f[i + 5]!;
    const stopCount = f[i + 6]!;
    i += 7;
    const resting = (count: number): RestingOrderSnapshot[] => {
      const out: RestingOrderSnapshot[] = [];
      for (let k = 0; k < count; k++, i += 8) {
        const display = f[i + 6]!;
        out.push({
          id: this.ids[f[i]!]!,
          traderId: this.traders[f[i + 1]!]!,
          side: SIDES[f[i + 2]!]!,
          price: f[i + 3]!,
          visible: f[i + 4]!,
          hidden: f[i + 5]!,
          display: display < 0 ? null : display,
          selfTrade: SELF_TRADE[f[i + 7]!]!,
        });
      }
      return out;
    };
    const bids = resting(bidCount);
    const asks = resting(askCount);
    const stops: StopOrderSnapshot[] = [];
    for (let k = 0; k < stopCount; k++, i += 9) {
      stops.push({
        id: this.ids[f[i]!]!,
        traderId: this.traders[f[i + 1]!]!,
        side: SIDES[f[i + 2]!]!,
        stopPrice: f[i + 3]!,
        limitPrice: priceOrNull(f[i + 4]!),
        quantity: f[i + 5]!,
        timeInForce: TIFS[f[i + 6]!]!,
        selfTrade: SELF_TRADE[f[i + 7]!]!,
        arrival: f[i + 8]!,
      });
    }
    return { version: 1, phase, seq, arrival, lastPrice, bids, asks, stops };
  }

  submit(input: OrderInput): EngineEvent[] {
    let kind = P.KIND_MARKET;
    let price = 0;
    let limitPrice = 0;
    let display = 0;
    let flags = 0;
    if (input.type === "limit") {
      kind = P.KIND_LIMIT;
      price = num(input.price);
      if (input.displayQuantity != null) {
        flags |= P.HAS_DISPLAY;
        display = num(input.displayQuantity);
      }
    } else if (input.type === "stop") {
      kind = P.KIND_STOP;
      price = num(input.stopPrice);
      // Present-but-null is an invalid limit price in the TypeScript engine, not a missing one.
      if (input.limitPrice !== undefined) {
        flags |= P.HAS_LIMIT;
        limitPrice = num(input.limitPrice);
      }
    }
    const f = this.view();
    const c = this.io >> 3;
    f[c] = P.header(P.OP_SUBMIT, kind, sideCode(input.side), tifCode(input.timeInForce), selfTradeCode(input.selfTrade), flags);
    f[c + 1] = this.handle(input.id);
    f[c + 2] = this.trader(input.traderId);
    f[c + 3] = num(input.quantity);
    f[c + 4] = price;
    f[c + 5] = limitPrice;
    f[c + 6] = display;
    return this.run();
  }

  cancel(orderId: string): EngineEvent[] {
    const f = this.view();
    const c = this.io >> 3;
    f[c] = P.header(P.OP_CANCEL);
    f[c + 1] = this.handle(orderId);
    return this.run();
  }

  amend(orderId: string, changes: AmendInput): EngineEvent[] {
    const f = this.view();
    const c = this.io >> 3;
    const flags = (changes.price != null ? P.HAS_PRICE : 0) | (changes.quantity != null ? P.HAS_QUANTITY : 0);
    f[c] = P.header(P.OP_AMEND, 0, 0, 0, 0, flags);
    f[c + 1] = this.handle(orderId);
    f[c + 3] = num(changes.quantity);
    f[c + 4] = num(changes.price);
    return this.run();
  }

  bestBid(): number | null {
    return priceOrNull(this.wasm.best_bid());
  }

  bestAsk(): number | null {
    return priceOrNull(this.wasm.best_ask());
  }

  lastTradePrice(): number | null {
    return priceOrNull(this.wasm.last_price());
  }

  depth(levels = 10): Depth {
    this.wasm.depth(levels);
    const f = this.view();
    let i = this.outIndex();
    const side = (count: number): DepthLevel[] => {
      const out: DepthLevel[] = [];
      for (let k = 0; k < count; k++, i += 3) out.push({ price: f[i]!, quantity: f[i + 1]!, orders: f[i + 2]! });
      return out;
    };
    const bidCount = f[i]!;
    const askCount = f[i + 1]!;
    i += 2;
    const bids = side(bidCount);
    return { bids, asks: side(askCount) };
  }

  getOrder(orderId: string): OrderView | undefined {
    const handle = this.handles.get(orderId);
    if (handle === undefined || this.wasm.order_info(handle) === 0) return undefined;
    const f = this.view();
    const i = this.outIndex();
    return { id: orderId, traderId: this.traders[f[i]!]!, side: SIDES[f[i + 1]!]!, price: f[i + 2]!, remaining: f[i + 3]!, visible: f[i + 4]! };
  }

  getStopOrder(orderId: string): StopOrderView | undefined {
    const handle = this.handles.get(orderId);
    if (handle === undefined || this.wasm.stop_info(handle) === 0) return undefined;
    const f = this.view();
    const i = this.outIndex();
    const traderId = this.traders[f[i]!]!;
    return { id: orderId, traderId, side: SIDES[f[i + 1]!]!, stopPrice: f[i + 2]!, limitPrice: priceOrNull(f[i + 3]!), quantity: f[i + 4]! };
  }

  get restingOrderCount(): number {
    return this.wasm.resting_count();
  }

  get pendingStopCount(): number {
    return this.wasm.stop_count();
  }

  /** Interned order ids and the size of the handle table, to check that ids do not leak. */
  get idStats(): { live: number; slots: number } {
    return { live: this.handles.size, slots: this.ids.length };
  }

  /** The handle for an order id, assigning a fresh one if the id is not live. */
  private handle(id: string): number {
    let handle = this.handles.get(id);
    if (handle === undefined) {
      handle = this.spareHandles.pop() ?? this.ids.length;
      this.ids[handle] = id;
      this.handles.set(id, handle);
    }
    return handle;
  }

  private trader(traderId: string): number {
    let handle = this.traderHandles.get(traderId);
    if (handle === undefined) {
      handle = this.traders.length;
      this.traders.push(traderId);
      this.traderHandles.set(traderId, handle);
    }
    return handle;
  }

  /**
   * The f64 view of wasm memory. Growing the memory detaches its old buffer
   * (views of it read as length 0), so the views are rebuilt after a growth.
   */
  private view(): Float64Array {
    if (this.f64.length === 0) {
      const buffer = this.wasm.memory.buffer;
      this.f64 = new Float64Array(buffer);
      this.u32 = new Uint32Array(buffer);
    }
    return this.f64;
  }

  /** Index (in f64 words) of the latest output. */
  private outIndex(): number {
    return this.u32[(this.io + P.IO_HEADER) >> 2]! >> 3;
  }

  /** Runs the command in the Io block, decodes its events, then recycles freed handles. */
  private run(): EngineEvent[] {
    const words = this.wasm.apply();
    const f = this.view();
    const ids = this.ids;
    const traders = this.traders;
    const events: EngineEvent[] = [];
    let i = this.outIndex();
    const end = i + words;
    // Each object is built with the TypeScript engine's key order (seq last),
    // so even JSON.stringify of the events is identical.
    while (i < end) {
      const seq = f[i + 1]!;
      switch (f[i]) {
        case P.EV_ACCEPTED:
          events.push({ type: "accepted", orderId: ids[f[i + 2]!]!, seq });
          i += 3;
          break;
        case P.EV_REJECTED:
          events.push({ type: "rejected", orderId: ids[f[i + 2]!]!, reason: REJECT[f[i + 3]!]!, seq });
          i += 4;
          break;
        case P.EV_TRADE:
          events.push({
            type: "trade",
            price: f[i + 2]!,
            quantity: f[i + 3]!,
            makerOrderId: ids[f[i + 4]!]!,
            makerTraderId: traders[f[i + 5]!]!,
            takerOrderId: ids[f[i + 6]!]!,
            takerTraderId: traders[f[i + 7]!]!,
            takerSide: SIDES[f[i + 8]!]!,
            seq,
          });
          i += 9;
          break;
        case P.EV_RESTED:
          events.push({
            type: "rested",
            orderId: ids[f[i + 2]!]!,
            side: SIDES[f[i + 3]!]!,
            price: f[i + 4]!,
            quantity: f[i + 5]!,
            visible: f[i + 6]!,
            seq,
          });
          i += 7;
          break;
        case P.EV_CANCELLED:
          events.push({ type: "cancelled", orderId: ids[f[i + 2]!]!, remaining: f[i + 3]!, reason: CANCEL[f[i + 4]!]!, seq });
          i += 5;
          break;
        case P.EV_AMENDED:
          events.push({
            type: "amended",
            orderId: ids[f[i + 2]!]!,
            price: f[i + 3]!,
            quantity: f[i + 4]!,
            keptPriority: f[i + 5] === 1,
            seq,
          });
          i += 6;
          break;
        case P.EV_STOP_PENDING:
          events.push({
            type: "stop_pending",
            orderId: ids[f[i + 2]!]!,
            side: SIDES[f[i + 3]!]!,
            stopPrice: f[i + 4]!,
            quantity: f[i + 5]!,
            seq,
          });
          i += 6;
          break;
        case P.EV_TRIGGERED:
          events.push({ type: "triggered", orderId: ids[f[i + 2]!]!, lastPrice: f[i + 3]!, seq });
          i += 4;
          break;
        case P.EV_PHASE:
          events.push({ type: "phase", phase: PHASES[f[i + 2]!]!, price: priceOrNull(f[i + 3]!), volume: f[i + 4]!, seq });
          i += 5;
          break;
        default:
          throw new Error(`Unknown event tag ${String(f[i])} from the Rust engine`);
      }
    }

    // Only now, with every event decoded, can freed handles be reused.
    const u32 = this.u32;
    const header = (this.io + P.IO_HEADER) >> 2;
    const freed = u32[header + 2]! >> 2;
    const count = u32[header + 3]!;
    for (let k = 0; k < count; k++) {
      const handle = u32[freed + k]!;
      this.handles.delete(ids[handle]!);
      ids[handle] = "";
      this.spareHandles.push(handle);
    }
    return events;
  }
}
