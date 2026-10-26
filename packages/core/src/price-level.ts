import type { SelfTradePrevention, Side } from "./types.js";

/** No order: the end of a list, or an empty level. */
export const NONE = -1;

const SELF_TRADE: readonly SelfTradePrevention[] = ["allow", "cancel_taker", "cancel_maker", "cancel_both"];

/**
 * Resting orders stored column by column in typed arrays; an order is just
 * its slot number.
 *
 * With one JS object per order, a book holding a million orders is a million
 * objects the garbage collector must trace on every full collection, and the
 * pauses grow with the book. Here the order data lives in a few typed
 * arrays, which hold no pointers, so the collector skips their contents.
 * What is left per order is its id string and one Map entry.
 *
 * Freed slots are reused (a free list), and the arrays grow by doubling, so
 * adding an order is amortised O(1) and memory does not creep.
 */
export class OrderPool {
  price = new Float64Array(0);
  /** Quantity shown on the book and available to the next fill. */
  visible = new Float64Array(0);
  /** Iceberg reserve, shown slice by slice. Zero for normal orders. */
  hidden = new Float64Array(0);
  /** Iceberg slice size, or -1 for a normal order. */
  display = new Float64Array(0);
  /** 0 buy, 1 sell. */
  side = new Uint8Array(0);
  selfTrade = new Uint8Array(0);
  trader = new Int32Array(0);
  /** The level's id in the book's level table. */
  level = new Int32Array(0);
  prev = new Int32Array(0);
  next = new Int32Array(0);
  ids: string[] = [];

  private free = new Int32Array(0);
  private freeCount = 0;
  private used = 0;
  private readonly traderIndex = new Map<string, number>();
  private readonly traders: string[] = [];

  constructor(capacity = 1_024) {
    this.grow(capacity);
  }

  add(id: string, traderId: string, side: Side, price: number, visible: number, hidden: number, display: number | null, selfTrade: SelfTradePrevention): number {
    let slot: number;
    if (this.freeCount > 0) slot = this.free[--this.freeCount]!;
    else {
      if (this.used === this.price.length) this.grow(this.price.length * 2);
      slot = this.used++;
    }
    this.ids[slot] = id;
    this.trader[slot] = this.internTrader(traderId);
    this.side[slot] = side === "buy" ? 0 : 1;
    this.price[slot] = price;
    this.visible[slot] = visible;
    this.hidden[slot] = hidden;
    this.display[slot] = display ?? -1;
    this.selfTrade[slot] = SELF_TRADE.indexOf(selfTrade);
    this.prev[slot] = NONE;
    this.next[slot] = NONE;
    return slot;
  }

  release(slot: number): void {
    this.ids[slot] = "";
    this.free[this.freeCount++] = slot;
  }

  sideOf(slot: number): Side {
    return this.side[slot] === 0 ? "buy" : "sell";
  }

  traderOf(slot: number): string {
    return this.traders[this.trader[slot]!]!;
  }

  selfTradeOf(slot: number): SelfTradePrevention {
    return SELF_TRADE[this.selfTrade[slot]!]!;
  }

  displayOf(slot: number): number | null {
    const d = this.display[slot]!;
    return d < 0 ? null : d;
  }

  /** The trader's number, for comparing traders without comparing strings. */
  traderNumber(traderId: string): number {
    return this.traderIndex.get(traderId) ?? NONE;
  }

  private internTrader(traderId: string): number {
    let n = this.traderIndex.get(traderId);
    if (n === undefined) {
      n = this.traders.length;
      this.traders.push(traderId);
      this.traderIndex.set(traderId, n);
    }
    return n;
  }

  private grow(capacity: number): void {
    const copy = <T extends Float64Array | Int32Array | Uint8Array>(old: T, make: (n: number) => T): T => {
      const next = make(capacity);
      next.set(old);
      return next;
    };
    this.price = copy(this.price, (n) => new Float64Array(n));
    this.visible = copy(this.visible, (n) => new Float64Array(n));
    this.hidden = copy(this.hidden, (n) => new Float64Array(n));
    this.display = copy(this.display, (n) => new Float64Array(n));
    this.side = copy(this.side, (n) => new Uint8Array(n));
    this.selfTrade = copy(this.selfTrade, (n) => new Uint8Array(n));
    this.trader = copy(this.trader, (n) => new Int32Array(n));
    this.level = copy(this.level, (n) => new Int32Array(n));
    this.prev = copy(this.prev, (n) => new Int32Array(n));
    this.next = copy(this.next, (n) => new Int32Array(n));
    this.free = copy(this.free, (n) => new Int32Array(n));
  }
}

/**
 * All resting orders at one price, oldest first (time priority): a
 * doubly-linked list threaded through the pool's prev/next columns.
 * Append, remove and reduce are O(1), so cancelling any order is O(1)
 * once it has been found through the order-id index.
 */
export class PriceLevel {
  head = NONE;
  tail = NONE;
  /** Visible quantity, as shown in market depth. */
  totalQuantity = 0;
  hiddenQuantity = 0;
  orderCount = 0;

  constructor(
    readonly price: number,
    /** This level's id in the book's level table. */
    readonly id: number,
    private readonly pool: OrderPool,
  ) {}

  get isEmpty(): boolean {
    return this.head === NONE;
  }

  push(slot: number): void {
    const p = this.pool;
    p.prev[slot] = this.tail;
    p.next[slot] = NONE;
    p.level[slot] = this.id;
    if (this.tail === NONE) this.head = slot;
    else p.next[this.tail] = slot;
    this.tail = slot;
    this.totalQuantity += p.visible[slot]!;
    this.hiddenQuantity += p.hidden[slot]!;
    this.orderCount++;
  }

  remove(slot: number): void {
    const p = this.pool;
    const prev = p.prev[slot]!;
    const next = p.next[slot]!;
    if (prev === NONE) this.head = next;
    else p.next[prev] = next;
    if (next === NONE) this.tail = prev;
    else p.prev[next] = prev;
    p.prev[slot] = NONE;
    p.next[slot] = NONE;
    this.totalQuantity -= p.visible[slot]!;
    this.hiddenQuantity -= p.hidden[slot]!;
    this.orderCount--;
  }

  /** Lowers an order's visible quantity in place, keeping its queue position. */
  reduce(slot: number, quantity: number): void {
    this.pool.visible[slot]! -= quantity;
    this.totalQuantity -= quantity;
  }

  reduceHidden(slot: number, quantity: number): void {
    this.pool.hidden[slot]! -= quantity;
    this.hiddenQuantity -= quantity;
  }
}
