import { AvlTree } from "./avl-tree.js";
import { NONE, OrderPool, PriceLevel } from "./price-level.js";
import type {
  AmendInput,
  AuctionResult,
  BookSnapshot,
  Depth,
  DepthLevel,
  EngineCommand,
  EngineEvent,
  EngineEventBody,
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
} from "./types.js";

/** The incoming (aggressive) side of a match. */
interface Taker {
  id: string;
  traderId: string;
  side: Side;
  remaining: number;
  selfTrade: SelfTradePrevention;
}

/** `arrival` is the submission order, used to sequence stops that trigger together. */
type StopOrder = Readonly<StopOrderSnapshot>;

const isPositiveInteger = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/** Whether a taker with this limit (null = market) may trade at the maker's price. */
function crosses(takerSide: Side, makerPrice: number, limit: number | null): boolean {
  if (limit === null) return true;
  return takerSide === "buy" ? makerPrice <= limit : makerPrice >= limit;
}

function snapshot(tree: AvlTree<PriceLevel>, levels: number): DepthLevel[] {
  const out: DepthLevel[] = [];
  if (levels <= 0) return out;
  for (const level of tree.values()) {
    out.push({ price: level.price, quantity: level.totalQuantity, orders: level.orderCount });
    if (out.length >= levels) break;
  }
  return out;
}

/** Removes and returns every stop queue at the front of `tree` whose stop price is hit. */
function drainTriggered(tree: AvlTree<StopOrder[]>, hit: (stopPrice: number) => boolean, out: StopOrder[]): void {
  for (;;) {
    const queue = tree.min();
    if (queue === undefined || !hit(queue[0]!.stopPrice)) return;
    out.push(...queue);
    tree.delete(queue[0]!.stopPrice);
  }
}

/**
 * Single-instrument limit order book with price-time priority.
 *
 * - Price levels live in AVL trees (bids descending, asks ascending), so the
 *   best price is always the tree's minimum: O(log L) for L levels.
 * - Orders at a level form a FIFO linked list; an id -> order index makes
 *   cancel and amend O(1) after the lookup. Order data lives in typed arrays
 *   (OrderPool), not one object per order, so a deep book adds little work
 *   for the garbage collector.
 * - Trades always execute at the resting (maker) order's price.
 * - Stop orders wait in their own trees keyed by stop price and enter the
 *   book when a trade prints through them, which can cascade.
 * - In the auction phase, orders collect without matching; `uncross` then
 *   trades the maximum volume at one equilibrium price.
 *
 * Every call returns the events it produced, stamped with a global sequence
 * number, so the same inputs always replay to the same outputs.
 */
export class OrderBook {
  private readonly bids = new AvlTree<PriceLevel>((a, b) => b - a);
  private readonly asks = new AvlTree<PriceLevel>((a, b) => a - b);
  private readonly pool = new OrderPool();
  /** Order id -> its slot in the pool. */
  private readonly orders = new Map<string, number>();
  /** Price levels by id (an order's level column points here), with ids of removed levels for reuse. */
  private readonly levels: (PriceLevel | undefined)[] = [];
  private readonly freeLevels: number[] = [];
  // Buy stops trigger as the price rises (lowest first); sell stops as it falls.
  private readonly buyStops = new AvlTree<StopOrder[]>((a, b) => a - b);
  private readonly sellStops = new AvlTree<StopOrder[]>((a, b) => b - a);
  private readonly stops = new Map<string, StopOrder>();
  private lastPrice: number | null = null;
  private arrival = 0;
  private seq = 0;
  private tradingPhase: TradingPhase = "continuous";

  static fromSnapshot(snapshot: BookSnapshot): OrderBook {
    if (snapshot.version !== 1) throw new Error(`Unsupported snapshot version ${String(snapshot.version)}`);
    const book = new OrderBook();
    book.tradingPhase = snapshot.phase ?? "continuous";
    book.seq = snapshot.seq;
    book.arrival = snapshot.arrival;
    book.lastPrice = snapshot.lastPrice;
    for (const order of [...snapshot.bids, ...snapshot.asks]) book.insertResting(order);
    for (const stop of snapshot.stops) book.parkStop({ ...stop });
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
    return this.tradingPhase;
  }

