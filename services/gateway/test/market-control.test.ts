import { Exchange } from "@ome/exchange";
import { loadManifest, VolatilityMonitor, type Forecast } from "@ome/volatility";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUMENTS, DEFAULT_RULES, Gateway, MarketControl, type GatewayOptions } from "../src/index.js";
import { TestClient } from "./client.js";

let exchange: Exchange;
let gateway: Gateway;
let base: string;
let started = false;
const clients: TestClient[] = [];

async function start(options: Partial<GatewayOptions>) {
  started = true;
  exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
  gateway = await Gateway.create({ exchange, bookIntervalMs: 20, botKey: "k", ...options });
  base = await gateway.listen(0);
}

async function client(name: string, botKey?: string): Promise<TestClient> {
  const c = await TestClient.connect(base, name, botKey);
  clients.push(c);
  return c;
}

const limit = (clientOrderId: string, side: "buy" | "sell", price: number, quantity: number, symbol = "TCS") => ({
  op: "order",
  symbol,
  clientOrderId,
  order: { type: "limit", side, price, quantity },
});

afterEach(async () => {
  // The MarketControl unit tests start no gateway.
  if (!started) return;
  started = false;
  for (const c of clients.splice(0)) c.close();
  await gateway.close();
  await exchange.stop();
});

describe("opening auction", () => {
  it("collects orders, publishes an indicative price, then opens at one price", async () => {
    await start({ market: { openingAuctionMs: 1_500 } });
    const alice = await client("alice");
    const bob = await client("bob");
    expect(await alice.waitFor((m) => m.type === "status" && m.symbol === "TCS")).toMatchObject({ phase: "auction", reason: "opening" });

    // Crossing orders do not trade during the auction...
    await alice.request(limit("a1", "buy", 410_500, 10));
    await bob.request(limit("b1", "sell", 409_500, 6));
    expect(await alice.request({ op: "order", symbol: "TCS", clientOrderId: "m1", order: { type: "market", side: "buy", quantity: 1 } })).toMatchObject({
      reason: "not_allowed_in_auction",
    });
    expect(alice.messages.some((m) => m.type === "execution" && m.event === "fill")).toBe(false);

    // ...an indicative uncross price is published while it runs...
    const indicative = await alice.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.indicative !== null);
    expect(indicative).toMatchObject({ indicative: { volume: 6 } });

    // ...and the uncross trades everything at one price, then trading is continuous.
    const open = await alice.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "continuous", 5_000);
    expect(open).toMatchObject({ reason: null, indicative: null });
    const fills = alice.messages.filter((m) => m.type === "execution" && m.event === "fill");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ quantity: 6, price: (indicative.indicative as { price: number }).price });
  });
});

