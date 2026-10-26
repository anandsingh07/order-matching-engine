import type { Side } from "@ome/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadManifest, VolatilityForecaster } from "@ome/volatility";
import { maxDrawdown, MINUTE_MS, runBacktest, sharpe, type Fill, type MarketTrade, type MinuteBar, type RejectReason, type StrategyContext } from "../src/index.js";
import { gainFromFills, scripted, t, tape, TOY } from "./helpers.js";

const base = { instrument: TOY, capital: 1_000, latencyMs: 0, slippageBps: 0, makerFeeBps: 0, takerFeeBps: 0 };

describe("a hand-computed scenario", () => {
  // A bid at 98 and an ask at 102, both 5 lots, then the tape trades through them.
  const data = tape(
    t(0, 100, 1, "buy"), // touch 99 / 100
    t(20, 98, 3, "sell"), // at our bid's price: not through it
    t(30, 97, 3, "sell"), // through it: 3 @ 98
    t(40, 96, 4, "sell"), // the last 2 @ 98, capped by our size
    t(50, 103, 2, "buy"), // through our ask: 2 @ 102
    t(60, 101, 10, "buy"), // below our ask: nothing
    t(70, 103, 1, "buy"), // 1 @ 102
    t(80, 100, 1, "sell"), // the mark: 100
  );
  const quote = scripted({
    0: (ctx) => {
      ctx.placeLimit("buy", 98, 5);
      ctx.placeLimit("sell", 102, 5);
    },
  });

  it("fills only through the price, at our price, capped by the tape, with the exact P&L", async () => {
    const { result, fills } = await runBacktest(quote, data, { ...base, latencyMs: 10, makerFeeBps: 10, takerFeeBps: 5 });
    expect(fills.map((f) => [f.time, f.side, f.price, f.quantity, f.liquidity])).toEqual([
      [30, "buy", 98, 3, "maker"],
      [40, "buy", 98, 2, "maker"],
      [50, "sell", 102, 2, "maker"],
      [70, "sell", 102, 1, "maker"],
    ]);
    // Bought 5 @ 98 and sold 3 @ 102, marked at 100: +10 and +6.
    // Maker fees: 10 bps of (490 + 306) = 0.796.
    expect(result.pnl.fees).toBeCloseTo(0.796, 12);
    expect(result.pnl.total).toBeCloseTo(16 - 0.796, 12);
    expect(result.pnl.return).toBeCloseTo((16 - 0.796) / 1_000, 12);
    // Closing the 2 left: sold at the bid (100, after a seller-initiated print) less 5 bps on 200.
    expect(result.pnl.afterClose).toBeCloseTo(16 - 0.796 - 0.1, 12);
    expect(result.inventory.final).toBe(2);
    expect(result.turnover.amount).toBe(796);
    expect(result.fills).toEqual({ count: 4, maker: 4, taker: 0, makerQuantity: 8, takerQuantity: 0 });
    // Long 0 until 30, 3 until 40, 5 until 50, 3 until 70, then 2 until 80: 30 + 50 + 60 + 20 = 160 lot-ms over 80 ms.
    expect(result.inventory.meanAbs).toBeCloseTo(160 / 80, 12);
  });

  it("with the optimistic queue model, a trade at our price fills us too", async () => {
    const { fills } = await runBacktest(quote, data, { ...base, latencyMs: 10, queue: "touch" });
    expect(fills.map((f) => [f.time, f.side, f.price, f.quantity])).toEqual([
      [20, "buy", 98, 3],
      [30, "buy", 98, 2],
      [50, "sell", 102, 2],
      [70, "sell", 102, 1],
    ]);
  });

  it("closes what is left at the touch less the slippage, and pays the taker fee", async () => {
    // Long 2 at the end, touch 100 / 101: sold at floor(100 x 0.99) = 99, less 5 bps of 198.
    const long = await runBacktest(quote, data, { ...base, latencyMs: 10, makerFeeBps: 10, takerFeeBps: 5, slippageBps: 100 });
    expect(long.result.pnl.total).toBeCloseTo(16 - 0.796, 12); // slippage only touches the close
    expect(long.result.pnl.afterClose).toBeCloseTo(16 - 0.796 + 2 * (99 - 100) - (2 * 99 * 5) / 10_000, 12);
    // Short 3 from 102, marked at 101 after a buy (touch 100 / 101): bought back at ceil(101 x 1.01) = 103.
    const short = await runBacktest(
      scripted({ 0: (ctx) => void ctx.placeLimit("sell", 102, 3) }),
      tape(t(0, 100, 1, "buy"), t(20, 103, 3, "buy"), t(30, 101, 1, "buy")),
      { ...base, takerFeeBps: 5, slippageBps: 100 },
    );
    expect(short.result.inventory.final).toBe(-3);
    expect(short.result.pnl.total).toBeCloseTo(3, 12);
    expect(short.result.pnl.afterClose).toBeCloseTo(3 - 3 * (103 - 101) - (3 * 103 * 5) / 10_000, 12);
  });
});