  /** Stops continuous matching. Limit orders rest without trading until `uncross`. */
  startAuction(): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.tradingPhase === "auction") return events;
    this.tradingPhase = "auction";
    this.emit(events, { type: "phase", phase: "auction", price: null, volume: 0 });
    return events;
  }

  /**
   * Ends the auction: everything that can trade does, at one price, and
   * continuous trading resumes (which may set off stops).
   */
  uncross(): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.tradingPhase !== "auction") return events;
    const result = this.indicativeAuction();
    if (result !== null) this.executeAuction(result, events);
    this.tradingPhase = "continuous";
    this.emit(events, { type: "phase", phase: "continuous", price: result?.price ?? null, volume: result?.volume ?? 0 });
    this.runStops(events);
    return events;
  }

  /**
   * The price an uncross would trade at right now, or null if nothing crosses.
   *
   * At each candidate price p, demand D(p) is all bid quantity priced at or
   * above p and supply S(p) all ask quantity at or below p (hidden iceberg
   * quantity included); min(D, S) can trade. The equilibrium price:
   *   1. maximises traded volume,
   *   2. then minimises the leftover imbalance |D - S|,
   *   3. then lies closest to the last trade price (the reference),
   *   4. then is the lowest, so the choice is always deterministic.
   * Only prices between the best ask and the best bid can trade anything, so
   * only those levels are candidates: one O(L) sweep after sorting.
   */
  indicativeAuction(): AuctionResult | null {
    const bestBid = this.bids.min();
    const bestAsk = this.asks.min();
    if (bestBid === undefined || bestAsk === undefined || bestBid.price < bestAsk.price) return null;
    const low = bestAsk.price;
    const high = bestBid.price;

    const asks = [...this.asks.values()].filter((l) => l.price <= high); // ascending
    const bids = [...this.bids.values()].filter((l) => l.price >= low).reverse(); // ascending
    const candidates = [...new Set([...asks.map((l) => l.price), ...bids.map((l) => l.price)])].sort((a, b) => a - b);
    const size = (l: PriceLevel) => l.totalQuantity + l.hiddenQuantity;

    let demand = bids.reduce((sum, l) => sum + size(l), 0);
    let supply = 0;
    let a = 0;
    let b = 0;
    let best: AuctionResult | null = null;
    let bestDistance = Infinity;
    for (const price of candidates) {
      while (a < asks.length && asks[a]!.price <= price) supply += size(asks[a++]!);
      while (b < bids.length && bids[b]!.price < price) demand -= size(bids[b++]!);
      const volume = Math.min(demand, supply);
      if (volume === 0) continue;
      const imbalance = demand - supply;
      const distance = this.lastPrice === null ? 0 : Math.abs(price - this.lastPrice);
      const better =
        best === null ||
        volume > best.volume ||
        (volume === best.volume &&
          (Math.abs(imbalance) < Math.abs(best.imbalance) ||
            (Math.abs(imbalance) === Math.abs(best.imbalance) && distance < bestDistance)));
      if (better) {
        best = { price, volume, imbalance };
        bestDistance = distance;
      }
    }
    return best;
  }

  snapshot(): BookSnapshot {
    const p = this.pool;
    const ordersOf = (tree: AvlTree<PriceLevel>): RestingOrderSnapshot[] => {
      const out: RestingOrderSnapshot[] = [];
      for (const level of tree.values()) {
        for (let o = level.head; o !== NONE; o = p.next[o]!) {
          out.push({
            id: p.ids[o]!,
            traderId: p.traderOf(o),
            side: p.sideOf(o),
            price: p.price[o]!,
            visible: p.visible[o]!,
            hidden: p.hidden[o]!,
            display: p.displayOf(o),
            selfTrade: p.selfTradeOf(o),
          });
        }
      }
      return out;
    };
    return {
      version: 1,
      phase: this.tradingPhase,
      seq: this.seq,
      arrival: this.arrival,
      lastPrice: this.lastPrice,
      bids: ordersOf(this.bids),
      asks: ordersOf(this.asks),
      stops: [...this.stops.values()].sort((a, b) => a.arrival - b.arrival).map((s) => ({ ...s })),
    };
  }

  /**
   * Ids must be unique among live orders (resting or pending stop).
   * Uniqueness over a whole session is the gateway's job: remembering every
   * id ever seen here would grow memory without bound in a long-running engine.
   */
  submit(input: OrderInput): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.orders.has(input.id) || this.stops.has(input.id)) return this.reject(events, input.id, "duplicate_id");
    if (!isPositiveInteger(input.quantity)) return this.reject(events, input.id, "invalid_quantity");
    if (input.type === "limit" && !isPositiveInteger(input.price)) return this.reject(events, input.id, "invalid_price");
    if (input.type === "stop") {
      if (!isPositiveInteger(input.stopPrice)) return this.reject(events, input.id, "invalid_stop_price");
      if (input.limitPrice !== undefined && !isPositiveInteger(input.limitPrice)) {
        return this.reject(events, input.id, "invalid_price");
      }
    }

    const limit = input.type === "limit" ? input.price : input.type === "stop" ? (input.limitPrice ?? null) : null;
    const timeInForce: TimeInForce =
      limit !== null ? (input.timeInForce ?? "GTC") : input.timeInForce === "FOK" ? "FOK" : "IOC";
    const display = input.type === "limit" ? (input.displayQuantity ?? null) : null;
    if (display !== null && (!isPositiveInteger(display) || timeInForce !== "GTC")) {
      return this.reject(events, input.id, "invalid_display_quantity");
    }
    if (input.type === "stop" && this.lastPrice !== null && this.isTriggered(input.side, input.stopPrice)) {
      return this.reject(events, input.id, "invalid_stop_price");
    }
    // An auction only collects orders that can wait for the uncross.
    if (this.tradingPhase === "auction" && input.type !== "stop" && (input.type === "market" || timeInForce !== "GTC")) {
      return this.reject(events, input.id, "not_allowed_in_auction");
    }

    this.emit(events, { type: "accepted", orderId: input.id });
    const selfTrade = input.selfTrade ?? "allow";

    if (input.type === "stop") {
      this.parkStop({
        id: input.id,
        traderId: input.traderId,
        side: input.side,
        stopPrice: input.stopPrice,
        limitPrice: limit,
        quantity: input.quantity,
        timeInForce,
        selfTrade,
        arrival: ++this.arrival,
      });
      this.emit(events, {
        type: "stop_pending",
        orderId: input.id,
        side: input.side,
        stopPrice: input.stopPrice,
        quantity: input.quantity,
      });
      return events;
    }

    const taker: Taker = { id: input.id, traderId: input.traderId, side: input.side, remaining: input.quantity, selfTrade };
    this.execute(taker, limit, timeInForce, display, events);
    this.runStops(events);
    return events;
  }

  cancel(orderId: string): EngineEvent[] {
    const events: EngineEvent[] = [];
    const stop = this.stops.get(orderId);
    if (stop !== undefined) {
      this.unparkStop(stop);
      this.emit(events, { type: "cancelled", orderId, remaining: stop.quantity, reason: "user" });
      return events;
    }
    const slot = this.orders.get(orderId);
    if (slot === undefined) return this.reject(events, orderId, "unknown_order");
    const remaining = this.pool.visible[slot]! + this.pool.hidden[slot]!;
    this.removeResting(slot);
    this.emit(events, { type: "cancelled", orderId, remaining, reason: "user" });
    return events;
  }

  /**
   * Reducing quantity at the same price keeps the order's place in the queue.
   * Any other change (new price, more quantity) sends it to the back, and if
   * the new price crosses the spread it trades immediately.
   */
  amend(orderId: string, changes: AmendInput): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.stops.has(orderId)) return this.reject(events, orderId, "not_amendable");
    const slot = this.orders.get(orderId);
    if (slot === undefined) return this.reject(events, orderId, "unknown_order");
    const p = this.pool;
    const visibleNow = p.visible[slot]!;
    const hiddenNow = p.hidden[slot]!;
    const total = visibleNow + hiddenNow;
    const price = changes.price ?? p.price[slot]!;
    const quantity = changes.quantity ?? total;
    if (!isPositiveInteger(quantity)) return this.reject(events, orderId, "invalid_quantity");
    if (!isPositiveInteger(price)) return this.reject(events, orderId, "invalid_price");

    if (price === p.price[slot] && quantity <= total) {
      const visible = Math.min(visibleNow, quantity);
      const level = this.levels[p.level[slot]!]!;
      level.reduce(slot, visibleNow - visible);
      level.reduceHidden(slot, hiddenNow - (quantity - visible));
      this.emit(events, { type: "amended", orderId, price, quantity, keptPriority: true });
      return events;
    }

    const taker: Taker = { id: orderId, traderId: p.traderOf(slot), side: p.sideOf(slot), remaining: quantity, selfTrade: p.selfTradeOf(slot) };
    const display = p.displayOf(slot);
    this.removeResting(slot);
    this.emit(events, { type: "amended", orderId, price, quantity, keptPriority: false });
    this.execute(taker, price, "GTC", display, events);
    this.runStops(events);
    return events;
  }

  bestBid(): number | null {
    return this.bids.min()?.price ?? null;
  }

  bestAsk(): number | null {
    return this.asks.min()?.price ?? null;
  }

  lastTradePrice(): number | null {
    return this.lastPrice;
  }

  depth(levels = 10): Depth {
    return { bids: snapshot(this.bids, levels), asks: snapshot(this.asks, levels) };
  }

  getOrder(orderId: string): OrderView | undefined {
    const slot = this.orders.get(orderId);
    if (slot === undefined) return undefined;
    const p = this.pool;
    const visible = p.visible[slot]!;
    return { id: orderId, traderId: p.traderOf(slot), side: p.sideOf(slot), price: p.price[slot]!, remaining: visible + p.hidden[slot]!, visible };
  }

  getStopOrder(orderId: string): StopOrderView | undefined {
    const stop = this.stops.get(orderId);
    if (stop === undefined) return undefined;
    const { id, traderId, side, stopPrice, limitPrice, quantity } = stop;
    return { id, traderId, side, stopPrice, limitPrice, quantity };
  }

  get restingOrderCount(): number {
    return this.orders.size;
  }

  get pendingStopCount(): number {
    return this.stops.size;
  }

  /** Runs an order that is entering the book now: FOK check, match, then rest or cancel the remainder. */
  private execute(
    taker: Taker,
    limit: number | null,
    timeInForce: TimeInForce,
    display: number | null,
    events: EngineEvent[],
  ): void {
    // In an auction (only GTC limits get this far) orders wait for the uncross.
    if (this.tradingPhase === "auction") {
      this.rest(taker, limit!, display, events);
      return;
    }
    if (timeInForce === "FOK" && this.liquidity(taker, limit, taker.remaining) < taker.remaining) {
      this.emit(events, { type: "cancelled", orderId: taker.id, remaining: taker.remaining, reason: "fok_unfillable" });
      return;
    }
    this.match(taker, limit, events);
    if (taker.remaining === 0) return;
    if (limit !== null && timeInForce === "GTC") {
      this.rest(taker, limit, display, events);
    } else {
      this.emit(events, {
        type: "cancelled",
        orderId: taker.id,
        remaining: taker.remaining,
        reason: "unfilled_remainder",
      });
    }
  }

  private match(taker: Taker, limit: number | null, events: EngineEvent[]): void {
    const book = taker.side === "buy" ? this.asks : this.bids;
    const p = this.pool;
    // Traders are compared by number; one with no resting orders has none (NONE matches nobody).
    const takerTrader = taker.selfTrade === "allow" ? NONE : p.traderNumber(taker.traderId);
    while (taker.remaining > 0) {
      const level = book.min();
      if (level === undefined || !crosses(taker.side, level.price, limit)) return;

      while (taker.remaining > 0) {
        const maker = level.head;
        if (maker === NONE) break;
        if (takerTrader !== NONE && p.trader[maker] === takerTrader) {
          this.preventSelfTrade(taker, maker, events);
          continue;
        }
        const quantity = Math.min(taker.remaining, p.visible[maker]!);
        taker.remaining -= quantity;
        level.reduce(maker, quantity);
        this.lastPrice = level.price;
        this.emit(events, {
          type: "trade",
          price: level.price,
          quantity,
          makerOrderId: p.ids[maker]!,
          makerTraderId: p.traderOf(maker),
          takerOrderId: taker.id,
          takerTraderId: taker.traderId,
          takerSide: taker.side,
        });
        if (p.visible[maker] === 0) this.consumed(maker);
      }
    }
  }

  /**
   * A resting order whose visible quantity just ran out: an iceberg shows its
   * next slice at the back of the queue; anything else leaves the book.
   */
  private consumed(slot: number): void {
    const p = this.pool;
    if (p.hidden[slot]! > 0) {
      const level = this.levels[p.level[slot]!]!;
      level.remove(slot);
      p.visible[slot] = Math.min(p.display[slot]!, p.hidden[slot]!);
      p.hidden[slot]! -= p.visible[slot]!;
      level.push(slot);
    } else {
      this.removeResting(slot);
    }
  }

  /**
   * Trades the auction's volume at its single price. Best bids meet best asks
   * in price-time priority; with no aggressor in an auction, the buyer is
   * reported as the taker by convention. Self-trade prevention does not apply:
   * an uncross is one price for everyone, not an order taking liquidity.
   */
  private executeAuction(result: AuctionResult, events: EngineEvent[]): void {
    const p = this.pool;
    let remaining = result.volume;
    while (remaining > 0) {
      const bidLevel = this.bids.min()!;
      const askLevel = this.asks.min()!;
      const bid = bidLevel.head;
      const ask = askLevel.head;
      const quantity = Math.min(remaining, p.visible[bid]!, p.visible[ask]!);
      remaining -= quantity;
      bidLevel.reduce(bid, quantity);
      askLevel.reduce(ask, quantity);
      this.lastPrice = result.price;
      this.emit(events, {
        type: "trade",
        price: result.price,
        quantity,
        makerOrderId: p.ids[ask]!,
        makerTraderId: p.traderOf(ask),
        takerOrderId: p.ids[bid]!,
        takerTraderId: p.traderOf(bid),
        takerSide: "buy",
      });
      if (p.visible[bid] === 0) this.consumed(bid);
      if (p.visible[ask] === 0) this.consumed(ask);
    }
  }

  private preventSelfTrade(taker: Taker, maker: number, events: EngineEvent[]): void {
    const policy = taker.selfTrade;
    if (policy === "cancel_maker" || policy === "cancel_both") {
      const p = this.pool;
      const orderId = p.ids[maker]!;
      const remaining = p.visible[maker]! + p.hidden[maker]!;
      this.removeResting(maker);
      this.emit(events, { type: "cancelled", orderId, remaining, reason: "self_trade" });
    }
    if (policy === "cancel_taker" || policy === "cancel_both") {
      this.emit(events, { type: "cancelled", orderId: taker.id, remaining: taker.remaining, reason: "self_trade" });
      taker.remaining = 0;
    }
  }

  /**
   * Quantity a FOK taker could fill right now, counting only up to `needed`.
   * Hidden iceberg reserves count, because their slices refill during the
   * same match. If self-trade prevention would cancel the taker at some
   * resting order, matching stops there: only the visible quantity queued
   * ahead of it can fill, since iceberg refills join the queue behind it.
   */
  private liquidity(taker: Taker, limit: number | null, needed: number): number {
    const book = taker.side === "buy" ? this.asks : this.bids;
    const p = this.pool;
    const takerTrader = p.traderNumber(taker.traderId);
    let available = 0;
    for (const level of book.values()) {
      if (!crosses(taker.side, level.price, limit)) break;
      if (taker.selfTrade === "allow" || takerTrader === NONE) {
        available += level.totalQuantity + level.hiddenQuantity;
      } else {
        let levelTotal = 0;
        let visibleAhead = 0;
        for (let o = level.head; o !== NONE; o = p.next[o]!) {
          if (p.trader[o] === takerTrader) {
            if (taker.selfTrade === "cancel_maker") continue;
            return available + visibleAhead;
          }
          visibleAhead += p.visible[o]!;
          levelTotal += p.visible[o]! + p.hidden[o]!;
        }
        available += levelTotal;
      }
      if (available >= needed) break;
    }
    return available;
  }

  private rest(taker: Taker, price: number, display: number | null, events: EngineEvent[]): void {
    const visible = display === null ? taker.remaining : Math.min(display, taker.remaining);
    this.insertResting({
      id: taker.id,
      traderId: taker.traderId,
      side: taker.side,
      price,
      visible,
      hidden: taker.remaining - visible,
      display,
      selfTrade: taker.selfTrade,
    });
    this.emit(events, {
      type: "rested",
      orderId: taker.id,
      side: taker.side,
      price,
      quantity: taker.remaining,
      visible,
    });
  }

  /** Appends an order to the back of its price level's queue. */
  private insertResting(o: RestingOrderSnapshot): void {
    const tree = o.side === "buy" ? this.bids : this.asks;
    let level = tree.get(o.price);
    if (level === undefined) {
      const id = this.freeLevels.pop() ?? this.levels.length;
      level = new PriceLevel(o.price, id, this.pool);
      this.levels[id] = level;
      tree.set(o.price, level);
    }
    const slot = this.pool.add(o.id, o.traderId, o.side, o.price, o.visible, o.hidden, o.display, o.selfTrade);
    level.push(slot);
    this.orders.set(o.id, slot);
  }

  /** Takes an order off the book and frees its slot; read anything needed from it first. */
  private removeResting(slot: number): void {
    const p = this.pool;
    const level = this.levels[p.level[slot]!]!;
    level.remove(slot);
    this.orders.delete(p.ids[slot]!);
    if (level.isEmpty) {
      (p.side[slot] === 0 ? this.bids : this.asks).delete(level.price);
      this.levels[level.id] = undefined;
      this.freeLevels.push(level.id);
    }
    p.release(slot);
  }

  private isTriggered(side: Side, stopPrice: number): boolean {
    return side === "buy" ? this.lastPrice! >= stopPrice : this.lastPrice! <= stopPrice;
  }

  private parkStop(stop: StopOrder): void {
    const tree = stop.side === "buy" ? this.buyStops : this.sellStops;
    const queue = tree.get(stop.stopPrice);
    if (queue === undefined) tree.set(stop.stopPrice, [stop]);
    else queue.push(stop);
    this.stops.set(stop.id, stop);
  }

  private unparkStop(stop: StopOrder): void {
    const tree = stop.side === "buy" ? this.buyStops : this.sellStops;
    const queue = tree.get(stop.stopPrice)!;
    queue.splice(queue.indexOf(stop), 1);
    if (queue.length === 0) tree.delete(stop.stopPrice);
    this.stops.delete(stop.id);
  }

  /**
   * Enters every stop the last trade price has reached, oldest first. Their
   * trades can move the price through more stops, so repeat until none fire.
   */
  private runStops(events: EngineEvent[]): void {
    while (this.stops.size > 0 && this.lastPrice !== null) {
      const last = this.lastPrice;
      const triggered: StopOrder[] = [];
      drainTriggered(this.buyStops, (stopPrice) => last >= stopPrice, triggered);
      drainTriggered(this.sellStops, (stopPrice) => last <= stopPrice, triggered);
      if (triggered.length === 0) return;
      triggered.sort((a, b) => a.arrival - b.arrival);
      for (const stop of triggered) this.stops.delete(stop.id);

      for (const stop of triggered) {
        this.emit(events, { type: "triggered", orderId: stop.id, lastPrice: this.lastPrice });
        const taker: Taker = {
          id: stop.id,
          traderId: stop.traderId,
          side: stop.side,
          remaining: stop.quantity,
          selfTrade: stop.selfTrade,
        };
        this.execute(taker, stop.limitPrice, stop.timeInForce, null, events);
      }
    }
  }

  private reject(events: EngineEvent[], orderId: string, reason: RejectReason): EngineEvent[] {
    this.emit(events, { type: "rejected", orderId, reason });
    return events;
  }

  private emit(events: EngineEvent[], body: EngineEventBody): void {
    events.push({ ...body, seq: ++this.seq } as EngineEvent);
  }
}
