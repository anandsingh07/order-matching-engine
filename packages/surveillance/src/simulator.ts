import { OrderBook, type EngineEvent, type Side } from "@ome/core";
import { describeOrder, TOUCH_LEVELS, TraderActivity, type ActivityEvent } from "./features.js";

/** Seedable PRNG (mulberry32), so every simulation can be reproduced exactly. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Label = "honest" | "spoofing" | "layering" | "wash_trading" | "pump_and_dump" | "quote_stuffing";
/** The classes the classifier is trained on. */
export const LABELS: readonly Label[] = ["honest", "spoofing", "layering", "wash_trading", "pump_and_dump"];
/** Manipulation the classifier never sees in training, held back to test the anomaly detector. */
export const NOVEL_LABELS: readonly Label[] = ["quote_stuffing"];

export interface OrderRequest {
  side: Side;
  /** Omit for a market order. */
  price?: number;
  quantity: number;
}

export interface Fill {
  orderId: string;
  side: Side;
  price: number;
  quantity: number;
}

/** What an agent can see and do. Times are simulated milliseconds. */
export interface Market {
  readonly now: number;
  readonly random: () => number;
  /** The "true" value of the asset, a slow random walk honest traders anchor to. */
  readonly fair: number;
  bestBid(): number | null;
  bestAsk(): number | null;
  mid(): number;
  /** Last trade prices, oldest first, for trend-following agents. */
  recentPrices(): readonly number[];
  submit(agent: Agent, order: OrderRequest): string;
  cancel(agent: Agent, orderId: string): void;
  isLive(orderId: string): boolean;
}

export abstract class Agent {
  /** Intervals during which a manipulator was actively manipulating. */
  readonly episodes: { start: number; end: number }[] = [];

  constructor(
    readonly id: string,
    readonly label: Label,
  ) {}

  abstract act(market: Market): void;

  onFill(_market: Market, _fill: Fill): void {}

  /** Whether the agent was manipulating at any time in [from, to). Honest agents never are. */
  manipulatedDuring(from: number, to: number): boolean {
    return this.episodes.some((e) => e.start < to && e.end >= from);
  }
}

export interface SimulationOptions {
  seed: number;
  /** Starting fair value, in ticks. */
  start?: number;
  /** Fair-value volatility per square-root second, as a fraction. */
  volatility?: number;
  /** Feature window length. */
  windowMs?: number;
}

/**
 * A market on a simulated clock: the real matching engine, a random-walk fair
 * value, and agents that act every step. Every order, cancel and fill is fed
 * to per-trader surveillance windows, exactly as the live gateway does.
 */
export class Simulation implements Market {
  now = 0;
  fair: number;
  readonly random: () => number;
  readonly agents: Agent[] = [];
  readonly activity = new Map<string, TraderActivity>();
  private readonly book = new OrderBook();
  private readonly owners = new Map<string, Agent>();
  private readonly prices: number[] = [];
  private nextOrder = 1;
  private readonly volatility: number;
  private readonly windowMs: number;

  constructor(options: SimulationOptions) {
    this.random = prng(options.seed);
    this.fair = options.start ?? 10_000;
    this.volatility = options.volatility ?? 0.0006;
    this.windowMs = options.windowMs ?? 30_000;
  }

  add(...agents: Agent[]): this {
    for (const a of agents) {
      this.agents.push(a);
      this.activity.set(a.id, new TraderActivity(this.windowMs));
    }
    return this;
  }

  /** Advances the clock in `stepMs` steps, calling `everyMs` hooks (e.g. feature snapshots) on the way. */
  run(durationMs: number, stepMs = 50, hook?: { everyMs: number; call: (sim: Simulation) => void }): void {
    const end = this.now + durationMs;
    let nextHook = hook === undefined ? Infinity : this.now + hook.everyMs;
    while (this.now < end) {
      this.now += stepMs;
      const z = Math.sqrt(-2 * Math.log(Math.max(this.random(), 1e-12))) * Math.cos(2 * Math.PI * this.random());
      this.fair = Math.max(100, this.fair * Math.exp(this.volatility * Math.sqrt(stepMs / 1000) * z));
      for (const agent of this.agents) agent.act(this);
      if (this.now >= nextHook) {
        hook!.call(this);
        nextHook += hook!.everyMs;
      }
    }
  }

  bestBid(): number | null {
    return this.book.bestBid();
  }

  bestAsk(): number | null {
    return this.book.bestAsk();
  }

  mid(): number {
    const bid = this.book.bestBid();
    const ask = this.book.bestAsk();
    if (bid !== null && ask !== null) return (bid + ask) / 2;
    return this.book.lastTradePrice() ?? Math.round(this.fair);
  }

  recentPrices(): readonly number[] {
    return this.prices;
  }

  isLive(orderId: string): boolean {
    return this.book.getOrder(orderId) !== undefined;
  }

  submit(agent: Agent, request: OrderRequest): string {
    const id = `${agent.id}#${this.nextOrder++}`;
    this.owners.set(id, agent);
    this.activity.get(agent.id)!.record(this.describe(id, request));
    const events =
      request.price === undefined
        ? this.book.submit({ type: "market", id, traderId: agent.id, side: request.side, quantity: request.quantity })
        : this.book.submit({ type: "limit", id, traderId: agent.id, side: request.side, price: Math.round(request.price), quantity: request.quantity });
    this.dispatch(events);
    return id;
  }

  cancel(agent: Agent, orderId: string): void {
    if (!this.isLive(orderId)) return;
    this.activity.get(agent.id)!.record({ kind: "cancel", time: this.now, orderId });
    this.dispatch(this.book.cancel(orderId));
  }

  /** The order as surveillance sees it on arrival, measured against the book before it matches. */
  private describe(orderId: string, request: OrderRequest): ActivityEvent {
    const price = request.price === undefined ? null : Math.round(request.price);
    return describeOrder(this.book.depth(TOUCH_LEVELS), orderId, this.now, request.side, price, request.quantity);
  }

  private dispatch(events: EngineEvent[]): void {
    for (const e of events) {
      if (e.type !== "trade") continue;
      this.prices.push(e.price);
      if (this.prices.length > 2_000) this.prices.splice(0, 1_000);
      const maker = this.owners.get(e.makerOrderId)!;
      const taker = this.owners.get(e.takerOrderId)!;
      const makerSide: Side = e.takerSide === "buy" ? "sell" : "buy";
      for (const [agent, orderId, side, liquidity, other] of [
        [maker, e.makerOrderId, makerSide, "maker", taker],
        [taker, e.takerOrderId, e.takerSide, "taker", maker],
      ] as const) {
        const activity = this.activity.get(agent.id)!;
        activity.record({ kind: "fill", time: this.now, orderId, side, quantity: e.quantity, liquidity, counterpartyId: other.id });
        if (!this.isLive(orderId)) activity.closed(orderId);
        agent.onFill(this, { orderId, side, price: e.price, quantity: e.quantity });
      }
    }
  }
}