describe("quotes a print proves crossed", () => {
  // A seller-initiated print at 100 (touch 100 / 101) and our bid joins it; then a buyer
  // lifts an ask at 100, which proves the bid level was emptied: our bid cannot still rest.
  const data = tape(
    t(0, 100, 1, "sell"),
    t(10, 100, 2, "sell"), // at our price: fills us only if we were first in the queue
    t(20, 100, 2, "buy"), // an ask at 100: our bid at 100 crossed it, filled up to the print's 2
    t(30, 99, 1, "sell"), // through the bid
    t(40, 100, 1, "sell"), // a bid at 100: our ask at 100 (placed at 30) crossed it
    t(50, 100, 1, "buy"),
  );
  const strategy = scripted({
    0: (ctx) => void ctx.placeLimit("buy", 100, 3),
    30: (ctx) => void ctx.placeLimit("sell", 100, 1), // touch 99 / 100 after the print at 99
  });

  it("fills them at their own price, capped by the print, in both queue models", async () => {
    const through = await runBacktest(strategy, data, base);
    expect(through.fills.map((f) => [f.time, f.side, f.price, f.quantity, f.liquidity])).toEqual([
      [20, "buy", 100, 2, "maker"],
      [30, "buy", 100, 1, "maker"],
      [40, "sell", 100, 1, "maker"],
    ]);
    const touch = await runBacktest(strategy, data, { ...base, queue: "touch" });
    expect(touch.fills.map((f) => [f.time, f.side, f.price, f.quantity])).toEqual([
      [10, "buy", 100, 2],
      [20, "buy", 100, 1],
      [40, "sell", 100, 1],
    ]);
  });
});

describe("drawdown", () => {
  it("is watched at each maker fill's own price, never at the print the sweep came from", async () => {
    // Flat, a bid at 99, then the market falls from 100 to 90 through it. Equity never
    // exceeds 1,000 at any price that traded, so the drawdown is 1,000 - 910 = 90.
    let inFill: number | undefined;
    const { result, fills } = await runBacktest(
      scripted({ 0: (ctx) => void ctx.placeLimit("buy", 99, 10) }, { onFill: (ctx) => void (inFill = ctx.cash + ctx.position * ctx.lastPrice! - 1_000) }),
      tape(t(0, 100, 1, "buy"), t(10, 90, 20, "sell"), t(20, 90, 1, "sell")),
      base,
    );
    expect(fills.map((f) => [f.time, f.side, f.price, f.quantity])).toEqual([[10, "buy", 99, 10]]);
    expect(inFill).toBe(-90); // the fill is reported with the print that caused it already in
    expect(result.maxDrawdown).toEqual({ amount: 90, fraction: 0.09 });
  });

  it("counts the peak at the instant of a fill when it is real", async () => {
    // Short 5 from 100; the market rallies to 101, then falls through our bid at 98 to 90.
    // When the bid fills at 98, the short has made 10 (equity 1,010); long 5 at 90 is 970.
    const { result } = await runBacktest(
      scripted({
        0: (ctx) => {
          ctx.placeLimit("sell", 100, 5);
          ctx.placeLimit("buy", 98, 10);
        },
      }),
      tape(t(0, 100, 1, "buy"), t(10, 101, 5, "buy"), t(20, 90, 10, "sell")),
      base,
    );
    expect(result.inventory.final).toBe(5);
    expect(result.pnl.total).toBe(-30);
    expect(result.maxDrawdown.amount).toBeCloseTo(40, 12);
    expect(result.maxDrawdown.fraction).toBeCloseTo(40 / 1_010, 12);
  });
});

