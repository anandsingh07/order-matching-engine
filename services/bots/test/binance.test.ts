import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientOrder, Instrument, TradingClient } from "@ome/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFollower, parseBinanceTrade, recordTo, replay, type RawTrade } from "../src/index.js";

const BTC: Instrument = {
  symbol: "BTCUSDT",
  name: "Bitcoin / Tether",
  currency: "USDT",
  priceScale: 100,
  quantityScale: 100_000,
  tickSize: 1,
  lotSize: 1,
  referencePrice: 8_000_000,
};

/** Records orders instead of sending them. */
function fakeClient() {
  const orders: { symbol: string; order: ClientOrder }[] = [];
  let n = 0;
  const client = {
    open: true,
    newOrderId: () => `x${n++}`,
    placeOrder: async (symbol: string, _id: string, order: ClientOrder) => {
      orders.push({ symbol, order });
      return { type: "ack" as const, reqId: n, clientOrderId: _id };
    },
  } as unknown as TradingClient;
  return { client, orders };
}

const trade = (price: string, quantity: string, buyerIsMaker: boolean, time = 0): RawTrade => ({ price, quantity, buyerIsMaker, time });

afterEach(() => {
  vi.useRealTimers();
});

describe("Binance feed", () => {
  it("parses real trade stream messages and ignores anything else", () => {
    // A real message captured from wss://data-stream.binance.vision/ws/btcusdt@trade
    const real = '{"e":"trade","E":1792843814135,"s":"BTCUSDT","t":6788264393,"p":"80605.82000000","q":"0.00012000","T":1792843814135,"m":false,"M":true}';
    expect(parseBinanceTrade(real)).toEqual({ price: "80605.82000000", quantity: "0.00012000", buyerIsMaker: false, time: 1792843814135 });
    expect(parseBinanceTrade('{"e":"depthUpdate"}')).toBeNull();
    expect(parseBinanceTrade("not json")).toBeNull();
    expect(parseBinanceTrade('{"e":"trade","p":1,"q":"1","m":true,"T":1}')).toBeNull();
  });

  it("mirrors real trades as IOC orders on the aggressor's side, batched per side", () => {
    vi.useFakeTimers();
    const { client, orders } = fakeClient();
    const follower = new BinanceFollower(client, BTC, { batchMs: 100, bandBps: 10 });
    follower.start();
    follower.onTrade(trade("80605.82", "0.00012", false)); // buyer aggressed
    follower.onTrade(trade("80605.90", "0.00100", false));
    follower.onTrade(trade("80604.00", "0.25000", true)); // seller aggressed
    expect(follower.fairPrice).toBe(8_060_400);
    vi.advanceTimersByTime(100);
    follower.stop();

    // 10 bps band around the last price so the orders cross local quotes.
    expect(orders).toEqual([
      { symbol: "BTCUSDT", order: { type: "limit", side: "buy", price: 8_068_460, quantity: 112, timeInForce: "IOC" } },
      { symbol: "BTCUSDT", order: { type: "limit", side: "sell", price: 8_052_340, quantity: 25_000, timeInForce: "IOC" } },
    ]);
  });

  it("records a session and replays it with its original timing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ome-replay-"));
    try {
      const file = join(dir, "btc.jsonl");
      const record = recordTo(file);
      const recorded = [trade("100.00", "1", false, 1_000), trade("101.00", "2", true, 1_200), trade("102.00", "3", false, 1_600)];
      recorded.forEach(record);

      const seen: { trade: RawTrade; at: number }[] = [];
      const start = performance.now();
      const count = await replay(file, (t) => seen.push({ trade: t, at: performance.now() - start }), 4);
      expect(count).toBe(3);
      expect(seen.map((s) => s.trade)).toEqual(recorded);
      // 600 ms of recorded time at 4x speed is about 150 ms.
      expect(seen.at(-1)!.at).toBeGreaterThanOrEqual(140);
      expect(seen.at(-1)!.at).toBeLessThan(1_000);

      const abort = new AbortController();
      abort.abort();
      expect(await replay(file, () => {}, 1, abort.signal)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
