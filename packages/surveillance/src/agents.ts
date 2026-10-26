import type { Side } from "@ome/core";
import { Agent, type Fill, type Label, type Market } from "./simulator.js";

// Honest and manipulative traders for the surveillance simulator.
//
// Honest agents are chosen to be hard to tell apart from manipulators on any
// single measure: market makers cancel almost everything, investors place huge
// orders, momentum traders trade aggressively in one direction.
//
// Manipulators vary in `intensity` (0 subtle .. 1 blatant) and keep up normal
// "cover" trading between episodes, as real ones do, so their windows mix
// manipulation with ordinary activity.

const between = (m: Market, lo: number, hi: number) => lo + Math.floor(m.random() * (hi - lo + 1));
const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");
const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/** How a retail trader places limit orders: how far from the touch, and how long they leave them. */
export interface RetailStyle {
  /** Ticks from the touch: negative is inside the spread, positive behind it. */
  offsets: [number, number];
  lifetimeMs: [number, number];
  marketShare: number;
}

const DEFAULT_RETAIL: RetailStyle = { offsets: [-1, 3], lifetimeMs: [2_000, 20_000], marketShare: 0.4 };

/** Retail-style flow on behalf of an agent: market orders and short-lived limits near the touch. */
class RetailFlow {
  private next = 0;
  private readonly expiries: { id: string; at: number }[] = [];

  constructor(
    private readonly owner: Agent,
    private readonly meanGapMs: number,
    private readonly style: RetailStyle = DEFAULT_RETAIL,
  ) {}

  act(m: Market): void {
    for (const e of this.expiries.splice(0)) {
      if (e.at <= m.now) m.cancel(this.owner, e.id);
      else this.expiries.push(e);
    }
    if (m.now < this.next) return;
    this.next = m.now - Math.log(Math.max(m.random(), 1e-9)) * this.meanGapMs;
    const side: Side = m.random() < 0.5 ? "buy" : "sell";
    if (m.random() < this.style.marketShare) {
      m.submit(this.owner, { side, quantity: between(m, 1, 10) });
      return;
    }
    const touch = side === "buy" ? (m.bestBid() ?? m.mid() - 1) : (m.bestAsk() ?? m.mid() + 1);
    const offset = between(m, ...this.style.offsets);
    const id = m.submit(this.owner, { side, price: side === "buy" ? touch - offset : touch + offset, quantity: between(m, 1, 20) });
    this.expiries.push({ id, at: m.now + between(m, ...this.style.lifetimeMs) });
  }
}

/** Two-sided quotes around fair value, cancelled and replaced every few hundred ms. */
export class MarketMakerAgent extends Agent {
  private orders: string[] = [];
  private nextQuote = 0;
  private position = 0;

  constructor(
    id: string,
    private readonly size: number,
    private readonly halfSpread: number,
    private readonly requoteMs: [number, number] = [300, 900],
  ) {
    super(id, "honest");
  }

  act(m: Market): void {
    if (m.now < this.nextQuote) return;
    this.nextQuote = m.now + between(m, ...this.requoteMs);
    for (const id of this.orders) m.cancel(this, id);
    const skew = -Math.sign(this.position) * Math.min(3, Math.abs(this.position) / (this.size * 4));
    const center = m.fair + skew;
    this.orders = [];
    for (let level = 0; level < 3; level++) {
      if (this.position < this.size * 20) this.orders.push(m.submit(this, { side: "buy", price: Math.floor(center - this.halfSpread - level), quantity: this.size }));
      if (this.position > -this.size * 20) this.orders.push(m.submit(this, { side: "sell", price: Math.ceil(center + this.halfSpread + level), quantity: this.size }));
    }
  }

  override onFill(_m: Market, fill: Fill): void {
    this.position += fill.side === "buy" ? fill.quantity : -fill.quantity;
  }
}

/**
 * A market maker that keeps a ladder of quotes and only replaces the levels
 * that moved (like services/bots' MarketMaker), so it cancels far less than
 * the cancel-everything style, and quotes larger than the book around it.
 */
export class LadderMarketMakerAgent extends Agent {
  private readonly quotes = new Map<string, string>(); // "side:price" -> order id
  private next = 0;
  private position = 0;

  constructor(
    id: string,
    private readonly size: number,
    private readonly levels: number,
    private readonly halfSpread: number,
    /** Ticks between successive levels. */
    private readonly step = 1,
  ) {
    super(id, "honest");
  }