describe("circuit breaker", () => {
  it("halts a symbol that moves too far too fast, then reopens it by auction", async () => {
    await start({ market: { circuitBreaker: { windowMs: 60_000, movePct: 5, haltMs: 1_000 } } });
    const mm = await client("mm", "k"); // unlimited, so the big move is not stopped by risk checks
    const taker = await client("taker", "k");
    await mm.request(limit("s1", "sell", 410_000, 1));
    await taker.request(limit("t1", "buy", 410_000, 1)); // trade at 4100
    await mm.request(limit("s2", "sell", 432_000, 1)); // within the 10% band
    await taker.request(limit("t2", "buy", 432_000, 1)); // +5.4% in seconds

    expect(await taker.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "auction")).toMatchObject({ reason: "circuit_breaker" });
    expect(await taker.request({ op: "order", symbol: "TCS", clientOrderId: "t3", order: { type: "market", side: "buy", quantity: 1 } })).toMatchObject({
      reason: "not_allowed_in_auction",
    });
    // Other symbols keep trading.
    await mm.request(limit("s4", "sell", 185_000, 1, "INFY"));
    expect(await taker.request(limit("t4", "buy", 185_000, 1, "INFY"))).toMatchObject({ type: "ack" });

    expect(await taker.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "continuous", 4_000)).toMatchObject({ reason: null });
  });

  it("measures the first move after a reopen from the reopening price", async () => {
    // The demo report: after a reopen at 78,669, a sweep printed eight trades at
    // 83,654.32 (+6.3%) and BTCUSDT kept trading.
    await start({ market: { circuitBreaker: { windowMs: 60_000, movePct: 5, haltMs: 1_000 } } });
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");
    const btc = (id: string, side: "buy" | "sell", price: number) => limit(id, side, price, 1, "BTCUSDT");
    const isStatus = (phase: string, after = 0) => (m: Record<string, unknown>) =>
      m.type === "status" && m.symbol === "BTCUSDT" && m.phase === phase && taker.messages.indexOf(m as never) >= after;
    await mm.request(btc("s1", "sell", 7_866_900));
    await taker.request(btc("b1", "buy", 7_866_900)); // 78,669
    await mm.request(btc("s2", "sell", 8_300_000));
    await taker.request(btc("b2", "buy", 8_300_000)); // +5.5%: halts
    const halted = taker.messages.indexOf(await taker.waitFor(isStatus("auction")));

    // The auction reopens the market at 78,669.
    await mm.request(btc("s3", "sell", 7_866_900));
    await taker.request(btc("b3", "buy", 7_866_900));
    const reopened = await taker.waitFor(isStatus("continuous", halted), 4_000);
    expect(reopened).toMatchObject({ referencePrice: 7_866_900 });

    // Straight after the reopen, before any other trade, a sweep through eight offers at 83,654.32.
    const after = taker.messages.length;
    for (let i = 0; i < 8; i++) await mm.request(btc(`sweep-s${i}`, "sell", 8_365_432));
    await taker.request(limit("sweep", "buy", 8_365_432, 8, "BTCUSDT"));
    expect(await taker.waitFor(isStatus("auction", after))).toMatchObject({ reason: "circuit_breaker" });
    expect(taker.messages.filter((m) => m.type === "execution" && m.clientOrderId === "sweep" && m.event === "fill")).toHaveLength(8);
  });

  it("measures a move from the window's low or high, not just its oldest trade", async () => {
    await start({ market: { circuitBreaker: { windowMs: 60_000, movePct: 5, haltMs: 1_000 } } });
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");
    await mm.request(limit("s1", "sell", 425_000, 1));
    await taker.request(limit("b1", "buy", 425_000, 1)); // 4250 starts the window
    await mm.request(limit("s2", "sell", 410_000, 1));
    await taker.request(limit("b2", "buy", 410_000, 1)); // -3.5%
    await mm.request(limit("s3", "sell", 432_000, 1));
    await taker.request(limit("b3", "buy", 432_000, 1)); // +1.6% on the oldest trade, but +5.4% on the low seconds earlier

    expect(await taker.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "auction")).toMatchObject({ reason: "circuit_breaker" });
  });

  it("halts again when the price leaves the reopening price just as fast", async () => {
    // The auction found the spike price (bids were anchored there), so a fall
    // back of more than 5% within the window is a fresh move and halts again.
    await start({ market: { circuitBreaker: { windowMs: 60_000, movePct: 5, haltMs: 1_000 } } });
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");
    await mm.request(limit("s1", "sell", 410_000, 1));
    await taker.request(limit("b1", "buy", 410_000, 1));
    await mm.request(limit("s2", "sell", 432_000, 1));
    await taker.request(limit("b2", "buy", 432_000, 1)); // +5.4%: halts
    const halted = taker.messages.indexOf(await taker.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "auction"));
    await mm.request(limit("s3", "sell", 432_000, 1));
    await taker.request(limit("b3", "buy", 432_000, 1)); // reopens at the spike price
    const reopened = await taker.waitFor(
      (m) => m.type === "status" && m.symbol === "TCS" && m.phase === "continuous" && taker.messages.indexOf(m) > halted,
      4_000,
    );
    expect(reopened).toMatchObject({ referencePrice: 432_000 });

    const after = taker.messages.length;
    await taker.request(limit("b4", "buy", 410_000, 1));
    await mm.request(limit("s4", "sell", 410_000, 1)); // -5.1% from the reopening price
    expect(
      await taker.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "auction" && taker.messages.indexOf(m) >= after),
    ).toMatchObject({ reason: "circuit_breaker" });
  });
});