describe("latency", () => {
  const through = (time: number) => t(time, 95, 1, "sell");

  it("an order takes effect only after the latency, and a trade in the same millisecond comes first", async () => {
    // The market dips through 98 at 49 and 50 and is back at 100 by the end of 50, when the order arrives.
    const data = tape(t(0, 100, 1, "buy"), through(49), through(50), t(50, 100, 1, "buy"), through(51), t(60, 100, 1, "buy"));
    const { fills, actions } = await runBacktest(scripted({ 0: (ctx) => ctx.placeLimit("buy", 98, 1) }), data, { ...base, latencyMs: 50 });
    expect(actions).toEqual([{ decidedAt: 0, arrivedAt: 50, kind: "limit", orderId: "o1", side: "buy", price: 98, quantity: 1 }]);
    expect(fills.map((f) => f.time)).toEqual([51]);
  });

  it("a cancel is too late if the order trades before it arrives", async () => {
    const data = tape(t(0, 100, 1, "buy"), through(120), t(200, 100, 1, "buy"));
    const run = (latencyMs: number) =>
      runBacktest(
        scripted({
          0: (ctx) => ctx.placeLimit("buy", 98, 1),
          100: (ctx) => ctx.cancel(ctx.openOrders()[0]!.id),
        }),
        data,
        { ...base, latencyMs },
      );
    const slow = await run(30); // the cancel lands at 130, after the trade at 120
    expect(slow.fills).toHaveLength(1);
    expect(slow.result.orders.lateCancels).toBe(1);
    const fast = await run(10); // lands at 110: cancelled in time
    expect(fast.fills).toHaveLength(0);
    expect(fast.result.orders.lateCancels).toBe(0);
  });

  it("a market order fills at the touch when it arrives, not when it was sent", async () => {
    const data = tape(t(0, 100, 1, "buy"), t(30, 110, 1, "buy"), t(100, 110, 1, "buy"));
    const { fills } = await runBacktest(scripted({ 0: (ctx) => ctx.marketOrder("buy", 2) }), data, { ...base, latencyMs: 50, slippageBps: 100 });
    // At 50 the last print was a buy at 110, the ask; 1% slippage, rounded up to the tick: 111.1 -> 112.
    expect(fills).toEqual([{ time: 50, orderId: "o1", side: "buy", price: 112, quantity: 2, liquidity: "taker", fee: 0 }]);
  });
});

describe("fees", () => {
  const data = tape(t(0, 100, 1, "sell"), t(10, 90, 10, "sell"), t(20, 100, 1, "sell")); // touch 100 / 101 after the first print
  const strategy = scripted({
    0: (ctx) => {
      ctx.placeLimit("buy", 95, 4); // filled at 10 as a maker: notional 380
      ctx.marketOrder("buy", 2); // taker at the ask, 101: notional 202
    },
  });

  it("charges the maker rate on resting fills and the taker rate on market orders", async () => {
    const { result, fills } = await runBacktest(strategy, data, { ...base, makerFeeBps: 2, takerFeeBps: 7 });
    expect(fills.map((f) => [f.liquidity, f.price, f.quantity, f.fee])).toEqual([
      ["taker", 101, 2, (202 * 7) / 10_000],
      ["maker", 95, 4, (380 * 2) / 10_000],
    ]);
    expect(result.pnl.makerFees).toBeCloseTo(0.076, 12);
    expect(result.pnl.takerFees).toBeCloseTo(0.1414, 12);
    // Marked at 100: +20 on the maker buy, -2 on the taker buy, less fees.
    expect(result.pnl.total).toBeCloseTo(18 - 0.076 - 0.1414, 12);
  });

  it("a negative maker fee is a rebate", async () => {
    const free = await runBacktest(strategy, data, base);
    const rebate = await runBacktest(strategy, data, { ...base, makerFeeBps: -1 });
    expect(rebate.result.pnl.total - free.result.pnl.total).toBeCloseTo(0.038, 12);
  });
});