  act(m: Market): void {
    if (m.now < this.next) return;
    this.next = m.now + between(m, 200, 400);
    const skew = -Math.sign(this.position) * Math.min(4, Math.abs(this.position) / (this.size * 3));
    const center = m.fair + skew;
    const wanted = new Set<string>();
    for (let level = 0; level < this.levels; level++) {
      const offset = this.halfSpread + level * this.step;
      if (this.position < this.size * 20) wanted.add(`buy:${Math.floor(center - offset)}`);
      if (this.position > -this.size * 20) wanted.add(`sell:${Math.ceil(center + offset)}`);
    }
    for (const [key, id] of this.quotes) {
      if (!m.isLive(id) || !wanted.has(key)) {
        m.cancel(this, id);
        this.quotes.delete(key);
      }
    }
    for (const key of wanted) {
      if (this.quotes.has(key)) continue;
      const [side, price] = key.split(":") as [Side, string];
      this.quotes.set(key, m.submit(this, { side, price: Number(price), quantity: this.size }));
    }
  }

  override onFill(_m: Market, fill: Fill): void {
    this.position += fill.side === "buy" ? fill.quantity : -fill.quantity;
  }
}

/** Random retail flow. */
export class NoiseAgent extends Agent {
  private readonly flow: RetailFlow;

  constructor(id: string, meanGapMs: number, style?: RetailStyle) {
    super(id, "honest");
    this.flow = new RetailFlow(this, meanGapMs, style);
  }

  act(m: Market): void {
    this.flow.act(m);
  }
}

/** Buys rising markets and sells falling ones, with market orders. */
export class MomentumAgent extends Agent {
  private next = 0;

  constructor(id: string) {
    super(id, "honest");
  }

  act(m: Market): void {
    if (m.now < this.next) return;
    this.next = m.now + between(m, 3_000, 8_000);
    const prices = m.recentPrices();
    if (prices.length < 40) return;
    const change = (prices.at(-1)! - prices.at(-40)!) / prices.at(-40)!;
    if (Math.abs(change) < 0.0004) return;
    m.submit(this, { side: change > 0 ? "buy" : "sell", quantity: between(m, 5, 25) });
  }
}

/**
 * Occasionally rests one very large passive order. Usually leaves it for
 * minutes, but sometimes changes its mind within seconds, as people do.
 */
export class InvestorAgent extends Agent {
  private next = 0;
  private order: { id: string; until: number } | null = null;

  constructor(id: string) {
    super(id, "honest");
  }

  act(m: Market): void {
    if (this.order !== null) {
      if (!m.isLive(this.order.id)) this.order = null;
      else if (m.now >= this.order.until) {
        m.cancel(this, this.order.id);
        this.order = null;
      }
    }
    if (this.order !== null || m.now < this.next) return;
    this.next = m.now + between(m, 10_000, 40_000);
    const side: Side = m.random() < 0.5 ? "buy" : "sell";
    const touch = side === "buy" ? (m.bestBid() ?? m.mid()) : (m.bestAsk() ?? m.mid());
    const price = side === "buy" ? touch - between(m, 0, 2) : touch + between(m, 0, 2);
    const keepFor = m.random() < 0.25 ? between(m, 1_000, 5_000) : between(m, 60_000, 180_000);
    this.order = { id: m.submit(this, { side, price, quantity: between(m, 60, 200) }), until: m.now + keepFor };
  }
}

/** A manipulator: cover trading all the time, manipulation episodes now and then. */
abstract class Manipulator extends Agent {
  private readonly cover: RetailFlow;

  constructor(
    id: string,
    label: Label,
    /** 0 = subtle, 1 = blatant. */
    readonly intensity: number,
    coverGapMs: number,
  ) {
    super(id, label);
    this.cover = new RetailFlow(this, coverGapMs);
  }

  act(m: Market): void {
    this.cover.act(m);
    this.manipulate(m);
  }

  protected abstract manipulate(m: Market): void;
}

/**
 * Spoofing: large orders a few ticks behind the touch on one side to suggest
 * pressure, a small genuine order on the other side to profit from it, then
 * the large orders are cancelled. Subtle spoofers use smaller orders and
 * leave them longer.
 */
export class SpooferAgent extends Manipulator {
  private baiting = false;
  private next = 0;
  private spoofs: string[] = [];
  private real: string | null = null;
  private cancelAt = 0;

