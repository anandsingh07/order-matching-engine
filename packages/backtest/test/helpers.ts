import { fileURLToPath } from "node:url";
import type { Instrument, Side } from "@ome/client";
import { BTCUSDT, loadMarketData, siblingKlines } from "../src/index.js";
import type { Fill, MarketData, MarketTrade, Strategy, StrategyContext } from "../src/index.js";

/** Whole-dollar prices and whole units, so ticks x units are dollars and hand sums are exact. */
export const TOY: Instrument = { symbol: "TOY", name: "Toy", currency: "USD", priceScale: 1, quantityScale: 1, tickSize: 1, lotSize: 1, referencePrice: 100 };

export const FIXTURE = fileURLToPath(new URL("./fixtures/btcusdt-2026-10-23T1430Z.aggtrades.csv", import.meta.url));
export const FIXTURE_KLINES = fileURLToPath(new URL("./fixtures/btcusdt-2026-10-23T1430Z.klines.csv", import.meta.url));

let fixture: MarketData | undefined;
/** The real 30 minutes of BTC/USDT, with its warm-up klines (loaded once). */
export function realData(): MarketData {
  fixture ??= loadMarketData(FIXTURE, BTCUSDT, { warmup: siblingKlines(FIXTURE) });
  return fixture;
}

export const t = (time: number, price: number, quantity: number, takerSide: Side): MarketTrade => ({ time, price, quantity, takerSide });

export const tape = (...trades: MarketTrade[]): MarketData => ({ kind: "trades", symbol: "TOY", trades, warmup: [] });

/** A strategy that runs `steps[time]` at those times (after the tape at the same time), plus any extra callbacks. */
export function scripted(steps: Record<number, (ctx: StrategyContext) => void>, extra: Partial<Strategy> = {}): Strategy {
  return {
    name: "scripted",
    init: (ctx) => {
      for (const time of Object.keys(steps)) ctx.setTimer(Number(time) - ctx.now, time);
    },
    onTimer: (ctx, tag) => steps[Number(tag)]?.(ctx),
    ...extra,
  };
}

/** sum over fills of side x quantity x (mark - price), minus fees: what the identity says equity has gained. */
export function gainFromFills(fills: readonly Fill[], mark: number, scale: number): number {
  return fills.reduce((s, f) => s + ((f.side === "buy" ? 1 : -1) * f.quantity * (mark - f.price)) / scale - f.fee, 0);
}
