import type {
  AmendInput,
  AuctionResult,
  Depth,
  DepthLevel,
  EngineEvent,
  EngineEventBody,
  OrderInput,
  OrderView,
  RejectReason,
  SelfTradePrevention,
  Side,
  StopOrderView,
  TimeInForce,
  TradingPhase,
} from "../src/types.js";

interface RefOrder {
  id: string;
  traderId: string;
  side: Side;
  price: number;
  visible: number;
  hidden: number;
  display: number | null;
  selfTrade: SelfTradePrevention;
  /** Queue position; lower means earlier. Iceberg refills get a new time. */
  time: number;
}

interface RefStop {
  id: string;
  traderId: string;
  side: Side;
  stopPrice: number;
  limitPrice: number | null;
  quantity: number;
  timeInForce: TimeInForce;
  selfTrade: SelfTradePrevention;
  arrival: number;
}

interface RefTaker {
  id: string;
  traderId: string;
  side: Side;
  remaining: number;
  selfTrade: SelfTradePrevention;
}

const isPositiveInteger = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/** Lexicographic comparison of number tuples. */
function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * A deliberately naive order book: every decision is a linear scan and a sort
 * over flat arrays. It is slow but easy to verify by reading, so the fast
 * engine is tested by requiring it to produce exactly the same events.
 *
 * Where the fast engine uses a shortcut, this one takes the long way round on
 * purpose: FOK orders are checked by actually running the match on a copy of
 * the book and seeing whether it fills.
 */
export class ReferenceOrderBook {
  private resting: RefOrder[] = [];
  private stops: RefStop[] = [];
  private lastPrice: number | null = null;
  private seq = 0;
  private clock = 0;
  private arrival = 0;
  private currentPhase: TradingPhase = "continuous";

  get phase(): TradingPhase {
    return this.currentPhase;
  }