  constructor(id: string, intensity: number, coverGapMs = 2_500) {
    super(id, "spoofing", intensity, coverGapMs);
  }

  protected manipulate(m: Market): void {
    if (!this.baiting) {
      if (m.now < this.next) return;
      const side: Side = m.random() < 0.5 ? "buy" : "sell";
      const touch = side === "buy" ? (m.bestBid() ?? m.mid() - 1) : (m.bestAsk() ?? m.mid() + 1);
      const count = 1 + Math.round(2 * this.intensity * m.random());
      for (let i = 0; i < count; i++) {
        const behind = between(m, 1, 3);
        const size = between(m, lerp(25, 90, this.intensity), lerp(50, 170, this.intensity));
        this.spoofs.push(m.submit(this, { side, price: side === "buy" ? touch - behind : touch + behind, quantity: size }));
      }
      // The order it actually wants filled, on the other side, at the touch.
      const far = side === "buy" ? (m.bestAsk() ?? m.mid() + 1) : (m.bestBid() ?? m.mid() - 1);
      this.real = m.submit(this, { side: opposite(side), price: far, quantity: between(m, 5, 15) });
      this.baiting = true;
      this.cancelAt = m.now + between(m, 400, lerp(4_000, 1_500, this.intensity));
      this.episodes.push({ start: m.now, end: this.cancelAt });
      return;
    }
    if (m.now >= this.cancelAt) {
      for (const id of this.spoofs) m.cancel(this, id);
      if (this.real !== null) m.cancel(this, this.real);
      this.spoofs = [];
      this.real = null;
      this.baiting = false;
      this.next = m.now + between(m, 1_500, lerp(12_000, 4_000, this.intensity));
    }
  }

  override onFill(m: Market, fill: Fill): void {
    if (this.baiting && fill.orderId === this.real) this.cancelAt = Math.min(this.cancelAt, m.now + between(m, 50, 300));
  }
}

/** Layering: a ladder of orders over several levels on one side, a trade on the other, then the ladder is pulled. */
export class LayeringAgent extends Manipulator {
  private next = 0;
  private layers: string[] = [];
  private pullAt = Infinity;

  constructor(id: string, intensity: number, coverGapMs = 2_500) {
    super(id, "layering", intensity, coverGapMs);
  }

  protected manipulate(m: Market): void {
    if (this.layers.length > 0) {
      if (m.now < this.pullAt) return;
      for (const id of this.layers) m.cancel(this, id);
      this.layers = [];
      this.next = m.now + between(m, 2_000, lerp(12_000, 5_000, this.intensity));
      return;
    }
    if (m.now < this.next) return;
    const side: Side = m.random() < 0.5 ? "buy" : "sell";
    const touch = side === "buy" ? (m.bestBid() ?? m.mid() - 1) : (m.bestAsk() ?? m.mid() + 1);
    const levels = between(m, lerp(3, 5, this.intensity), lerp(4, 8, this.intensity));
    for (let i = 1; i <= levels; i++) {
      const quantity = between(m, lerp(8, 20, this.intensity), lerp(20, 45, this.intensity));
      this.layers.push(m.submit(this, { side, price: side === "buy" ? touch - i : touch + i, quantity }));
    }
    m.submit(this, { side: opposite(side), quantity: between(m, 5, 15) });
    this.pullAt = m.now + between(m, 300, lerp(4_000, 1_200, this.intensity));
    this.episodes.push({ start: m.now, end: this.pullAt });
  }
}

/**
 * Wash trading by two colluding accounts: one rests an order inside the
 * spread and the partner immediately takes it, swapping roles, so volume
 * appears while neither ends up with a position.
 */
export class WashTraderAgent extends Manipulator {
  partner!: WashTraderAgent;
  private next = 0;

  private constructor(
    id: string,
    private readonly leader: boolean,
    intensity: number,
    coverGapMs: number,
  ) {
    super(id, "wash_trading", intensity, coverGapMs);
  }

  static pair(a: string, b: string, intensity: number, coverGapMs = 2_500): [WashTraderAgent, WashTraderAgent] {
    const x = new WashTraderAgent(a, true, intensity, coverGapMs);
    const y = new WashTraderAgent(b, false, intensity, coverGapMs);
    x.partner = y;
    y.partner = x;
    return [x, y];
  }

