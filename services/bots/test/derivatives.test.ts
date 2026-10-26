import { TradingClient, type DepthLevel, type Instrument } from "@ome/client";
import { Exchange } from "@ome/exchange";
import { DEFAULT_INSTRUMENTS, Gateway } from "@ome/gateway";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { greeks, noArbitrageBounds, yearsUntil } from "../src/pricing.js";
import { DEFAULT_DERIVATIVES_MAKER, DerivativesMarketMaker, keepCloseQuotes, MarketMaker, QuotingBot, seriesQuotes, type DeskState, type Quote } from "../src/index.js";

const NOW = Date.UTC(2026, 9, 25, 10, 0);
const P = DEFAULT_DERIVATIVES_MAKER;

const series = (kind: "future" | "call" | "put", strike: number, expiry: number): Instrument => ({
  symbol: `TCS-X-${kind}${strike}`,
  name: "test",
  currency: "INR",
  priceScale: 100,
  quantityScale: 1,
  tickSize: 5,
  lotSize: 1,
  referencePrice: 1,
  underlying: "TCS",
  expiry,
  multiplier: 10,
  ...(kind === "future" ? { kind: "future" as const } : { kind: "option" as const, right: kind, strike }),
});

/** A series and the desk's state: anything from deep out of to deep in the money, seconds to an hour from expiry. */
const scenario = fc
  .record({
    kind: fc.constantFrom("future" as const, "call" as const, "put" as const),
    spot: fc.integer({ min: 20_000, max: 2_000_000 }),
    moneyness: fc.double({ min: -0.15, max: 0.15, noNaN: true }),
    msLeft: fc.integer({ min: P.stopBeforeExpiryMs + 1, max: 3_600_000 }),
    volatility: fc.double({ min: 0.2, max: 8, noNaN: true }),
    delta: fc.double({ min: -1_200, max: 1_200, noNaN: true }),
    vega: fc.double({ min: -400, max: 400, noNaN: true }),
    position: fc.integer({ min: -60, max: 60 }),
  })
  .map((s) => {
    const strike = Math.max(5, Math.round((s.spot * Math.exp(s.moneyness)) / 5) * 5);
    const state: DeskState = { spot: s.spot, volatility: s.volatility, now: NOW, delta: s.delta, vega: s.vega };
    return { ...s, instrument: series(s.kind, strike, NOW + s.msLeft), state };
  });

function checkQuotes(instrument: Instrument, state: DeskState, quotes: { side: string; price: number; quantity: number }[]) {
  const bid = quotes.find((q) => q.side === "buy");
  const ask = quotes.find((q) => q.side === "sell");
  for (const q of quotes) {
    expect(q.price % instrument.tickSize).toBe(0);
    expect(q.price).toBeGreaterThan(0);
  }
  if (bid !== undefined && ask !== undefined) expect(bid.price).toBeLessThan(ask.price);
  if (instrument.kind === "option") {
    const { lower, upper } = noArbitrageBounds({ right: instrument.right!, spot: state.spot, strike: instrument.strike!, time: yearsUntil(instrument.expiry!, state.now) });
    // Nobody can buy below intrinsic value or sell above the most the option can be worth.
    for (const q of quotes) {
      expect(q.price).toBeGreaterThanOrEqual(lower);
      expect(q.price).toBeLessThanOrEqual(upper);
    }
  }
  return { bid, ask };
}