describe("post-only quotes", () => {
  it("rejects a quote that would cross the touch or the strategy's own opposite quote", async () => {
    const rejects: [string, RejectReason][] = [];
    // Touch 99 / 100; then a buy at 105 takes 1 of our 5 offered at 100, leaving 4 below the new touch (104 / 105).
    const data = tape(t(0, 100, 1, "buy"), t(5, 105, 1, "buy"), t(100, 105, 1, "buy"));
    const strategy = scripted(
      {
        0: (ctx) => {
          ctx.placeLimit("buy", 100, 1); // at the ask: would cross
          ctx.placeLimit("buy", 99, 1); // at the bid: fine
          ctx.placeLimit("sell", 100, 5); // joins the ask: fine
        },
        10: (ctx) => ctx.placeLimit("buy", 102, 1), // inside the market's touch, but through our own ask at 100
      },
      { onReject: (_ctx, order, reason) => void rejects.push([order.id, reason]) },
    );
    const { result } = await runBacktest(strategy, data, base);
    expect(rejects).toEqual([
      ["o1", "would_cross"],
      ["o4", "would_cross"],
    ]);
    expect(result.orders.rejected).toEqual({ would_cross: 2 });
  });

  it("a plain limit order through the touch takes liquidity, as it would live, never past its limit", async () => {
    // Touch 99 / 100 after a buyer-initiated print at 100; then 104 / 105 after one at 105.
    const data = tape(t(0, 100, 1, "buy"), t(25, 105, 1, "buy"), t(100, 99, 1, "sell"));
    const plain = { postOnly: false };
    const strategy = scripted({
      0: (ctx) => {
        ctx.placeLimit("buy", 100, 2, plain); // at the ask: takes 2 at 100, its limit, though slippage would say 101
        ctx.placeLimit("buy", 103, 1, plain); // through it: the touch plus 100 bps slippage, 101
        ctx.placeLimit("sell", 97, 1, plain); // through the bid: 99 less 1% is 98.01, rounded down to 98
        ctx.placeLimit("buy", 98, 1, plain); // behind the bid: rests, as a quote
      },
      // Decided at 10 through the ask of 100, it arrives at 30 to touch 104 / 105: no longer through, so it rests.
      10: (ctx) => ctx.placeLimit("buy", 100, 1, plain),
    });
    const { result, fills } = await runBacktest(strategy, data, { ...base, latencyMs: 20, slippageBps: 100, takerFeeBps: 10 });
    expect(fills.map((f) => [f.time, f.orderId, f.side, f.price, f.quantity, f.liquidity])).toEqual([
      [20, "o1", "buy", 100, 2, "taker"],
      [20, "o2", "buy", 101, 1, "taker"],
      [20, "o3", "sell", 98, 1, "taker"],
      // The seller at 99 prints through the resting bid at 100 (the through model), not the one at 98.
      [100, "o5", "buy", 100, 1, "maker"],
    ]);
    expect(fills[0]!.fee).toBeCloseTo((200 * 10) / 10_000, 12);
    expect(result.quotes.marketable).toEqual({ orders: 3, quantity: 4 });
    expect(result.orders.rejected).toEqual({});
    // A slippage that would pay past the limit is capped there: the limit is a promise.
    const capped = await runBacktest(scripted({ 0: (ctx) => void ctx.placeLimit("buy", 100, 1, plain) }), data, { ...base, slippageBps: 500 });
    expect(capped.fills.map((f) => [f.price, f.liquidity])).toEqual([[100, "taker"]]);
    // Through the strategy's own opposite quote it is rejected (self-trade prevention), post-only or not.
    const own = await runBacktest(
      scripted({ 0: (ctx) => void ctx.placeLimit("sell", 102, 1), 10: (ctx) => void ctx.placeLimit("buy", 103, 1, plain) }),
      tape(t(0, 100, 1, "buy"), t(5, 101, 1, "buy"), t(50, 101, 1, "buy")),
      base,
    );
    expect(own.result.orders.rejected).toEqual({ would_cross: 1 });
    expect(own.fills).toEqual([]);
  });

  it("needs a price before anything can trade", async () => {
    const reasons: RejectReason[] = [];
    const strategy = { name: "early", init: (ctx: StrategyContext) => void ctx.marketOrder("buy", 1), onReject: (_c: StrategyContext, _o: unknown, r: RejectReason) => void reasons.push(r) };
    // The order is decided before the first trade, with no latency, so it arrives after it: it fills.
    expect((await runBacktest(strategy, tape(t(0, 100, 1, "buy")), base)).fills).toHaveLength(1);
    // On bar data, a limit order has no tape to be filled by.
    const bars = { kind: "bars" as const, symbol: "TOY", bars: [{ time: 0, open: 100, high: 101, low: 99, close: 100, volume: 5 }], warmup: [] };
    await runBacktest({ name: "quoter", init: (ctx) => void ctx.placeLimit("buy", 90, 1), onReject: (_c, _o, r) => void reasons.push(r) }, bars, base);
    // Nor is there a price before the first bar closes: its open printed at some unknown moment.
    await runBacktest(strategy, bars, base);
    expect(reasons).toEqual(["no_tape", "no_price"]);
  });
});