  protected manipulate(m: Market): void {
    if (!this.leader || m.now < this.next) return;
    this.next = m.now + between(m, 800, lerp(10_000, 2_500, this.intensity));
    const bid = m.bestBid();
    const ask = m.bestAsk();
    if (bid === null || ask === null || ask - bid < 2) return; // needs room inside the spread
    const price = Math.round((bid + ask) / 2);
    const quantity = between(m, lerp(5, 10, this.intensity), lerp(15, 40, this.intensity));
    const side: Side = m.random() < 0.5 ? "buy" : "sell";
    const [rester, taker] = m.random() < 0.5 ? [this as WashTraderAgent, this.partner] : [this.partner, this as WashTraderAgent];
    m.submit(rester, { side, price, quantity });
    m.submit(taker, { side: opposite(side), price, quantity });
    for (const agent of [this, this.partner]) agent.episodes.push({ start: m.now, end: m.now + 1 });
  }
}

/**
 * Pump and dump: quietly accumulate with passive buys, push the price with a
 * burst of aggressive buying, then sell the inventory into the move.
 */
export class PumpAndDumpAgent extends Manipulator {
  private phase: "accumulate" | "pump" | "dump" | "rest" = "rest";
  private phaseEnds = 0;
  private position = 0;
  private next = 0;

  constructor(id: string, intensity: number, coverGapMs = 2_500) {
    super(id, "pump_and_dump", intensity, coverGapMs);
  }

  protected manipulate(m: Market): void {
    if (m.now >= this.phaseEnds) this.advance(m);
    if (m.now < this.next) return;
    if (this.phase === "accumulate") {
      this.next = m.now + between(m, 400, 1_500);
      m.submit(this, { side: "buy", price: m.bestBid() ?? m.mid() - 1, quantity: between(m, 5, 15) });
    } else if (this.phase === "pump") {
      this.next = m.now + between(m, 100, lerp(900, 300, this.intensity));
      m.submit(this, { side: "buy", quantity: between(m, lerp(4, 10, this.intensity), lerp(10, 30, this.intensity)) });
    } else if (this.phase === "dump" && this.position > 0) {
      this.next = m.now + between(m, 150, 600);
      m.submit(this, { side: "sell", quantity: Math.min(this.position, between(m, 10, 40)) });
    }
  }

  override onFill(_m: Market, fill: Fill): void {
    this.position += fill.side === "buy" ? fill.quantity : -fill.quantity;
  }

  private advance(m: Market): void {
    const order = ["rest", "accumulate", "pump", "dump"] as const;
    this.phase = order[(order.indexOf(this.phase) + 1) % order.length]!;
    const length = {
      rest: between(m, 5_000, lerp(30_000, 10_000, this.intensity)),
      accumulate: between(m, 10_000, 15_000),
      pump: between(m, 6_000, 10_000),
      dump: between(m, 8_000, 12_000),
    }[this.phase];
    this.phaseEnds = m.now + length;
    if (this.phase !== "rest") this.episodes.push({ start: m.now, end: this.phaseEnds });
  }
}

/**
 * Quote stuffing: bursts of many orders far from the touch, cancelled almost
 * at once, to flood the market with messages. The classifier is never shown
 * this pattern; it measures whether the anomaly detector catches the unknown.
 */
export class QuoteStufferAgent extends Manipulator {
  private next = 0;
  private burstEnds = 0;
  private live: { id: string; at: number }[] = [];

  constructor(id: string, intensity: number, coverGapMs = 2_500) {
    super(id, "quote_stuffing", intensity, coverGapMs);
  }

  protected manipulate(m: Market): void {
    for (const o of this.live.splice(0)) {
      if (o.at <= m.now) m.cancel(this, o.id);
      else this.live.push(o);
    }
    if (m.now >= this.burstEnds) {
      if (m.now < this.next) return;
      this.burstEnds = m.now + between(m, 2_000, 5_000);
      this.next = this.burstEnds + between(m, lerp(30_000, 10_000, this.intensity), lerp(45_000, 20_000, this.intensity));
      this.episodes.push({ start: m.now, end: this.burstEnds });
    }
    for (let i = 0; i < lerp(1, 4, this.intensity); i++) {
      const side: Side = m.random() < 0.5 ? "buy" : "sell";
      const away = between(m, 10, 30);
      const price = side === "buy" ? m.mid() - away : m.mid() + away;
      this.live.push({ id: m.submit(this, { side, price, quantity: between(m, 1, 5) }), at: m.now + between(m, 50, 200) });
    }
  }
}