describe("derivatives quotes", () => {
  it("stay on the tick grid, uncrossed and inside the no-arbitrage bounds, and respect every limit", () => {
    fc.assert(
      fc.property(scenario, ({ instrument, state, position }) => {
        const { quotes } = seriesQuotes(instrument, position, state, P);
        const { bid, ask } = checkQuotes(instrument, state, quotes);
        if (position >= P.maxContracts) expect(bid).toBeUndefined();
        if (position <= -P.maxContracts) expect(ask).toBeUndefined();
        // At the delta limit, nothing that would add delta: buying calls and futures, selling puts.
        const addsWhenBought = instrument.kind === "future" || instrument.right === "call";
        if (state.delta >= P.maxDelta) expect(addsWhenBought ? bid : ask).toBeUndefined();
        if (state.delta <= -P.maxDelta) expect(addsWhenBought ? ask : bid).toBeUndefined();
        // At the vega limit, no more buying (or selling) of options.
        if (instrument.kind === "option" && state.vega >= P.maxVega) expect(bid).toBeUndefined();
        if (instrument.kind === "option" && state.vega <= -P.maxVega) expect(ask).toBeUndefined();
      }),
      { numRuns: 3_000 },
    );
    // Thousands of Black-Scholes valuations: seconds on a busy machine, past the default 5 s timeout.
  }, 30_000);

  it("keep the same guarantees when a resting quote is kept instead of requoting", () => {
    fc.assert(
      fc.property(scenario, fc.array(fc.record({ side: fc.constantFrom("buy" as const, "sell" as const), offset: fc.integer({ min: -400, max: 400 }) })), (s, resting) => {
        const { quotes, halfSpread, bounds } = seriesQuotes(s.instrument, s.position, s.state, P);
        const orders = resting.flatMap((r) => {
          const q = quotes.find((x) => x.side === r.side);
          return q === undefined ? [] : [{ side: r.side, price: q.price + r.offset * 5 }];
        });
        const kept = keepCloseQuotes(quotes, orders, halfSpread / 4, bounds, 5);
        expect(kept.map((q) => q.side)).toEqual(quotes.map((q) => q.side));
        checkQuotes(s.instrument, s.state, kept);
      }),
      { numRuns: 2_000 },
    );
  }, 30_000);

  it("lean against the book's delta: long delta offers calls lower and bids puts higher", () => {
    const expiry = NOW + 20 * 60_000;
    const flat: DeskState = { spot: 410_000, volatility: 2.8, now: NOW, delta: 0, vega: 0 };
    const long = { ...flat, delta: P.maxDelta / 2 };
    const price = (kind: "call" | "put" | "future", state: DeskState, side: "buy" | "sell") =>
      seriesQuotes(series(kind, 410_000, expiry), 0, state, P).quotes.find((q) => q.side === side)!.price;
    expect(price("call", long, "sell")).toBeLessThan(price("call", flat, "sell"));
    expect(price("put", long, "buy")).toBeGreaterThan(price("put", flat, "buy"));
    expect(price("future", long, "sell")).toBeLessThan(price("future", flat, "sell"));
    // Pulled 5 seconds before expiry.
    expect(seriesQuotes(series("call", 410_000, NOW + 5_000), 0, flat, P).quotes).toEqual([]);
  });

  it("never quote a deep in-the-money option tighter than its delta's share of the stock", () => {
    // Rs 300 in the money, two minutes left: delta ~1 and almost no vega, so the volatility spread alone
    // would be a tick or two, and a Rs 2 move in TCS would leave the offer below intrinsic value.
    const state: DeskState = { spot: 410_000, volatility: 2.8, now: NOW, delta: 0, vega: 0 };
    const deep = series("call", 380_000, NOW + 2 * 60_000);
    const g = greeks({ right: "call", spot: 410_000, strike: 380_000, time: yearsUntil(deep.expiry!, NOW), volatility: 2.8 });
    expect(g.delta).toBeGreaterThan(0.999);
    expect(P.volSpread * 2.8 * g.vega).toBeLessThan(10); // under 2 ticks
    const { quotes, halfSpread } = seriesQuotes(deep, 0, state, P);
    expect(halfSpread).toBeCloseTo((P.deltaSpreadBps / 10_000) * g.delta * 410_000, 6); // Rs 2.05
    const ask = quotes.find((q) => q.side === "sell")!;
    expect(ask.price - g.price).toBeGreaterThanOrEqual(halfSpread);
  });
});