describe("no look-ahead", () => {
  it("a millisecond before a trade, nothing the strategy can see reflects it", async () => {
    // Four hours of warm-up bars, so the volatility forecast is live; then a quiet minute, and
    // a crash through our bid at exactly 60,000 ms, which also closes the first minute.
    const warmup: MinuteBar[] = Array.from({ length: 240 }, (_, i) => {
      const open = 100 + ((i * 7) % 5) - 2;
      const close = 100 + (((i + 1) * 7) % 5) - 2;
      return { time: (i - 240) * MINUTE_MS, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 3 };
    });
    const data = { ...tape(t(0, 100, 1, "buy"), t(30_000, 100, 1, "sell"), t(60_000, 90, 5, "sell"), t(61_000, 91, 1, "buy")), warmup };
    const seen: Record<string, unknown> = {};
    const look = (ctx: StrategyContext) => ({
      lastPrice: ctx.lastPrice,
      touch: ctx.touch,
      bars: ctx.bars().length,
      lastBar: ctx.bars().at(-1),
      volatility: ctx.volatility,
      position: ctx.position,
      cash: ctx.cash,
      open: ctx.openOrders().map((o) => o.status),
    });
    const strategy = scripted({
      0: (ctx) => void ctx.placeLimit("buy", 95, 2),
      59_999: (ctx) => void (seen.before = look(ctx)),
      60_000: (ctx) => void (seen.at = look(ctx)),
    });
    await runBacktest(strategy, data, base);
    // The forecasts the gateway's forecaster gives on the warm-up alone, and then with the first minute.
    const forecaster = new VolatilityForecaster(loadManifest());
    for (const bar of warmup) forecaster.push(bar);
    const before = forecaster.forecast();
    const firstMinute = { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 2 }; // the 90 print is the next minute's
    forecaster.push(firstMinute);
    const after = forecaster.forecast();
    expect(before).not.toBeNull();
    expect(after!.sigma).not.toBe(before!.sigma);
    expect(seen.before).toEqual({ lastPrice: 100, touch: { bid: 100, ask: 101 }, bars: 240, lastBar: warmup.at(-1), volatility: before, position: 0, cash: 1_000, open: ["open"] });
    // At 60,000 itself the trade has happened (timers run after the tape at equal times): filled, and the minute closed.
    expect(seen.at).toEqual({ lastPrice: 90, touch: { bid: 90, ask: 91 }, bars: 241, lastBar: firstMinute, volatility: after, position: 2, cash: 1_000 - 190, open: [] });
  });

  it("on bar data, a minute's open is not a price until the minute is over", async () => {
    // When in the minute the open printed is unknown, so the price is the last close until the next one.
    const bars = {
      kind: "bars" as const,
      symbol: "TOY",
      warmup: [],
      bars: [
        { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
        { time: 60_000, open: 120, high: 130, low: 120, close: 130, volume: 1 },
        { time: 120_000, open: 130, high: 130, low: 130, close: 130, volume: 1 },
      ],
    };
    const prices: Record<number, number | null> = {};
    const strategy = scripted({
      0: (ctx) => void (prices[0] = ctx.lastPrice),
      60_000: (ctx) => {
        prices[60_000] = ctx.lastPrice;
        ctx.marketOrder("buy", 1);
      },
      119_999: (ctx) => void (prices[119_999] = ctx.lastPrice),
      120_000: (ctx) => void (prices[120_000] = ctx.lastPrice),
    });
    const { fills } = await runBacktest(strategy, bars, { ...base, latencyMs: 50 });
    expect(prices).toEqual({ 0: null, 60_000: 100, 119_999: 100, 120_000: 130 });
    // Decided at the first close and arriving 50 ms later: the close plus a tick (a two-tick spread), not the 120 open.
    expect(fills.map((f) => [f.time, f.side, f.price, f.liquidity])).toEqual([[60_050, "buy", 101, "taker"]]);
  });

  it("delivers every event at its own time, in order, and bars only once they are complete", async () => {
    const trades = [];
    for (let i = 0; i < 400; i++) trades.push(t(i * 997, 100 + (i % 7), 1, i % 3 === 0 ? "sell" : "buy"));
    const problems: string[] = [];
    let lastNow = -Infinity;
    let lastTrade = -Infinity;
    let callbacks = 0;
    const check = (ctx: StrategyContext, what: string) => {
      callbacks++;
      if (ctx.now < lastNow) problems.push(`${what}: clock went back from ${lastNow} to ${ctx.now}`);
      lastNow = ctx.now;
      if (lastTrade > ctx.now) problems.push(`${what}: saw a trade at ${lastTrade} at ${ctx.now}`);
      const bar = ctx.bars().at(-1);
      if (bar !== undefined && bar.time + MINUTE_MS > ctx.now) problems.push(`${what}: bar of ${bar.time} before it closed, at ${ctx.now}`);
    };
    await runBacktest(
      {
        name: "watcher",
        init: (ctx) => ctx.every(250),
        onTrade: (ctx, trade) => {
          if (trade.time !== ctx.now) problems.push(`trade of ${trade.time} delivered at ${ctx.now}`);
          lastTrade = trade.time;
          check(ctx, "trade");
        },
        onBar: (ctx, bar) => {
          if (bar.time + MINUTE_MS !== ctx.now) problems.push(`bar of ${bar.time} delivered at ${ctx.now}`);
          check(ctx, "bar");
        },
        onTimer: (ctx) => check(ctx, "timer"),
      },
      tape(...trades),
      base,
    );
    expect(problems).toEqual([]);
    expect(callbacks).toBe(400 + 6 + Math.floor((399 * 997) / 250)); // trades, six closed minutes, timers
  });
});

describe("accounting", () => {
  it("cash + position x mark always equals the fills' gains minus fees (property)", async () => {
    const tradeArb = fc.record({ dt: fc.integer({ min: 0, max: 40 }), price: fc.integer({ min: 90, max: 110 }), quantity: fc.integer({ min: 1, max: 8 }), side: fc.constantFrom<Side>("buy", "sell") });
    const actionArb = fc.record({
      at: fc.integer({ min: 0, max: 2_000 }),
      kind: fc.constantFrom("limit", "limit", "market", "cancel"),
      side: fc.constantFrom<Side>("buy", "sell"),
      // Negative offsets are through the touch: post-only, they are rejected; plain, they take.
      offset: fc.integer({ min: -2, max: 6 }),
      postOnly: fc.boolean(),
      quantity: fc.integer({ min: 1, max: 6 }),
      pick: fc.nat(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(tradeArb, { minLength: 1, maxLength: 80 }),
        fc.array(actionArb, { maxLength: 40 }),
        fc.record({ latencyMs: fc.integer({ min: 0, max: 60 }), makerFeeBps: fc.integer({ min: -3, max: 10 }), takerFeeBps: fc.integer({ min: 0, max: 20 }), queue: fc.constantFrom("through" as const, "touch" as const) }),
        async (rawTrades, rawActions, cfg) => {
          let time = -rawTrades[0]!.dt; // the tape starts at 0, so every scripted step is in the future
          const trades = rawTrades.map((r) => t((time += r.dt), r.price, r.quantity, r.side));
          // Whether a print reaches a quote: one on the other side through it (or, optimistically,
          // at it), or one on its own side at or beyond it, which proves the quote crossed.
          const reaches = (q: { side: Side; price: number }, x: MarketTrade) => {
            const beyond = q.side === "buy" ? q.price - x.price : x.price - q.price;
            return x.takerSide !== q.side && cfg.queue === "through" ? beyond > 0 : beyond >= 0;
          };
          const seenFills: Fill[] = [];
          let fromThisPrint: Fill[] = [];
          const placed: string[] = [];
          // At every callback, the identity holds over the fills the strategy has been told about.
          const identity = (ctx: StrategyContext) => {
            if (ctx.lastPrice === null) return;
            const equity = ctx.cash + ctx.position * ctx.lastPrice;
            expect(equity - 1_000).toBeCloseTo(gainFromFills(seenFills, ctx.lastPrice, 1), 9);
            expect(ctx.position).toBe(seenFills.reduce((s, f) => s + (f.side === "buy" ? f.quantity : -f.quantity), 0));
          };
          const steps: Record<number, (ctx: StrategyContext) => void> = {};
          for (const a of rawActions) {
            const previous = steps[a.at];
            steps[a.at] = (ctx) => {
              previous?.(ctx);
              identity(ctx);
              if (a.kind === "cancel") {
                if (placed.length > 0) ctx.cancel(placed[a.pick % placed.length]!);
              } else if (a.kind === "market") {
                ctx.marketOrder(a.side, a.quantity);
              } else if (ctx.touch !== null) {
                const price = a.side === "buy" ? ctx.touch.bid - a.offset : ctx.touch.ask + a.offset;
                if (price > 0) placed.push(ctx.placeLimit(a.side, price, a.quantity, { postOnly: a.postOnly }));
              }
            };
          }
          const { result, fills, actions } = await runBacktest(
            scripted(steps, {
              onFill: (ctx, fill) => {
                seenFills.push(fill);
                if (fill.liquidity === "maker") fromThisPrint.push(fill);
                identity(ctx);
              },
              onTrade: (ctx, trade) => {
                identity(ctx);
                // No quote is left resting where this print reaches it, unless the print's size ran out on that side.
                for (const o of ctx.openOrders()) {
                  if (o.status !== "open" || !reaches({ side: o.side, price: o.price! }, trade)) continue;
                  expect(fromThisPrint.filter((f) => f.side === o.side).reduce((s, f) => s + f.quantity, 0)).toBe(trade.quantity);
                }
                fromThisPrint = [];
              },
            }),
            tape(...trades),
            { ...base, ...cfg },
          );

          const mark = trades.at(-1)!.price;
          expect(result.equity.at(-1)![1] - 1_000).toBeCloseTo(gainFromFills(fills, mark, 1), 9);
          expect(result.pnl.fees).toBeCloseTo(fills.reduce((s, f) => s + f.fee, 0), 9);
          // Every fill comes after its order reached the exchange, and never exceeds the order.
          const arrived = new Map(actions.filter((a) => a.kind !== "cancel").map((a) => [a.orderId, a]));
          const filled = new Map<string, number>();
          for (const f of fills) {
            expect(f.time).toBeGreaterThanOrEqual(arrived.get(f.orderId)!.arrivedAt);
            filled.set(f.orderId, (filled.get(f.orderId) ?? 0) + f.quantity);
          }
          for (const [id, q] of filled) expect(q).toBeLessThanOrEqual(arrived.get(id)!.quantity!);
          // A limit order that takes liquidity does so in full the moment it arrives, never past its limit.
          for (const f of fills.filter((x) => x.liquidity === "taker" && arrived.get(x.orderId)!.kind === "limit")) {
            const order = arrived.get(f.orderId)!;
            expect(f.time).toBe(order.arrivedAt);
            expect(f.quantity).toBe(order.quantity);
            expect(f.side === "buy" ? f.price <= order.price! : f.price >= order.price!).toBe(true);
          }
          expect(result.quotes.marketable.orders).toBe(fills.filter((x) => x.liquidity === "taker" && arrived.get(x.orderId)!.kind === "limit").length);
          // A maker fill needs a print at that moment that reaches it, and the strategy never
          // takes more on a side than the prints that reach it traded.
          const maker = fills.filter((x) => x.liquidity === "maker");
          for (const f of maker) {
            const prints = trades.filter((x) => x.time === f.time);
            expect(prints.some((x) => reaches(f, x))).toBe(true);
            const sameMoment = maker.filter((x) => x.time === f.time && x.side === f.side);
            const reaching = prints.filter((x) => sameMoment.some((y) => reaches(y, x)));
            expect(sameMoment.reduce((s, x) => s + x.quantity, 0)).toBeLessThanOrEqual(reaching.reduce((s, x) => s + x.quantity, 0));
          }
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 200) },
    );
  }, 120_000);
});

describe("markouts", () => {
  it("measures the move after each fill, from the tape, weighted by quantity", async () => {
    const data = tape(
      t(0, 100, 1, "buy"), // touch 99 / 100
      t(500, 97, 5, "sell"), // through our bid at 98: 4 @ 98
      t(600, 102, 1, "buy"), // through our ask at 101: 1 @ 101
      t(1_400, 99, 1, "sell"), // the price 1 s after the bid fill
      t(1_550, 100, 1, "buy"), // ... and 1 s after the ask fill (at 1,600)
      t(10_400, 95, 1, "sell"), // 10 s after both
      t(30_000, 96, 1, "sell"), // the end: too soon for the 60 s horizon
    );
    const strategy = scripted({
      0: (ctx) => {
        ctx.placeLimit("buy", 98, 4);
        ctx.placeLimit("sell", 101, 1);
      },
    });
    const { result } = await runBacktest(strategy, data, base);
    // Bought 4 @ 98 and sold 1 @ 101; a buy gains when the price rises, a sale when it falls.
    const oneSecond = ((4 * (99 - 98)) / 98 + (1 * (101 - 100)) / 101) * (10_000 / 5);
    const tenSeconds = ((4 * (95 - 98)) / 98 + (1 * (101 - 95)) / 101) * (10_000 / 5);
    expect(result.markouts.map((m) => m.horizonMs)).toEqual([1_000, 10_000, 60_000]);
    expect(result.markouts[0]!.bps).toBeCloseTo(oneSecond, 9);
    expect(result.markouts[1]!.bps).toBeCloseTo(tenSeconds, 9);
    expect(result.markouts[2]).toEqual({ horizonMs: 60_000, bps: null, fills: 0 });
    expect(result.markouts[0]!.fills).toBe(2);
  });
});

describe("where the quotes sat", () => {
  it("measures each quote's distance from the price when placed, and what the ones at the touch did", async () => {
    // Prices of 100,000 ticks, so a tick is 0.1 bps and 0.5 bps is five ticks.
    const data = tape(
      t(0, 100_000, 1, "sell"), // touch 100,000 / 100,001
      t(10, 99_995, 3, "sell"), // through our bid at the touch: 2 @ 100,000
      t(20, 100_020, 1, "buy"), // through our ask 1 bps away: 1 @ 100,010
      t(30, 99_980, 5, "sell"), // through our bid 1 bps away: 3 @ 99,990
      t(1_030, 99_970, 1, "sell"),
    );
    const strategy = scripted({
      0: (ctx) => {
        ctx.placeLimit("buy", 100_000, 2, { tag: "touch" }); // 0 bps: at the touch
        ctx.placeLimit("sell", 100_010, 1); // 1 bps
        ctx.placeLimit("buy", 99_990, 3); // 1 bps
      },
    });
    const { result, fills } = await runBacktest(strategy, data, { ...base, capital: 1_000_000 });
    expect(fills.map((f) => [f.time, f.side, f.price, f.quantity])).toEqual([
      [10, "buy", 100_000, 2],
      [20, "sell", 100_010, 1],
      [30, "buy", 99_990, 3],
    ]);
    // Distances 0, 1, 1: the 10th percentile interpolates a fifth of the way from 0 to 1.
    expect(result.quotes.placed).toBe(3);
    expect(result.quotes.distanceBps).toEqual({ p10: expect.closeTo(0.2, 12), median: 1, p90: 1 });
    expect(result.quotes.nearBps).toBe(0.5);
    const near = result.quotes.near;
    expect(near.orders).toBe(1);
    expect(near.fillShare).toBeCloseTo(2 / 6, 12);
    expect(result.quotes.tags).toEqual({ touch: { orders: 1, makerQuantity: 2, fillShare: expect.closeTo(2 / 6, 12) } });
    // The touch fill (2 @ 100,000 at 10 ms): 1 s later the price is 99,980, -2 bps for a buyer.
    expect(near.markouts).toEqual([
      { horizonMs: 1_000, bps: expect.closeTo(-2, 9), fills: 1 },
      { horizonMs: 10_000, bps: null, fills: 0 }, // the tape ends at 1,030 ms
      { horizonMs: 60_000, bps: null, fills: 0 },
    ]);
  });
});

describe("metrics", () => {
  it("computes the Sharpe ratio and drawdown by hand", () => {
    // Mean 1, sample standard deviation sqrt(((1-1)^2 + (3-1)^2 + (-1-1)^2) / 2) = 2.
    expect(sharpe([1, 3, -1])).toBeCloseTo(0.5, 12);
    expect(sharpe([1])).toBeNull();
    expect(sharpe([2, 2, 2])).toBeNull(); // no variation: undefined, not infinite
    expect(maxDrawdown([100, 120, 90, 130, 104])).toEqual({ amount: 30, fraction: 0.25 });
  });

  it("samples equity on the clock and takes the Sharpe ratio over whole minutes", async () => {
    const data = tape(t(0, 100, 1, "buy"), t(60_000, 110, 1, "buy"), t(120_000, 99, 1, "sell"), t(150_000, 105, 1, "buy"));
    const { result } = await runBacktest(scripted({ 0: (ctx) => ctx.marketOrder("buy", 10) }), data, { ...base, sampleMs: 30_000 });
    // Bought 10 at 100 (the ask) just after the first print; marked at 100, 110, 99, then 105.
    expect(result.equity.map(([time]) => time)).toEqual([0, 30_000, 60_000, 90_000, 120_000, 150_000, 150_000]);
    expect(result.equity.map(([, e]) => e)).toEqual([1_000, 1_000, 1_000, 1_100, 1_100, 990, 1_050]);
    // Minute points: start 1,000, 1,000 at 1:00 (before that minute's print), 1,100 at 2:00, then 1,050 at the end.
    const returns = [0, 0.1, -0.05];
    expect(result.sharpe.returns).toBe(3);
    expect(result.sharpe.perMinute).toBeCloseTo(sharpe(returns)!, 12);
    expect(result.sharpe.annualised).toBeCloseTo(sharpe(returns)! * Math.sqrt(525_600), 9);
    // The drawdown is watched at every print, not just at the samples: 1,100 -> 990.
    expect(result.maxDrawdown.amount).toBeCloseTo(110, 9);
    expect(result.maxDrawdown.fraction).toBeCloseTo(0.1, 12);
  });
});
