import type { Instrument, TradingClient } from "@ome/client";
import { OrderTracker, type OpenOrder } from "./order-tracker.js";
import type { Quote } from "./quotes.js";

export interface QuotingOptions {
  /**
   * Move a resting quote to its new price with one amend, instead of a cancel
   * and a new order. Half the actions, and the side is never empty between
   * the two; the amended quote goes to the back of the queue at its new price,
   * as a new order would. Off by default: the stock ladders keep cancel-and-place.
   */
  amend?: boolean;
}

/**
 * The machinery every quoting strategy shares; a strategy only says which
 * quotes it wants (`desiredQuotes`).
 *
 * Every `intervalMs` it diffs the wanted quotes against the orders it has: it
 * cancels only quotes that are no longer wanted, and places only the ones that
 * are missing. Unchanged quotes keep their place in the queue.
 *
 * A strategy can move every quote at once, so the bot also keeps its own
 * action budget (a token bucket) below the gateway's rate limit. When the
 * budget runs short, it sends cancels first, then the quotes nearest the best
 * price (strategies list those first), and the rest wait for the next cycle.
 * With the `amend` option a quote that only needs a new price is moved in one
 * action, before any cancel, so a short budget leaves it where it was instead
 * of leaving the side empty.
 */
export abstract class QuotingBot {
  readonly tracker: OrderTracker;
  /** Quotes sent but not yet acknowledged, by "side:price", so they are not sent twice. */
  private readonly inflight = new Set<string>();
  /** Resting quotes with an amend on its way: left alone until it is acknowledged. */
  private readonly amending = new Set<string>();
  private readonly rejects = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly unsubscribe: () => void;
  /** The gateway's latest volatility forecast for this symbol, in percent. */
  protected sigmaPct: number | null = null;
  private tokens: number;
  private refilled = performance.now();

  constructor(
    protected readonly client: TradingClient,
    protected readonly instrument: Instrument,
    protected readonly fair: () => number,
    private readonly perSecond: number,
    private readonly intervalMs: number,
    private readonly options: QuotingOptions = {},
  ) {
    this.tracker = new OrderTracker(instrument.symbol);
    const offExecution = client.on("execution", (m) => this.tracker.handle(m));
    const offStatus = client.on("status", (m) => {
      if (m.symbol === instrument.symbol) this.sigmaPct = m.volatility?.sigmaPct ?? null;
    });
    this.unsubscribe = () => {
      offExecution();
      offStatus();
    };
    this.tokens = perSecond;
  }

  /** The quotes the strategy wants now, nearest the touch first. */
  protected abstract desiredQuotes(): Quote[] | Promise<Quote[]>;

  /** Reject reasons seen so far, for monitoring and tests. */
  get rejectCounts(): ReadonlyMap<string, number> {
    return this.rejects;
  }

  start(): void {
    void this.requote();
    this.timer = setInterval(() => void this.requote(), this.intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.unsubscribe();
    while (this.busy) await new Promise((r) => setTimeout(r, 5));
    await Promise.all([...this.tracker.open.keys()].map((id) => this.client.cancel(this.instrument.symbol, id)));
  }

  async requote(): Promise<void> {
    if (this.busy || !this.client.open) return;
    this.busy = true;
    try {
      this.refill();
      const desired = await this.desiredQuotes();
      const key = (side: string, price: number) => `${side}:${price}`;
      const wanted = new Map(desired.map((q) => [key(q.side, q.price), q]));
      const have = new Set<string>();
      const actions: Promise<unknown>[] = [];

      const stale: [string, OpenOrder][] = [];
      for (const [id, order] of this.tracker.open) {
        if (this.amending.has(id)) continue;
        const k = key(order.side, order.price);
        if (wanted.has(k) && !have.has(k)) have.add(k);
        else stale.push([id, order]);
      }
      if (this.options.amend === true) {
        for (const [id, , quote] of this.amendments(stale, [...wanted].filter(([k]) => !have.has(k) && !this.inflight.has(k)))) {
          // Out of budget: the old quote stays where it is rather than leaving the side empty.
          if (!this.spend()) break;
          const k = key(quote.side, quote.price);
          stale.splice(stale.findIndex(([s]) => s === id), 1);
          have.add(k);
          this.inflight.add(k);
          this.amending.add(id);
          actions.push(
            this.client.amend(this.instrument.symbol, id, { price: quote.price, quantity: quote.quantity }).then((r) => {
              this.inflight.delete(k);
              this.amending.delete(id);
              this.count(r);
            }),
          );
        }
      }
      for (const [id] of stale) {
        if (this.spend()) actions.push(this.client.cancel(this.instrument.symbol, id).then((r) => this.count(r)));
      }
      for (const [k, quote] of wanted) {
        if (have.has(k) || this.inflight.has(k)) continue;
        if (!this.spend()) break;
        this.inflight.add(k);
        const order = { type: "limit" as const, side: quote.side, price: quote.price, quantity: quote.quantity };
        actions.push(
          this.client.placeOrder(this.instrument.symbol, this.client.newOrderId("mm"), order).then((r) => {
            this.inflight.delete(k);
            this.count(r);
          }),
        );
      }
      await Promise.all(actions);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Pairs stale quotes with missing ones on the same side, nearest the touch
   * first. When the quotes move up the offers go first, and when they move
   * down the bids, so a bid never crosses the bot's own offer on the way.
   */
  private amendments(stale: [string, OpenOrder][], missing: [string, Quote][]): [string, OpenOrder, Quote][] {
    const pairs: [string, OpenOrder, Quote][] = [];
    for (const side of ["buy", "sell"] as const) {
      const from = stale.filter(([, o]) => o.side === side).sort(([, a], [, b]) => (side === "buy" ? b.price - a.price : a.price - b.price));
      const to = missing.map(([, q]) => q).filter((q) => q.side === side);
      for (let i = 0; i < Math.min(from.length, to.length); i++) pairs.push([from[i]![0], from[i]![1], to[i]!]);
    }
    const up = pairs.reduce((sum, [, o, q]) => sum + (q.price - o.price), 0) > 0;
    const first = up ? "sell" : "buy";
    return [...pairs.filter(([, o]) => o.side === first), ...pairs.filter(([, o]) => o.side !== first)];
  }

  private refill(): void {
    const now = performance.now();
    this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.refilled) / 1000) * this.perSecond);
    this.refilled = now;
  }

  private spend(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private count(result: { type: string; reason?: string; message?: string }): void {
    if (result.type === "ack") return;
    const reason = result.reason ?? result.message ?? result.type;
    this.rejects.set(reason, (this.rejects.get(reason) ?? 0) + 1);
  }
}