describe("derivatives market maker on a real gateway", () => {
  it("quotes every live series inside its bounds, and hedges the delta it takes on in the stock", async () => {
    // A clock running from 10:05, so the series always has 25 minutes left (expiring at 10:30) whatever
    // the time of day. Closer to expiry an in-the-money option's bid can rightly fall below intrinsic
    // value and be dropped (see deltaSpreadBps), which the bids checked below do not allow for.
    const offset = Date.UTC(2026, 9, 25, 10, 5) - Date.now();
    const clock = () => Date.now() + offset;
    const exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
    const gateway = await Gateway.create({
      exchange,
      now: clock,
      bookIntervalMs: 20,
      botKey: "test-bot-key",
      derivatives: { underlyings: [{ symbol: "TCS", multiplier: 10, strikeStep: 5_000 }] },
    });
    const url = await gateway.listen(0);
    const options = { botKey: "test-bot-key" };
    const tcs = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "TCS")!;
    const clients: TradingClient[] = [];
    try {
      const mmClient = await TradingClient.connect(url, "mm", options);
      const deskClient = await TradingClient.connect(url, "deriv-mm", options);
      const takerClient = await TradingClient.connect(url, "taker", options);
      clients.push(mmClient, deskClient, takerClient);
      const stock = new MarketMaker(mmClient, tcs, () => tcs.referencePrice, { levels: 5, halfSpreadBps: 4, stepBps: 3, size: 100, maxPosition: 5_000, skewBps: 8 }, 100);
      stock.start();
      const desk = new DerivativesMarketMaker(deskClient, tcs, { hedgeThreshold: 10, intervalMs: 200 }, clock);
      await desk.start(await TradingClient.instruments(url));
      expect(desk.series).toHaveLength(11);
      expect(desk.series[0]!.expiry).toBe(Date.UTC(2026, 9, 25, 10, 30));

      // Waits for a state rather than a fixed time: shorter when the machine is idle, and patient when it is not.
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
      };
      const wantsBid = (s: Instrument) => s.kind === "future" || s.strike! <= 415_000 || s.right === "put";
      const sides = (s: Instrument) => new Set([...desk.trackers.find((t) => t.symbol === s.symbol)!.open.values()].map((o) => o.side));
      await until(() => desk.series.every((s) => sides(s).has("sell") && (!wantsBid(s) || sides(s).has("buy"))));
      const book = async (symbol: string) => (await (await fetch(`${url}/api/book/${symbol}?levels=5`)).json()) as { bids: DepthLevel[]; asks: DepthLevel[] };
      const spotBook = await book("TCS");
      const spot = (spotBook.bids[0]!.price + spotBook.asks[0]!.price) / 2;
      for (const s of desk.series) {
        const { bids, asks } = await book(s.symbol);
        expect(asks.length).toBe(1); // every series has an offer...
        if (wantsBid(s)) expect(bids.length).toBe(1); // ...and all but far OTM calls a bid
        const bidPrice = bids[0]?.price;
        const askPrice = asks[0]!.price;
        if (bidPrice !== undefined) expect(bidPrice).toBeLessThan(askPrice);
        if (s.kind === "option") {
          const { lower, upper } = noArbitrageBounds({ right: s.right!, spot, strike: s.strike!, time: yearsUntil(s.expiry!, clock()) });
          expect(askPrice).toBeGreaterThanOrEqual(lower);
          if (bidPrice !== undefined) expect(bidPrice).toBeLessThanOrEqual(upper);
        } else {
          // The future is quoted around the stock's price.
          expect(Math.abs((bidPrice! + askPrice) / 2 - spot) / spot).toBeLessThan(0.001);
        }
      }

      // A customer buys 10 at-the-money calls: the desk is short about 50 shares of delta and buys stock to hedge.
      const atm = desk.series.find((s) => s.kind === "option" && s.right === "call" && s.strike === 410_000)!;
      const result = await takerClient.placeOrder(atm.symbol, "buy-calls", { type: "market", side: "buy", quantity: 5 });
      expect(result.type).toBe("ack");
      await new Promise((r) => setTimeout(r, 300));
      await takerClient.placeOrder(atm.symbol, "buy-more", { type: "market", side: "buy", quantity: 5 });
      const position = () => desk.trackers.find((t) => t.symbol === atm.symbol)!.position;
      await until(() => position() === -10 && desk.hedge.position > 0 && Math.abs(desk.exposure().delta) <= 10 + 1);
      expect(position()).toBe(-10);
      expect(desk.hedge.position).toBeGreaterThan(0);
      expect(Math.abs(desk.exposure().delta)).toBeLessThanOrEqual(10 + 1);

      // Cancels can race with fills ("unknown_order"); anything else is a bug.
      expect([...desk.rejectCounts.keys()].filter((r) => r !== "unknown_order")).toEqual([]);
      await desk.stop();
      await stock.stop();
    } finally {
      for (const c of clients) c.close();
      await gateway.close();
      await exchange.stop();
    }
  }, 30_000);
});

describe("requoting by amend", () => {
  /** One bid and one offer at prices the test sets. */
  class TwoQuotes extends QuotingBot {
    bid = 409_000;
    ask = 411_000;
    protected desiredQuotes(): Quote[] {
      return [
        { side: "buy", price: this.bid, quantity: 5 },
        { side: "sell", price: this.ask, quantity: 5 },
      ];
    }
  }

  it("moves quotes with one amend each, keeping their orders, and never crosses its own offer on the way", async () => {
    const exchange = Exchange.start({ symbols: ["TCS"], workers: 1 });
    const tcs = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "TCS")!;
    const gateway = await Gateway.create({ exchange, instruments: [tcs], bookIntervalMs: 20, botKey: "k" });
    const url = await gateway.listen(0);
    const clients: TradingClient[] = [];
    // Waits for the quotes to reach a state, rather than a fixed time: the full suite runs files in parallel.
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
      expect(done()).toBe(true);
    };
    try {
      for (const amend of [true, false]) {
        const client = await TradingClient.connect(url, `q-${amend}`, { botKey: "k" });
        clients.push(client);
        const bot = new TwoQuotes(client, tcs, () => 0, 50, 10_000, { amend });
        bot.start();
        await until(() => bot.tracker.open.size === 2);
        const before = new Map([...bot.tracker.open].map(([id, o]) => [o.side, id]));
        expect(before.size).toBe(2);
        // Up past the old offer: the offer must move first, or the new bid would trade with it (a self-trade).
        bot.bid = 411_500;
        bot.ask = 413_000;
        await bot.requote();
        const prices = () => [...bot.tracker.open.values()].map((o) => o.price).sort();
        await until(() => prices().join() === "411500,413000");
        const after = new Map([...bot.tracker.open].map(([id, o]) => [o.side, { id, price: o.price }]));
        expect(after.get("buy")?.price).toBe(411_500);
        expect(after.get("sell")?.price).toBe(413_000);
        // Amended in place, or (the default the stock ladders use) cancelled and replaced.
        expect(after.get("buy")!.id === before.get("buy")).toBe(amend);
        expect(after.get("sell")!.id === before.get("sell")).toBe(amend);
        expect(bot.tracker.fills).toBe(0);
        expect([...bot.rejectCounts.keys()]).toEqual([]);
        // Waits for its cancels to be acknowledged, so the next bot starts from an empty book.
        await bot.stop();
      }
    } finally {
      for (const c of clients) c.close();
      await gateway.close();
      await exchange.stop();
    }
  }, 20_000);
});