  startAuction(): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.currentPhase === "auction") return events;
    this.currentPhase = "auction";
    this.emit(events, { type: "phase", phase: "auction", price: null, volume: 0 });
    return events;
  }

  uncross(): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.currentPhase !== "auction") return events;
    const result = this.indicativeAuction();
    if (result !== null) {
      let remaining = result.volume;
      while (remaining > 0) {
        const bid = this.sorted("buy")[0]!;
        const ask = this.sorted("sell")[0]!;
        const quantity = Math.min(remaining, bid.visible, ask.visible);
        remaining -= quantity;
        bid.visible -= quantity;
        ask.visible -= quantity;
        this.lastPrice = result.price;
        this.emit(events, {
          type: "trade",
          price: result.price,
          quantity,
          makerOrderId: ask.id,
          makerTraderId: ask.traderId,
          takerOrderId: bid.id,
          takerTraderId: bid.traderId,
          takerSide: "buy",
        });
        for (const o of [bid, ask]) this.afterFill(o);
      }
    }
    this.currentPhase = "continuous";
    this.emit(events, { type: "phase", phase: "continuous", price: result?.price ?? null, volume: result?.volume ?? 0 });
    this.runStops(events);
    return events;
  }

  /** Brute force: try every price on the book and keep the best by the same four rules. */
  indicativeAuction(): AuctionResult | null {
    const size = (o: RefOrder) => o.visible + o.hidden;
    let best: (AuctionResult & { distance: number }) | null = null;
    for (const price of [...new Set(this.resting.map((o) => o.price))].sort((a, b) => a - b)) {
      const demand = this.resting.filter((o) => o.side === "buy" && o.price >= price).reduce((s, o) => s + size(o), 0);
      const supply = this.resting.filter((o) => o.side === "sell" && o.price <= price).reduce((s, o) => s + size(o), 0);
      const volume = Math.min(demand, supply);
      if (volume === 0) continue;
      const candidate = { price, volume, imbalance: demand - supply, distance: this.lastPrice === null ? 0 : Math.abs(price - this.lastPrice) };
      const key = (c: typeof candidate) => [-c.volume, Math.abs(c.imbalance), c.distance];
      if (best === null || compareKeys(key(candidate), key(best)) < 0) best = candidate;
    }
    return best === null ? null : { price: best.price, volume: best.volume, imbalance: best.imbalance };
  }

  /** One side's resting orders in priority order. */
  private sorted(side: Side): RefOrder[] {
    return this.resting
      .filter((o) => o.side === side)
      .sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price) || a.time - b.time);
  }

  /** After a fill: refill an iceberg at the back of its level, or remove a finished order. */
  private afterFill(o: RefOrder): void {
    if (o.visible > 0) return;
    if (o.hidden > 0) {
      o.visible = Math.min(o.display!, o.hidden);
      o.hidden -= o.visible;
      o.time = ++this.clock;
    } else {
      this.resting = this.resting.filter((r) => r !== o);
    }
  }

  submit(input: OrderInput): EngineEvent[] {
    const events: EngineEvent[] = [];
    const live = this.resting.some((o) => o.id === input.id) || this.stops.some((s) => s.id === input.id);
    if (live) return this.reject(events, input.id, "duplicate_id");
    if (!isPositiveInteger(input.quantity)) return this.reject(events, input.id, "invalid_quantity");
    if (input.type === "limit" && !isPositiveInteger(input.price)) return this.reject(events, input.id, "invalid_price");
    if (input.type === "stop" && !isPositiveInteger(input.stopPrice)) {
      return this.reject(events, input.id, "invalid_stop_price");
    }
    if (input.type === "stop" && input.limitPrice !== undefined && !isPositiveInteger(input.limitPrice)) {
      return this.reject(events, input.id, "invalid_price");
    }

    let limit: number | null = null;
    if (input.type === "limit") limit = input.price;
    if (input.type === "stop" && input.limitPrice !== undefined) limit = input.limitPrice;
    let timeInForce: TimeInForce;
    if (limit !== null) timeInForce = input.timeInForce ?? "GTC";
    else timeInForce = input.timeInForce === "FOK" ? "FOK" : "IOC";

    const display = input.type === "limit" && input.displayQuantity !== undefined ? input.displayQuantity : null;
    if (display !== null && !(isPositiveInteger(display) && timeInForce === "GTC")) {
      return this.reject(events, input.id, "invalid_display_quantity");
    }
    if (input.type === "stop" && this.lastPrice !== null && this.stopHit(input.side, input.stopPrice)) {
      return this.reject(events, input.id, "invalid_stop_price");
    }
    const waitsForUncross = input.type === "stop" || (input.type === "limit" && timeInForce === "GTC");
    if (this.currentPhase === "auction" && !waitsForUncross) return this.reject(events, input.id, "not_allowed_in_auction");

    this.emit(events, { type: "accepted", orderId: input.id });
    const selfTrade = input.selfTrade ?? "allow";

    if (input.type === "stop") {
      this.stops.push({
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

    const taker = { id: input.id, traderId: input.traderId, side: input.side, remaining: input.quantity, selfTrade };
    this.execute(taker, limit, timeInForce, display, events);
    this.runStops(events);
    return events;
  }

  cancel(orderId: string): EngineEvent[] {
    const events: EngineEvent[] = [];
    const stop = this.stops.find((s) => s.id === orderId);
    if (stop !== undefined) {
      this.stops = this.stops.filter((s) => s !== stop);
      this.emit(events, { type: "cancelled", orderId, remaining: stop.quantity, reason: "user" });
      return events;
    }
    const order = this.resting.find((o) => o.id === orderId);
    if (order === undefined) return this.reject(events, orderId, "unknown_order");
    this.resting = this.resting.filter((o) => o !== order);
    this.emit(events, { type: "cancelled", orderId, remaining: order.visible + order.hidden, reason: "user" });
    return events;
  }

  amend(orderId: string, changes: AmendInput): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.stops.some((s) => s.id === orderId)) return this.reject(events, orderId, "not_amendable");
    const order = this.resting.find((o) => o.id === orderId);
    if (order === undefined) return this.reject(events, orderId, "unknown_order");
    const total = order.visible + order.hidden;
    const price = changes.price ?? order.price;
    const quantity = changes.quantity ?? total;
    if (!isPositiveInteger(quantity)) return this.reject(events, orderId, "invalid_quantity");
    if (!isPositiveInteger(price)) return this.reject(events, orderId, "invalid_price");

    if (price === order.price && quantity <= total) {
      order.visible = Math.min(order.visible, quantity);
      order.hidden = quantity - order.visible;
      this.emit(events, { type: "amended", orderId, price, quantity, keptPriority: true });
      return events;
    }

    this.resting = this.resting.filter((o) => o !== order);
    this.emit(events, { type: "amended", orderId, price, quantity, keptPriority: false });
    const taker = { id: order.id, traderId: order.traderId, side: order.side, remaining: quantity, selfTrade: order.selfTrade };
    this.execute(taker, price, "GTC", order.display, events);
    this.runStops(events);
    return events;
  }

  bestBid(): number | null {
    const prices = this.resting.filter((o) => o.side === "buy").map((o) => o.price);
    return prices.length === 0 ? null : Math.max(...prices);
  }

  bestAsk(): number | null {
    const prices = this.resting.filter((o) => o.side === "sell").map((o) => o.price);
    return prices.length === 0 ? null : Math.min(...prices);
  }

  lastTradePrice(): number | null {
    return this.lastPrice;
  }

  depth(levels = 10): Depth {
    return { bids: this.levelsFor("buy").slice(0, levels), asks: this.levelsFor("sell").slice(0, levels) };
  }

  getOrder(orderId: string): OrderView | undefined {
    const o = this.resting.find((r) => r.id === orderId);
    if (o === undefined) return undefined;
    return { id: o.id, traderId: o.traderId, side: o.side, price: o.price, remaining: o.visible + o.hidden, visible: o.visible };
  }

  getStopOrder(orderId: string): StopOrderView | undefined {
    const s = this.stops.find((r) => r.id === orderId);
    if (s === undefined) return undefined;
    return { id: s.id, traderId: s.traderId, side: s.side, stopPrice: s.stopPrice, limitPrice: s.limitPrice, quantity: s.quantity };
  }

  get restingOrderCount(): number {
    return this.resting.length;
  }

  get pendingStopCount(): number {
    return this.stops.length;
  }

  private execute(
    taker: RefTaker,
    limit: number | null,
    timeInForce: TimeInForce,
    display: number | null,
    events: EngineEvent[],
  ): void {
    if (timeInForce === "FOK" && !this.wouldFill(taker, limit)) {
      this.emit(events, { type: "cancelled", orderId: taker.id, remaining: taker.remaining, reason: "fok_unfillable" });
      return;
    }
    // During an auction nothing matches on arrival.
    if (this.currentPhase === "continuous") this.match(taker, limit, events);
    if (taker.remaining === 0) return;
    if (limit !== null && timeInForce === "GTC") {
      const visible = display === null ? taker.remaining : Math.min(display, taker.remaining);
      this.resting.push({
        id: taker.id,
        traderId: taker.traderId,
        side: taker.side,
        price: limit,
        visible,
        hidden: taker.remaining - visible,
        display,
        selfTrade: taker.selfTrade,
        time: ++this.clock,
      });
      this.emit(events, {
        type: "rested",
        orderId: taker.id,
        side: taker.side,
        price: limit,
        quantity: taker.remaining,
        visible,
      });
    } else {
      this.emit(events, { type: "cancelled", orderId: taker.id, remaining: taker.remaining, reason: "unfilled_remainder" });
    }
  }

  /** Dry-runs the match on a copy of the book, then puts everything back. */
  private wouldFill(taker: RefTaker, limit: number | null): boolean {
    const saved = { resting: structuredClone(this.resting), lastPrice: this.lastPrice, seq: this.seq, clock: this.clock };
    const copy = { ...taker };
    let traded = 0;
    for (const e of this.match(copy, limit, [])) if (e.type === "trade") traded += e.quantity;
    this.resting = saved.resting;
    this.lastPrice = saved.lastPrice;
    this.seq = saved.seq;
    this.clock = saved.clock;
    return traded >= taker.remaining;
  }

  private match(taker: RefTaker, limit: number | null, events: EngineEvent[]): EngineEvent[] {
    while (taker.remaining > 0) {
      const maker = this.eligibleMakers(taker.side, limit)[0];
      if (maker === undefined) break;

      if (taker.selfTrade !== "allow" && maker.traderId === taker.traderId) {
        if (taker.selfTrade === "cancel_maker" || taker.selfTrade === "cancel_both") {
          this.resting = this.resting.filter((o) => o !== maker);
          this.emit(events, {
            type: "cancelled",
            orderId: maker.id,
            remaining: maker.visible + maker.hidden,
            reason: "self_trade",
          });
        }
        if (taker.selfTrade === "cancel_taker" || taker.selfTrade === "cancel_both") {
          this.emit(events, { type: "cancelled", orderId: taker.id, remaining: taker.remaining, reason: "self_trade" });
          taker.remaining = 0;
        }
        continue;
      }

      const filled = Math.min(taker.remaining, maker.visible);
      taker.remaining -= filled;
      maker.visible -= filled;
      this.lastPrice = maker.price;
      this.emit(events, {
        type: "trade",
        price: maker.price,
        quantity: filled,
        makerOrderId: maker.id,
        makerTraderId: maker.traderId,
        takerOrderId: taker.id,
        takerTraderId: taker.traderId,
        takerSide: taker.side,
      });
      if (maker.visible === 0 && maker.hidden > 0) {
        maker.visible = Math.min(maker.display!, maker.hidden);
        maker.hidden -= maker.visible;
        maker.time = ++this.clock;
      } else if (maker.visible === 0) {
        this.resting = this.resting.filter((o) => o !== maker);
      }
    }
    return events;
  }

  private runStops(events: EngineEvent[]): void {
    for (;;) {
      if (this.lastPrice === null) return;
      const triggered = this.stops
        .filter((s) => this.stopHit(s.side, s.stopPrice))
        .sort((a, b) => a.arrival - b.arrival);
      if (triggered.length === 0) return;
      this.stops = this.stops.filter((s) => !triggered.includes(s));
      for (const s of triggered) {
        this.emit(events, { type: "triggered", orderId: s.id, lastPrice: this.lastPrice });
        const taker = { id: s.id, traderId: s.traderId, side: s.side, remaining: s.quantity, selfTrade: s.selfTrade };
        this.execute(taker, s.limitPrice, s.timeInForce, null, events);
      }
    }
  }

  private stopHit(side: Side, stopPrice: number): boolean {
    return side === "buy" ? this.lastPrice! >= stopPrice : this.lastPrice! <= stopPrice;
  }

  private levelsFor(side: Side): DepthLevel[] {
    const byPrice = new Map<number, DepthLevel>();
    for (const o of this.resting) {
      if (o.side !== side) continue;
      const level = byPrice.get(o.price) ?? { price: o.price, quantity: 0, orders: 0 };
      level.quantity += o.visible;
      level.orders += 1;
      byPrice.set(o.price, level);
    }
    return [...byPrice.values()].sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price));
  }

  /** Opposite-side orders the taker may trade with, in priority order. */
  private eligibleMakers(takerSide: Side, limit: number | null): RefOrder[] {
    return this.resting
      .filter((o) => o.side !== takerSide)
      .filter((o) => limit === null || (takerSide === "buy" ? o.price <= limit : o.price >= limit))
      .sort((a, b) => (takerSide === "buy" ? a.price - b.price : b.price - a.price) || a.time - b.time);
  }

  private reject(events: EngineEvent[], orderId: string, reason: RejectReason): EngineEvent[] {
    this.emit(events, { type: "rejected", orderId, reason });
    return events;
  }

  private emit(events: EngineEvent[], body: EngineEventBody): void {
    events.push({ ...body, seq: ++this.seq } as EngineEvent);
  }
}
