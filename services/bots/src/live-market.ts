import type { Instrument, TradingClient } from "@ome/client";
import type { Agent, Market, OrderRequest } from "@ome/surveillance";

/**
 * Runs the surveillance simulator's agents against a live gateway.
 *
 * Agents think in whole ticks of 1; this market converts to and from the
 * instrument's real tick grid, so the same SpooferAgent that produced the
 * training data can trade over a WebSocket. Each agent trades through its own
 * client (its own trader account).
 */
export class LiveMarket implements Market {
  readonly random: () => number;
  private bids: { price: number; quantity: number }[] = [];
  private asks: { price: number; quantity: number }[] = [];
  private readonly prices: number[] = [];
  /** Orders believed live: sent and not yet seen cancelled or fully filled. */
  private readonly live = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(
    private readonly instrument: Instrument,
    private readonly agents: Agent[],
    private readonly clients: Map<string, TradingClient>,
    random: () => number,
  ) {
    this.random = random;
    const watcher = clients.get(agents[0]!.id)!;
    this.unsubscribers.push(
      watcher.on("book", (m) => {
        if (m.symbol !== instrument.symbol) return;
        this.bids = m.bids;
        this.asks = m.asks;
      }),
      watcher.on("trade", (m) => {
        if (m.symbol !== instrument.symbol) return;
        this.prices.push(m.trade.price / instrument.tickSize);
        if (this.prices.length > 2_000) this.prices.splice(0, 1_000);
      }),
    );
    watcher.subscribe([`book:${instrument.symbol}`, `trades:${instrument.symbol}`]);
    for (const agent of agents) this.listen(agent);
  }

  get now(): number {
    return Date.now();
  }

  /** Live, there is no hidden "true value": anchor to the market itself. */
  get fair(): number {
    return this.mid();
  }

  start(stepMs = 50): void {
    this.timer = setInterval(() => {
      for (const agent of this.agents) agent.act(this);
    }, stepMs);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const off of this.unsubscribers) off();
  }

  bestBid(): number | null {
    return this.bids[0] === undefined ? null : this.bids[0].price / this.instrument.tickSize;
  }

  bestAsk(): number | null {
    return this.asks[0] === undefined ? null : this.asks[0].price / this.instrument.tickSize;
  }

  mid(): number {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid !== null && ask !== null) return (bid + ask) / 2;
    return this.prices.at(-1) ?? this.instrument.referencePrice / this.instrument.tickSize;
  }

  recentPrices(): readonly number[] {
    return this.prices;
  }

  isLive(orderId: string): boolean {
    return this.live.has(orderId);
  }

  submit(agent: Agent, request: OrderRequest): string {
    const client = this.clients.get(agent.id)!;
    const id = client.newOrderId("sim");
    const quantity = request.quantity * this.instrument.lotSize;
    if (request.price === undefined) {
      void client.placeOrder(this.instrument.symbol, id, { type: "market", side: request.side, quantity });
    } else {
      this.live.set(id, quantity);
      const price = Math.round(request.price) * this.instrument.tickSize;
      // Colluding wash traders must be allowed to trade with each other's orders; everyone else keeps the default.
      void client.placeOrder(this.instrument.symbol, id, { type: "limit", side: request.side, price, quantity, selfTrade: "cancel_maker" }).then((r) => {
        if (r.type !== "ack") this.live.delete(id);
      });
    }
    return id;
  }

  cancel(agent: Agent, orderId: string): void {
    if (!this.live.has(orderId)) return;
    void this.clients.get(agent.id)!.cancel(this.instrument.symbol, orderId);
  }

  private listen(agent: Agent): void {
    const client = this.clients.get(agent.id)!;
    this.unsubscribers.push(
      client.on("execution", (m) => {
        if (m.symbol !== this.instrument.symbol) return;
        if (m.event === "cancelled" || m.event === "rejected") this.live.delete(m.clientOrderId);
        if (m.event !== "fill") return;
        const left = (this.live.get(m.clientOrderId) ?? 0) - m.quantity;
        if (left > 0) this.live.set(m.clientOrderId, left);
        else this.live.delete(m.clientOrderId);
        agent.onFill(this, { orderId: m.clientOrderId, side: m.side, price: m.price / this.instrument.tickSize, quantity: m.quantity });
      }),
    );
  }
}
