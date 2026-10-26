import type { DepthLevel, Instrument, TradingClient } from "@ome/client";
import { exponential } from "./random.js";

export interface NoiseTraderOptions {
  /** Average gap between orders. */
  meanIntervalMs: number;
  /** Order size range, in lots. */
  maxLots: number;
  /** Share of orders that are market orders; the rest are limits near the touch. */
  marketShare: number;
  /** How long a passive limit order rests before the trader cancels it. */
  restMs: number;
  /**
   * Lots per size unit, by symbol. BTC trades in 0.00001 BTC lots, so retail
   * orders of 1-20 lots would be fractions of a cent; a multiplier keeps them
   * realistic. Defaults to 1.
   */
  lotMultiplier?: Record<string, number>;
}

/**
 * Random retail-style flow: Poisson-timed orders on random instruments, a mix
 * of market orders and limit orders a few ticks either side of the best
 * price. It provides the trades that make the market move.
 */
export class NoiseTrader {
  private readonly best = new Map<string, { bid?: number; ask?: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly cancels = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private readonly unsubscribe: () => void;
  sent = 0;
  /** Reject reasons seen so far, for monitoring and tests. */
  readonly rejects = new Map<string, number>();

  constructor(
    private readonly client: TradingClient,
    private instruments: Instrument[],
    private readonly random: () => number,
    private readonly options: NoiseTraderOptions,
  ) {
    this.unsubscribe = client.on("book", (m) => this.best.set(m.symbol, { bid: top(m.bids), ask: top(m.asks) }));
  }

  start(): void {
    this.running = true;
    this.client.subscribe(this.instruments.map((i) => `book:${i.symbol}`));
    this.schedule();
  }

  /**
   * Trades a new set of instruments from now on, say when futures and options
   * series expire and new ones are listed. Books of instruments that left are
   * forgotten, so no order is sent on a stale quote.
   */
  setInstruments(instruments: Instrument[]): void {
    const before = new Set(this.instruments.map((i) => i.symbol));
    const after = new Set(instruments.map((i) => i.symbol));
    this.instruments = instruments;
    for (const symbol of before) if (!after.has(symbol)) this.best.delete(symbol);
    const added = [...after].filter((symbol) => !before.has(symbol));
    if (this.running && added.length > 0) this.client.subscribe(added.map((symbol) => `book:${symbol}`));
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    for (const t of this.cancels) clearTimeout(t);
    this.unsubscribe();
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.act();
      this.schedule();
    }, exponential(this.random, this.options.meanIntervalMs));
  }

  private act(): void {
    if (!this.client.open || this.instruments.length === 0) return;
    const instrument = this.instruments[Math.floor(this.random() * this.instruments.length)]!;
    const best = this.best.get(instrument.symbol);
    // Wait for a first quote; but a one-sided book still has a price to trade
    // around. A market maker at its position limit quotes only the side that
    // reduces it, and flow that waited for a two-sided market would never take
    // that side: the book would stay one-sided and the stock stop trading for
    // good (seen in the derivatives live check, where the options desk's delta
    // hedges pushed the stock's market maker to its limit).
    if (best === undefined || (best.bid === undefined && best.ask === undefined)) return;
    const side = this.random() < 0.5 ? "buy" : "sell";
    const multiplier = this.options.lotMultiplier?.[instrument.symbol] ?? 1;
    const quantity = instrument.lotSize * multiplier * (1 + Math.floor(this.random() * this.options.maxLots));
    const id = this.client.newOrderId("n");
    this.sent++;

    // Its own passive orders often sit at the top of the book. Self-trade
    // prevention would kill the new order (the gateway default); cancelling the
    // stale resting one instead keeps the flow going.
    const selfTrade = "cancel_maker" as const;
    // A market order needs something on the other side to take; with nothing there it is a limit order instead.
    const opposite = side === "buy" ? best.ask : best.bid;
    if (this.random() < this.options.marketShare && opposite !== undefined) {
      void this.client.placeOrder(instrument.symbol, id, { type: "market", side, quantity, selfTrade }).then((r) => this.count(r));
      return;
    }
    // Anywhere from 3 ticks inside the spread (aggressive) to 5 ticks outside it. With its own side
    // empty the order is placed around the other side's touch: across it, or resting as the new best.
    const ticks = Math.floor(this.random() * 9) - 3;
    const touch = (side === "buy" ? best.bid : best.ask) ?? opposite!;
    const price = touch - (side === "buy" ? 1 : -1) * ticks * instrument.tickSize;
    if (price <= 0) return;
    void this.client.placeOrder(instrument.symbol, id, { type: "limit", side, price, quantity, selfTrade }).then((r) => this.count(r));
    const t = setTimeout(() => {
      this.cancels.delete(t);
      // Usually filled or gone already; "unknown_order" is the normal answer then.
      void this.client.cancel(instrument.symbol, id);
    }, this.options.restMs);
    this.cancels.add(t);
  }

  private count(result: { type: string; reason?: string; message?: string }): void {
    if (result.type === "ack") return;
    const reason = result.reason ?? result.message ?? result.type;
    this.rejects.set(reason, (this.rejects.get(reason) ?? 0) + 1);
  }
}

const top = (levels: DepthLevel[]) => levels[0]?.price;
