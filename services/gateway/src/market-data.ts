import type { Depth } from "@ome/core";
import { CandleSeries, INTERVALS, type Interval } from "./candles.js";
import type { PublicTrade, ServerMessage } from "./protocol.js";

export interface Subscriber {
  /** `essential` messages must not be dropped; market data may be, for slow clients. */
  deliver(message: ServerMessage, essential: boolean): void;
}

/** What a session subscribes through: MarketData itself, or a front-end process's view of it (cluster/pool.ts). */
export interface MarketSubscriptions {
  subscribe(subscriber: Subscriber, name: string): boolean;
  unsubscribe(subscriber: Subscriber, name: string): void;
  unsubscribeAll(subscriber: Subscriber): void;
}

type Channel =
  | { kind: "book"; symbol: string }
  | { kind: "trades"; symbol: string }
  | { kind: "candles"; symbol: string; interval: Interval };

const RECENT_TRADES = 200;

/**
 * Public market data: trade prints, OHLCV candles, and order-book depth.
 *
 * Channels are "book:SYM", "trades:SYM" and "candles:SYM:5s" / "candles:SYM:1m".
 * Trades and candles are pushed as they happen. Book updates are conflated:
 * a symbol is marked dirty when its book changes, and `publishBooks` (on a
 * timer) sends one fresh depth snapshot per dirty symbol. A burst of 1,000
 * orders then costs one depth query, not 1,000.
 */
export class MarketData {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly recent = new Map<string, PublicTrade[]>();
  private readonly candles = new Map<string, Map<Interval, CandleSeries>>();
  private readonly dirty = new Set<string>();
  private readonly symbols = new Set<string>();
  private publishing = false;

  constructor(
    symbols: ReadonlySet<string>,
    private readonly depth: (symbol: string) => Promise<Depth>,
    private readonly now: () => number,
  ) {
    for (const symbol of symbols) this.add(symbol);
  }

  /** Starts serving a newly listed symbol. */
  add(symbol: string): void {
    if (this.symbols.has(symbol)) return;
    this.symbols.add(symbol);
    this.recent.set(symbol, []);
    const series = new Map<Interval, CandleSeries>();
    for (const [interval, ms] of Object.entries(INTERVALS)) series.set(interval as Interval, new CandleSeries(ms));
    this.candles.set(symbol, series);
  }

  /** Forgets a delisted symbol: its history and its channels' subscribers. Returns the channel names. */
  remove(symbol: string): string[] {
    this.symbols.delete(symbol);
    this.recent.delete(symbol);
    this.candles.delete(symbol);
    this.dirty.delete(symbol);
    const channels = [`book:${symbol}`, `trades:${symbol}`, ...Object.keys(INTERVALS).map((i) => `candles:${symbol}:${i}`)];
    for (const channel of channels) this.subscribers.delete(channel);
    return channels;
  }

  parse(name: string): Channel | null {
    const [kind, symbol, interval] = name.split(":");
    if (symbol === undefined || !this.symbols.has(symbol)) return null;
    if (kind === "book" && interval === undefined) return { kind, symbol };
    if (kind === "trades" && interval === undefined) return { kind, symbol };
    if (kind === "candles" && interval !== undefined && interval in INTERVALS) {
      return { kind, symbol, interval: interval as Interval };
    }
    return null;
  }

  /**
   * Subscribes and sends the channel's current state. Returns false for an unknown channel.
   * With `initial: false` the state is not sent: a front-end process's subscription
   * (cluster/pool.ts) stands for many clients, and each gets the state from `sendState`.
   */
  subscribe(subscriber: Subscriber, name: string, options: { initial?: boolean } = {}): boolean {
    const channel = this.parse(name);
    if (channel === null) return false;
    let set = this.subscribers.get(name);
    if (set === undefined) this.subscribers.set(name, (set = new Set()));
    set.add(subscriber);
    if (options.initial !== false) this.sendState(subscriber, name);
    return true;
  }

  /** Sends a channel's current state: recent trades, candle history, or (once read) the book. */
  sendState(subscriber: Subscriber, name: string): void {
    const channel = this.parse(name);
    if (channel === null) return;
    if (channel.kind === "trades") {
      subscriber.deliver({ type: "trades", symbol: channel.symbol, trades: this.recentTrades(channel.symbol) }, false);
    } else if (channel.kind === "candles") {
      const candles = this.candles.get(channel.symbol)!.get(channel.interval)!.history();
      subscriber.deliver({ type: "candles", symbol: channel.symbol, interval: channel.interval, candles }, false);
    } else {
      void this.bookMessage(channel.symbol).then((message) => subscriber.deliver(message, false), () => {});
    }
  }

  unsubscribe(subscriber: Subscriber, name: string): void {
    this.subscribers.get(name)?.delete(subscriber);
  }

  unsubscribeAll(subscriber: Subscriber): void {
    for (const set of this.subscribers.values()) set.delete(subscriber);
  }

  recentTrades(symbol: string): PublicTrade[] {
    return [...(this.recent.get(symbol) ?? [])];
  }

  candleHistory(symbol: string, interval: Interval) {
    return this.candles.get(symbol)?.get(interval)?.history() ?? [];
  }

  recordTrade(symbol: string, trade: PublicTrade): void {
    const recent = this.recent.get(symbol);
    if (recent === undefined) return;
    recent.push(trade);
    if (recent.length > RECENT_TRADES) recent.shift();
    this.broadcast(`trades:${symbol}`, { type: "trade", symbol, trade });
    for (const [interval, series] of this.candles.get(symbol)!) {
      const candle = series.add(trade.price, trade.quantity, trade.time);
      this.broadcast(`candles:${symbol}:${interval}`, { type: "candle", symbol, interval, candle: { ...candle } });
    }
    this.dirty.add(symbol);
  }

  markDirty(symbol: string): void {
    this.dirty.add(symbol);
  }

  /** Sends one depth snapshot for every changed symbol that has subscribers. */
  async publishBooks(): Promise<void> {
    if (this.publishing || this.dirty.size === 0) return;
    this.publishing = true;
    try {
      const symbols = [...this.dirty].filter((s) => (this.subscribers.get(`book:${s}`)?.size ?? 0) > 0);
      this.dirty.clear();
      // A symbol delisted while its depth was being read just drops out.
      const messages = await Promise.allSettled(symbols.map((s) => this.bookMessage(s)));
      for (const m of messages) if (m.status === "fulfilled") this.broadcast(`book:${m.value.symbol}`, m.value);
    } finally {
      this.publishing = false;
    }
  }

  private async bookMessage(symbol: string): Promise<Extract<ServerMessage, { type: "book" }>> {
    const { bids, asks } = await this.depth(symbol);
    return { type: "book", symbol, bids, asks, time: this.now() };
  }

  private broadcast(channel: string, message: ServerMessage): void {
    const set = this.subscribers.get(channel);
    if (set === undefined) return;
    for (const subscriber of set) subscriber.deliver(message, false);
  }
}