describe("circuit breaker limits", () => {
  const instrument = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "TCS")!;
  const breaker = { windowMs: 60_000, movePct: 5, haltMs: 1_000 };
  const control = (send: () => Promise<unknown>, forecast: () => Forecast | null = () => null) =>
    new MarketControl(
      { send, indicative: async () => null } as unknown as Exchange,
      [instrument],
      () => 0,
      { ...DEFAULT_RULES, circuitBreaker: breaker, volatility: { bandSigmas: 10, minBandPct: 2, breakerSigmas: 8, minBreakerPct: 1 } },
      () => {},
      forecast,
    );

  it("keeps the static limits when the forecast is not a number", () => {
    const c = control(async () => [], () => ({ model: "ewma", horizonMinutes: 15, sigma: Number.NaN, bars: 15 }));
    expect(c.breakerPct("TCS")).toBe(5);
    expect(c.bandPct("TCS")).toBe(10);
  });

  it("stays continuous, and tries again on the next move, when the halt cannot be sent", async () => {
    let sends = 0;
    const c = control(async () => {
      sends++;
      throw new Error("engine unavailable");
    });
    c.onTrade("TCS", 410_000, 0);
    c.onTrade("TCS", 432_000, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(sends).toBe(1);
    expect(c.status("TCS")).toMatchObject({ phase: "continuous", reason: null, until: null });
    c.onTrade("TCS", 433_000, 0);
    expect(sends).toBe(2);
    c.stop();
  });
});

describe("volatility-aware limits", () => {
  it("publishes a forecast once a symbol has 15 minutes of history, and tightens the band to it", async () => {
    let clock = Date.UTC(2026, 9, 25, 9, 0, 0);
    const volatility = new VolatilityMonitor(loadManifest(), DEFAULT_INSTRUMENTS.map((i) => i.symbol));
    await start({
      now: () => clock,
      volatility,
      market: { circuitBreaker: { windowMs: 60_000, movePct: 5, haltMs: 1_000 }, volatility: { bandSigmas: 10, minBandPct: 2, breakerSigmas: 8, minBreakerPct: 1 } },
    });
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");
    // Before there is a forecast, the static limits apply.
    expect(await taker.waitFor((m) => m.type === "status" && m.symbol === "TCS")).toMatchObject({ bandPct: 10, breakerPct: 5, volatility: null });

    // A quiet quarter of an hour: a trade a minute, moving 0.024% each time, so
    // about sqrt(15) x 0.024% = 0.09% over 15 minutes, far below either floor.
    for (let minute = 0; minute <= 15; minute++) {
      const price = minute % 2 === 0 ? 410_000 : 410_100;
      await mm.request(limit(`s${minute}`, "sell", price, 1));
      await taker.request(limit(`b${minute}`, "buy", price, 1));
      clock += 60_000;
    }
    const status = await taker.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.volatility !== null);
    const forecast = status.volatility as { sigmaPct: number; horizonMinutes: number; model: string };
    expect(forecast).toMatchObject({ horizonMinutes: 15, model: loadManifest().live_model });
    expect(forecast.sigmaPct).toBeGreaterThan(0);
    expect(forecast.sigmaPct).toBeLessThan(1);
    // Calm market: both limits tighten to their floors.
    expect(status).toMatchObject({ bandPct: 2, breakerPct: 1 });

    // A price 3% away was fine under the static 10% band; now it is rejected.
    expect(await taker.request(limit("far", "buy", 422_500, 1))).toMatchObject({ reason: "price_outside_band" });
    expect(await taker.request(limit("near", "buy", 415_000, 1))).toMatchObject({ type: "ack" });

    const api = (await (await fetch(`${base}/api/volatility`)).json()) as { model: { chosen: string }; forecasts: { symbol: string; forecast: unknown }[] };
    expect(api.model.chosen).toBe(loadManifest().chosen);
    expect(api.forecasts.find((f) => f.symbol === "TCS")?.forecast).not.toBeNull();
    expect(api.forecasts.find((f) => f.symbol === "INFY")?.forecast).toBeNull(); // no trades there yet

    // In this calm market a 1.5% jump within a minute halts trading; the static 5% rule would have let it through.
    await mm.request(limit("jump-s", "sell", 416_500, 1));
    await taker.request(limit("jump-b", "buy", 416_500, 1));
    expect(await taker.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "auction")).toMatchObject({ reason: "circuit_breaker" });
  });
});

