import { appendFileSync, readFileSync } from "node:fs";
import { toUnits, type Instrument, type Side, type TradingClient } from "@ome/client";

/** One real trade from the Binance feed, with prices kept as exact decimal strings. */
export interface RawTrade {
  price: string;
  quantity: string;
  /** True if the buyer was the resting order, i.e. a seller was the aggressor. */
  buyerIsMaker: boolean;
  time: number;
}

/**
 * Public market-data endpoints (no account or key needed). The data-stream
 * mirror works on networks where the main host is blocked or slow.
 */
export const BINANCE_STREAMS = ["wss://data-stream.binance.vision/ws", "wss://stream.binance.com:9443/ws"];

/** Parses a Binance `<symbol>@trade` stream message. */
export function parseBinanceTrade(data: string): RawTrade | null {
  try {
    const m = JSON.parse(data) as { e?: string; p?: unknown; q?: unknown; m?: unknown; T?: unknown };
    if (m.e !== "trade" || typeof m.p !== "string" || typeof m.q !== "string" || typeof m.m !== "boolean" || typeof m.T !== "number") {
      return null;
    }
    return { price: m.p, quantity: m.q, buyerIsMaker: m.m, time: m.T };
  } catch {
    return null;
  }
}

/**
 * Live trade stream for one Binance symbol. Tries each host in turn and
 * reconnects with backoff, so a dropped connection never stops the bots.
 */
export class BinanceTradeFeed {
  private socket: WebSocket | undefined;
  private stopped = false;
  private attempt = 0;

  constructor(
    private readonly symbol: string,
    private readonly onTrade: (trade: RawTrade) => void,
    private readonly hosts = BINANCE_STREAMS,
    private readonly log: (line: string) => void = () => {},
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const host = this.hosts[this.attempt % this.hosts.length]!;
    const socket = new WebSocket(`${host}/${this.symbol.toLowerCase()}@trade`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.log(`binance: connected to ${host}`);
    });
    socket.addEventListener("message", (event) => {
      const trade = parseBinanceTrade(String(event.data));
      if (trade !== null) this.onTrade(trade);
    });
    socket.addEventListener("close", () => {
      if (this.stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++);
      this.log(`binance: disconnected from ${host}, retrying in ${delay} ms`);
      setTimeout(() => this.connect(), delay);
    });
  }
}

/** Appends trades to a JSON Lines file, so a live session can be replayed later. */
export function recordTo(path: string): (trade: RawTrade) => void {
  return (trade) => appendFileSync(path, `${JSON.stringify(trade)}\n`);
}

/**
 * Replays recorded trades with their original timing, `speed` times faster.
 * Resolves when the file is exhausted or `signal` is aborted.
 */
export async function replay(path: string, onTrade: (trade: RawTrade) => void, speed = 1, signal?: AbortSignal): Promise<number> {
  const trades = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RawTrade);
  let previous = trades[0]?.time ?? 0;
  let count = 0;
  for (const trade of trades) {
    if (signal?.aborted) break;
    const wait = (trade.time - previous) / speed;
    previous = trade.time;
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)));
    onTrade(trade);
    count++;
  }
  return count;
}

/**
 * Mirrors the real BTC/USDT market on the local exchange.
 *
 * Each real trade updates the fair price (which the BTC market maker quotes
 * around) and is re-sent as an IOC order on the same side at the same size,
 * with a small price band so it crosses the local quotes. The local tape then
 * follows the real one. Trades arriving within one `batchMs` window are summed
 * per side, which keeps the bot well inside the gateway rate limit even during
 * bursts on Binance.
 */
export class BinanceFollower {
  /** Latest real price in ticks; null until the first trade arrives. */
  fairPrice: number | null = null;
  received = 0;
  sent = 0;
  private batch = new Map<Side, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly client: TradingClient,
    private readonly instrument: Instrument,
    private readonly options = { batchMs: 100, bandBps: 10 },
  ) {}

  start(): void {
    this.timer = setInterval(() => this.flush(), this.options.batchMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  onTrade(trade: RawTrade): void {
    const price = toUnits(trade.price, this.instrument.priceScale);
    const quantity = toUnits(trade.quantity, this.instrument.quantityScale);
    if (price === null || quantity === null || price <= 0) return;
    this.received++;
    this.fairPrice = Math.round(price / this.instrument.tickSize) * this.instrument.tickSize;
    const side: Side = trade.buyerIsMaker ? "sell" : "buy";
    this.batch.set(side, (this.batch.get(side) ?? 0) + Math.max(this.instrument.lotSize, quantity));
  }

  private flush(): void {
    if (this.fairPrice === null || !this.client.open) return;
    const band = Math.max(this.instrument.tickSize, Math.round((this.fairPrice * this.options.bandBps) / 10_000));
    for (const [side, total] of this.batch) {
      const quantity = Math.floor(total / this.instrument.lotSize) * this.instrument.lotSize;
      if (quantity <= 0) continue;
      const raw = side === "buy" ? this.fairPrice + band : this.fairPrice - band;
      const price = Math.round(raw / this.instrument.tickSize) * this.instrument.tickSize;
      this.sent++;
      void this.client.placeOrder(this.instrument.symbol, this.client.newOrderId("bn"), {
        type: "limit",
        side,
        price,
        quantity,
        timeInForce: "IOC",
      });
    }
    this.batch = new Map();
  }
}
