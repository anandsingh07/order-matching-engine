import { TradingClient, type ClientOrder, type DepthLevel, type Instrument, type PublicTrade } from "@ome/client";
import { Exchange } from "@ome/exchange";
import { DEFAULT_INSTRUMENTS, Gateway } from "@ome/gateway";
import { describe, expect, it } from "vitest";
import { MarketMaker, NoiseTrader, prng } from "../src/index.js";

describe("bots against a real gateway", () => {
  it("market makers and noise traders create a live, two-sided market", async () => {
    const exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
    const gateway = await Gateway.create({ exchange, bookIntervalMs: 20, botKey: "test-bot-key" });
    const url = await gateway.listen(0);
    const tcs = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "TCS") as Instrument;
    try {
      const mmClient = await TradingClient.connect(url, "mm", { botKey: "test-bot-key" });
      const maker = new MarketMaker(
        mmClient,
        tcs,
        () => tcs.referencePrice,
        { levels: 5, halfSpreadBps: 4, stepBps: 3, size: 25, maxPosition: 200, skewBps: 8 },
        50,
      );
      maker.start();

      const noiseClient = await TradingClient.connect(url, "noise", { botKey: "test-bot-key" });
      const noise = new NoiseTrader(noiseClient, [tcs], prng(7), { meanIntervalMs: 10, maxLots: 20, marketShare: 0.5, restMs: 300 });
      noise.start();

      await new Promise((r) => setTimeout(r, 2_000));
      noise.stop();
      await maker.stop();

      const trades = (await (await fetch(`${url}/api/trades/TCS`)).json()) as PublicTrade[];
      expect(noise.sent).toBeGreaterThan(50);
      expect(trades.length).toBeGreaterThan(20);
      // Every trade is near fair value: within the market maker's 5-level ladder.
      for (const t of trades) expect(Math.abs(t.price - tcs.referencePrice) / tcs.referencePrice).toBeLessThan(0.002);
      // Inventory control kept the position inside its limit (plus at most one quote of overshoot).
      expect(Math.abs(maker.tracker.position)).toBeLessThanOrEqual(200 + 25);
      expect(maker.tracker.fills).toBeGreaterThan(0);
      // Cancels can race with fills ("unknown_order"); anything else is a bug.
      const unexpected = (m: ReadonlyMap<string, number>) => [...m.keys()].filter((r) => r !== "unknown_order");
      expect(unexpected(maker.rejectCounts)).toEqual([]);
      expect(unexpected(noise.rejects)).toEqual([]);

      mmClient.close();
      noiseClient.close();
    } finally {
      await gateway.close();
      await exchange.stop();
    }
  }, 30_000);
});

describe("noise trader on a one-sided book", () => {
  /** Just enough of a TradingClient: book messages in, orders recorded. */
  function fakeClient() {
    let onBook: ((m: { symbol: string; bids: DepthLevel[]; asks: DepthLevel[] }) => void) | undefined;
    let n = 0;
    const orders: ClientOrder[] = [];
    const client = {
      open: true,
      on: (type: string, listener: typeof onBook) => {
        if (type === "book") onBook = listener;
        return () => {};
      },
      subscribe: () => {},
      newOrderId: (prefix = "o") => `${prefix}${++n}`,
      placeOrder: async (_symbol: string, _id: string, order: ClientOrder) => (orders.push(order), { type: "ack" as const }),
      cancel: async () => ({ type: "ack" as const }),
    };
    return { client: client as unknown as TradingClient, orders, book: (bids: DepthLevel[], asks: DepthLevel[]) => onBook!({ symbol: "TCS", bids, asks }) };
  }
  const tcs = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "TCS") as Instrument;
  const run = async (setup: (book: ReturnType<typeof fakeClient>["book"]) => void) => {
    const fake = fakeClient();
    const noise = new NoiseTrader(fake.client, [tcs], prng(11), { meanIntervalMs: 2, maxLots: 5, marketShare: 0.3, restMs: 60_000 });
    setup(fake.book);
    noise.start();
    await new Promise((r) => setTimeout(r, 300));
    noise.stop();
    return fake.orders;
  };

  it("waits for a first quote", async () => {
    expect(await run(() => {})).toEqual([]);
    expect(await run((book) => book([], []))).toEqual([]);
  });

  it("keeps trading when a market maker at its position limit quotes only one side", async () => {
    // A market maker long to its limit offers at Rs 4,100 and bids nothing.
    const orders = await run((book) => book([], [{ price: 410_000, quantity: 25, orders: 1 }]));
    expect(orders.length).toBeGreaterThan(20);
    const buys = orders.filter((o) => o.side === "buy");
    // Market buys and limit buys at or above the offer take it, reducing the maker's position...
    expect(buys.some((o) => o.type === "market" || (o.type === "limit" && o.price >= 410_000))).toBe(true);
    // ...and limit buys below it rest as the new bid, so the book is two-sided again.
    expect(buys.some((o) => o.type === "limit" && o.price < 410_000)).toBe(true);
    // Nothing to sell into: no market sells, and every limit sell is priced around the offer, not at nonsense.
    const sells = orders.filter((o) => o.side === "sell");
    expect(sells.every((o) => o.type === "limit" && Math.abs(o.price - 410_000) <= 5 * tcs.tickSize)).toBe(true);
  });
});