describe("price bands and risk checks", () => {
  it("rejects prices outside the band around the last trade", async () => {
    await start({});
    const alice = await client("alice");
    expect(await alice.request(limit("x1", "buy", 451_500, 1))).toMatchObject({ reason: "price_outside_band" }); // +10.1% of 4100
    expect(await alice.request(limit("x2", "buy", 368_500, 1))).toMatchObject({ reason: "price_outside_band" }); // -10.1%
    expect(await alice.request(limit("x3", "buy", 451_000, 1))).toMatchObject({ type: "ack" }); // +10% exactly
  });

  it("enforces buying power and pushes account updates", async () => {
    await start({});
    const alice = await client("alice");
    const mm = await client("mm", "k");
    expect(await alice.waitFor((m) => m.type === "account")).toMatchObject({ unlimited: false, balances: expect.arrayContaining([expect.objectContaining({ currency: "INR", buyingPower: 1_000_000 })]) });
    // At Rs 4,100 a share:
    expect(await alice.request(limit("big", "buy", 410_000, 130))).toMatchObject({ reason: "order_too_large" }); // Rs 5.33L

    await mm.request(limit("s1", "sell", 410_000, 2_000));
    await alice.request(limit("b1", "buy", 410_000, 120)); // Rs 4.92L
    await alice.request(limit("b2", "buy", 410_000, 120)); // Rs 9.84L in total
    expect(await alice.request(limit("b3", "buy", 410_000, 10))).toMatchObject({ reason: "insufficient_buying_power" });
    // Selling down a position needs no buying power.
    expect(await alice.request(limit("s1", "sell", 409_000, 10))).toMatchObject({ type: "ack" });

    const account = await alice.waitFor((m) => m.type === "account" && (m.positions as unknown[]).length > 0, 3_000);
    expect(account).toMatchObject({ positions: [{ symbol: "TCS", quantity: 240, averagePrice: 410_000 }] });
  });

  it("liquidates an account in margin breach", async () => {
    // Tight limits so a small move triggers it: Rs 1L, 1x leverage, liquidate above 1.05x.
    await start({ risk: { startingCash: { INR: 100_000 }, leverage: 1, maxOrderValue: { INR: 1e9 }, liquidationRatio: 1.05 } });
    const alice = await client("alice");
    const mm = await client("mm", "k");
    const other = await client("other", "k");

    // Alice shorts 24 at 4100 (Rs 98,400). Cash becomes Rs 1,98,400, so at price p:
    // equity = 198,400 - 24p, exposure = 24p, breach when 24p > 1.05 x equity, i.e. p > 4234.15.
    await mm.request(limit("b1", "buy", 410_000, 24));
    expect(await alice.request(limit("s1", "sell", 410_000, 24))).toMatchObject({ type: "ack" });
    await alice.waitFor((m) => m.type === "execution" && m.event === "fill");
    await new Promise((r) => setTimeout(r, 1_200)); // a liquidation check passes: no breach at 4100
    expect(alice.messages.some((m) => m.type === "notice")).toBe(false);

    // A print at 4240 breaches. The market maker's offer is there for the forced buy-back.
    await mm.request(limit("s2", "sell", 424_000, 30));
    await other.request(limit("o1", "buy", 424_000, 1));

    expect(await alice.waitFor((m) => m.type === "notice", 4_000)).toMatchObject({ level: "warning" });
    const flat = await alice.waitFor(
      (m) => m.type === "account" && m.liquidated === true && (m.positions as { quantity: number }[]).every((p) => p.quantity === 0),
      4_000,
    );
    // Lost (4240 - 4100) x 24 = Rs 3,360.
    expect(flat).toMatchObject({ positions: [{ symbol: "TCS", quantity: 0, realized: -3_360 }] });
  });
});
