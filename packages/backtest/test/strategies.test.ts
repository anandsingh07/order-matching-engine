import { readFileSync } from "node:fs";
import { AvellanedaStoikovMaker, FlowImbalance, observation, RlMarketMaker, RlPolicy } from "@ome/bots";
import type { Side, TradingClient } from "@ome/client";
import { MinuteBars, type Forecast } from "@ome/volatility";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ActionBudget,
  BTCUSDT,
  createStrategy,
  HELD_TAG,
  LADDER_PARAMS,
  loadMarketData,
  MINUTE_MS,
  movingAverageCrossover,
  parseKlines,
  REFERENCE_VOL_BPS,
  requote,
  runBacktest,
  STRATEGY_NAMES,
  UNIT_QUANTITY,
  type MarketData,
  type MinuteBar,
  type LimitOptions,
  type StrategyContext,
  type StrategyName,
  type StrategyOrder,
} from "../src/index.js";
import { FIXTURE_KLINES, gainFromFills, realData, TOY } from "./helpers.js";

let policy: RlPolicy;
let data: MarketData;
const scale = BTCUSDT.priceScale * BTCUSDT.quantityScale;
const make = (name: StrategyName) => createStrategy(name, { policy });

beforeAll(async () => {
  policy = await RlPolicy.load();
  data = realData();
}, 60_000);

describe("the built-in strategies on 30 minutes of real BTC/USDT", () => {
  it("loads the real tape and its warm-up", () => {
    expect(data.kind).toBe("trades");
    if (data.kind !== "trades") return;
    expect(data.trades).toHaveLength(30_044);
    expect(data.warmup).toHaveLength(240); // the 4 hours before 14:30, so the forecast is ready from the first minute
    expect(data.warmup.at(-1)!.time + MINUTE_MS).toBe(data.trades[0]!.time - 336);
  });

  for (const name of STRATEGY_NAMES) {
    it(`${name}: runs, trades, keeps its books straight, and gives the same result twice`, async () => {
      const first = await runBacktest(await make(name), data);
      const second = await runBacktest(await make(name), data);
      expect(second.result).toEqual(first.result);
      expect(second.fills).toEqual(first.fills);

      const { result, fills } = first;
      expect(result.fills.count).toBeGreaterThan(0);
      expect(result.fills.count).toBe(fills.length);
      // cash + position x mark = the fills' gains minus fees (in USDT; the fees are sums of fractions).
      const mark = result.data.lastPrice!;
      expect(result.equity.at(-1)![1] - result.config.capital).toBeCloseTo(gainFromFills(fills, mark, scale), 6);
      expect(result.inventory.final).toBe(fills.reduce((s, f) => s + (f.side === "buy" ? f.quantity : -f.quantity), 0));
      if (name === "ma") {
        expect(result.fills.maker).toBe(0); // a taker only
      } else {
        // Quotes only: a taker fill is a quote that crossed the touch on arrival, as a plain limit order does live.
        expect(result.orders.market).toBe(0);
        expect(result.fills.taker).toBe(result.quotes.marketable.orders);
        // Inventory limits hold, give or take the fill that crosses them.
        const limit = name === "ladder" ? LADDER_PARAMS.maxPosition + UNIT_QUANTITY : (policy.manifest.environment.max_inventory + 1) * UNIT_QUANTITY;
        expect(result.inventory.maxAbs).toBeLessThanOrEqual(limit);
      }
    }, 60_000);
  }

  it('with crossing "hold", the market makers only ever make, and say how much came from quotes held at the touch', async () => {
    for (const name of ["ladder", "as", "rl"] as const) {
      const { result } = await runBacktest(await createStrategy(name, { policy, crossing: "hold" }), data);
      expect(result.fills.taker, name).toBe(0);
      expect(result.quotes.marketable, name).toEqual({ orders: 0, quantity: 0 });
      const held = result.quotes.tags[HELD_TAG];
      if (held === undefined) continue;
      // The tag's share is the held orders' maker fills over all of them.
      expect(held.makerQuantity).toBeLessThanOrEqual(result.fills.makerQuantity);
      expect(held.fillShare).toBeCloseTo(held.makerQuantity / result.fills.makerQuantity, 12);
    }
    // The policy does want quotes through the touch: with "take" those trade, with "hold" they wait there.
    const take = await runBacktest(await make("rl"), data);
    const hold = await runBacktest(await createStrategy("rl", { policy, crossing: "hold" }), data);
    expect(take.result.quotes.marketable.orders).toBeGreaterThan(0);
    expect(hold.result.quotes.tags[HELD_TAG]!.orders).toBeGreaterThan(0);
  }, 60_000);

  it("cannot see the future: rewriting everything after a moment changes nothing before it", async () => {
    if (data.kind !== "trades") throw new Error("expected trades");
    const cut = data.trades[0]!.time + 15 * MINUTE_MS;
    // Same times, different prices and sides after the cut.
    const rewritten: MarketData = {
      ...data,
      trades: data.trades.map((tr) => (tr.time < cut ? tr : { ...tr, price: Math.round(tr.price * 1.01), takerSide: tr.takerSide === "buy" ? "sell" : "buy" })),
    };
    for (const name of STRATEGY_NAMES) {
      const a = await runBacktest(await make(name), data);
      const b = await runBacktest(await make(name), rewritten);
      const before = <T extends { decidedAt?: number; time?: number }>(xs: T[]) => xs.filter((x) => (x.decidedAt ?? x.time)! < cut);
      expect(before(b.actions), name).toEqual(before(a.actions));
      expect(before(b.fills), name).toEqual(before(a.fills));
      expect(b.result.equity.filter(([time]) => time < cut), name).toEqual(a.result.equity.filter(([time]) => time < cut));
      // And the rewrite did change what came after, so the comparison has teeth.
      expect(b.fills, name).not.toEqual(a.fills);
    }
  }, 120_000);
});

describe("minute bars", () => {
  it("built from the tape, they are Binance's own 1-minute klines, and what the live MinuteBars makes", async () => {
    if (data.kind !== "trades") throw new Error("expected trades");
    const bars: MinuteBar[] = [];
    await runBacktest({ name: "bars", onBar: (_ctx, bar) => void bars.push(bar) }, data);
    // Every minute but the last, which the tape ends inside of.
    expect(bars).toHaveLength(29);
    const klines = parseKlines(readFileSync(FIXTURE_KLINES, "utf8"), BTCUSDT);
    const byTime = new Map(klines.map((k) => [k.time, k]));
    for (const bar of bars) expect(bar).toEqual(byTime.get(bar.time));

    const live = new MinuteBars();
    const liveBars = data.trades.flatMap((tr) => live.trade(tr.price, tr.time));
    expect(liveBars).toEqual(bars.slice(0, liveBars.length).map(({ high, low, close }) => ({ high, low, close })));
  }, 60_000);

  it("the MA crossover goes long when the fast mean is above the slow one, and short when it is below", async () => {
    // A 2/4 crossover holding 3 units, on closes that rise and then fall.
    const closes = [100, 101, 102, 103, 104, 100, 96, 92];
    const bars = closes.map((close, i) => ({ time: i * MINUTE_MS, open: close, high: close, low: close, close, volume: 1 }));
    const { result, fills } = await runBacktest(
      movingAverageCrossover({ fast: 2, slow: 4, quantity: 3 }),
      { kind: "bars", symbol: "TOY", bars, warmup: [] },
      { instrument: TOY, capital: 1_000, latencyMs: 0, slippageBps: 0 },
    );
    // At the 4th close (103) the fast mean 102.5 is above the slow 101.5: buy 3 at the ask, a tick above.
    // At the 6th (100) the fast mean 102 falls below the slow 102.25: sell 6, to short 3, at the bid.
    // The 5th, 7th and 8th closes keep the side it is on: no orders.
    expect(fills.map((f) => [f.time, f.side, f.price, f.quantity])).toEqual([
      [4 * MINUTE_MS, "buy", 104, 3],
      [6 * MINUTE_MS, "sell", 99, 6],
    ]);
    expect(result.inventory.final).toBe(-3);
  });

  it("the MA crossover runs on klines, filling off the close it decided on plus the spread and slippage", async () => {
    const bars = loadMarketData(FIXTURE_KLINES, BTCUSDT);
    expect(bars.kind).toBe("bars");
    if (bars.kind !== "bars") return;
    const { fills } = await runBacktest(await make("ma"), bars, { slippageBps: 1 });
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) {
      // Decided at a bar's close, it arrives 50 ms later. When in the next minute that
      // minute's open printed is unknown (usually after 50 ms), so the price then is the close.
      const decided = bars.bars.find((b) => b.time + MINUTE_MS === f.time - 50)!;
      const slip = 1 / 10_000;
      const expected = f.side === "buy" ? Math.ceil((decided.close + 1) * (1 + slip)) : Math.floor((decided.close - 1) * (1 - slip));
      expect(f.price).toBe(expected);
    }
  });
});

describe("quoting", () => {
  /** Records what requote asks for, against a fixed touch and set of open orders. */
  function fakeContext(open: Partial<StrategyOrder>[], touch = { bid: 100, ask: 101 }) {
    const placed: [string, number, number][] = [];
    const options: (LimitOptions | undefined)[] = [];
    const cancelled: string[] = [];
    const ctx = {
      now: 0,
      touch,
      openOrders: () => open.map((o) => ({ type: "limit", cancelRequested: false, ...o }) as StrategyOrder),
      placeLimit: (side: string, price: number, quantity: number, o?: LimitOptions) => {
        placed.push([side, price, quantity]);
        options.push(o);
        return `n${placed.length}`;
      },
      cancel: (id: string) => void cancelled.push(id),
    } as unknown as StrategyContext;
    return { ctx, placed, options, cancelled };
  }

  it("leaves unchanged quotes alone, so they keep their place in the queue", () => {
    const { ctx, placed, cancelled } = fakeContext([
      { id: "a", side: "buy", price: 98 },
      { id: "b", side: "sell", price: 103 },
    ]);
    requote(ctx, [
      { side: "buy", price: 98, quantity: 5 },
      { side: "sell", price: 104, quantity: 5 },
    ]);
    expect(cancelled).toEqual(["b"]);
    expect(placed).toEqual([["sell", 104, 5]]);
  });

  it("sends every quote as the plain limit order the live bot sends, one through the touch included", () => {
    const { ctx, placed, options } = fakeContext([]);
    requote(ctx, [
      { side: "buy", price: 101, quantity: 1 },
      { side: "sell", price: 102, quantity: 1 },
    ]);
    expect(placed).toEqual([
      ["buy", 101, 1],
      ["sell", 102, 1],
    ]);
    expect(options).toEqual([{ postOnly: false }, { postOnly: false }]);
  });

  it('with crossing "hold", posts a quote that would cross at the touch instead, and tags it', () => {
    const { ctx, placed, options } = fakeContext([]);
    requote(
      ctx,
      [
        { side: "buy", price: 101, quantity: 1 },
        { side: "sell", price: 99, quantity: 1 },
        { side: "buy", price: 100, quantity: 1 }, // clamps onto the first one: dropped
        { side: "sell", price: 103, quantity: 1 },
      ],
      undefined,
      "hold",
    );
    expect(placed).toEqual([
      ["buy", 100, 1],
      ["sell", 101, 1],
      ["sell", 103, 1],
    ]);
    expect(options).toEqual([{ tag: HELD_TAG }, { tag: HELD_TAG }, {}]);
  });

  it("spends the live bot's action budget on cancels first, then the quotes nearest the touch", () => {
    const { ctx, placed, cancelled } = fakeContext([
      { id: "a", side: "buy", price: 90 },
      { id: "b", side: "sell", price: 110 },
    ]);
    requote(
      ctx,
      [
        { side: "buy", price: 99, quantity: 1 },
        { side: "sell", price: 102, quantity: 1 },
        { side: "buy", price: 98, quantity: 1 },
      ],
      new ActionBudget(3),
    );
    expect(cancelled).toEqual(["a", "b"]);
    expect(placed).toEqual([["buy", 99, 1]]);
  });

  it("uses the reference volatility the policy's observations are relative to", () => {
    expect(observation(0, 10, REFERENCE_VOL_BPS, 0)[1]).toBe(0);
  });
});

describe("the same quotes as the live bots", () => {
  /** A TradingClient that records the orders a live bot sends and lets the test deliver its messages. */
  function fakeClient() {
    const listeners = new Map<string, ((m: unknown) => void)[]>();
    const placed: [string, number, number][] = [];
    let n = 0;
    const client = {
      open: true,
      on: (type: string, listener: (m: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        return () => undefined;
      },
      subscribe: () => undefined,
      newOrderId: (prefix = "o") => `${prefix}${++n}`,
      placeOrder: async (_symbol: string, _id: string, order: { side: string; price: number; quantity: number }) => {
        placed.push([order.side, order.price, order.quantity]);
        return { type: "ack" };
      },
      cancel: async () => ({ type: "ack" }),
    };
    const emit = (message: { type: string }) => {
      for (const listener of listeners.get(message.type) ?? []) listener(message);
    };
    return { client: client as unknown as TradingClient, placed, emit };
  }

  // A minute of market: the tape leaning to buyers, then to sellers, with quiet seconds;
  // inventory walking to both limits through positions that are not whole units; no
  // forecast at first, then a range of them; and a fair price off the round numbers.
  // The forecasts convert to bps identically both ways (sigmaPct x 100 live, sigma x
  // 10,000 here); some values, 0.35 among them, differ in the last bit.
  const units = [0, 1, 3, 6, 9, 10, 10, 8, 5, 2, 0, -1, -4, -7, -10, -10, -9, -6, -3, -1];
  const second = (k: number) => {
    const buyers = k % 20 < 10;
    const quiet = k % 7 === 3;
    const sides: Side[] = quiet ? [] : [...Array<Side>(buyers ? 5 : 1).fill("buy"), ...Array<Side>(buyers ? 1 : 5).fill("sell")];
    const remainder = [0, 999, 1_000, -999][k % 4]!; // Math.round of x.4995, x.5 and the like
    return {
      sides: k % 2 === 0 ? sides : sides.reverse(),
      position: units[k % units.length]! * UNIT_QUANTITY + remainder,
      sigmaPct: k < 5 ? null : [0.15, 0.2, 0.3, 0.6, 1.2][k % 5]!,
      fair: 8_146_601 + 37 * k - (k % 4) * 113,
    };
  };

  for (const name of ["rl", "as"] as const) {
    it(`${name}: places exactly the quotes the live bot would, second by second`, async () => {
      // The live bot, built as services/bots/src/compare.ts builds it.
      const manifest = policy.manifest;
      const single = { unitQuantity: UNIT_QUANTITY, maxInventory: manifest.environment.max_inventory, maxActionsPerSecond: 10_000 };
      const live = fakeClient();
      let fair = 0;
      const bot =
        name === "rl"
          ? new RlMarketMaker(live.client, BTCUSDT, () => fair, single, policy)
          : new AvellanedaStoikovMaker(live.client, BTCUSDT, () => fair, single, manifest.baselines.as_gamma, manifest.environment.depth_decay);

      // The backtest's strategy, on a context that holds the same state, and the touch the
      // tape implies: a buyer-initiated last print is at the ask, a seller-initiated one at
      // the bid. It has no open orders, as the live bot's tracker has none. A quote through
      // that touch must still be sent as the live bot sends it, as a plain limit order.
      const ours: [string, number, number][] = [];
      const sent: (LimitOptions | undefined)[] = [];
      const state = {
        instrument: BTCUSDT,
        now: 0,
        position: 0,
        lastPrice: null as number | null,
        touch: { bid: 0, ask: 0 },
        volatility: null as Forecast | null,
        openOrders: () => [],
        placeLimit: (side: string, price: number, quantity: number, options?: LimitOptions) => {
          ours.push([side, price, quantity]);
          sent.push(options);
          return `b${ours.length}`;
        },
        cancel: () => undefined,
        every: () => undefined,
      };
      const ctx = state as unknown as StrategyContext;
      const strategy = await make(name);
      await strategy.init?.(ctx);

      const flow = new FlowImbalance();
      let position = 0;
      let longLimit = 0;
      let shortLimit = 0;
      let leaning = 0;
      let crossing = 0;
      for (let k = 0; k < 60; k++) {
        const s = second(k);
        state.now = (k + 1) * 1_000;
        for (const side of s.sides) {
          live.emit({ type: "trade", symbol: "BTCUSDT", trade: { id: k, price: s.fair, quantity: 1, side, time: state.now } } as { type: string });
          await strategy.onTrade?.(ctx, { time: state.now, price: s.fair, quantity: 1, takerSide: side });
          flow.add(side);
        }
        flow.tick();
        if (Math.abs(flow.value) > 0.5) leaning++;
        const change = s.position - position;
        if (change !== 0) {
          const fill = { type: "execution", symbol: "BTCUSDT", clientOrderId: "x", time: 0, event: "fill", side: change > 0 ? "buy" : "sell", price: s.fair, quantity: Math.abs(change), liquidity: "maker" };
          live.emit(fill);
        }
        position = state.position = s.position;
        live.emit({ type: "status", symbol: "BTCUSDT", volatility: s.sigmaPct === null ? null : { sigmaPct: s.sigmaPct, horizonMinutes: 15, model: "har" } } as { type: string });
        state.volatility = s.sigmaPct === null ? null : { model: "har", horizonMinutes: 15, sigma: s.sigmaPct / 100, bars: 240 };
        fair = s.fair;
        state.lastPrice = s.fair;
        const lastTaker = s.sides.at(-1) ?? "buy";
        state.touch = lastTaker === "buy" ? { bid: s.fair - 1, ask: s.fair } : { bid: s.fair, ask: s.fair + 1 };

        live.placed.length = 0;
        ours.length = 0;
        await bot.step();
        await strategy.onTimer?.(ctx, "step");
        expect(ours, `second ${k}`).toEqual(live.placed);
        expect(sent.every((o) => o?.postOnly === false), `second ${k}`).toBe(true);
        sent.length = 0;
        if (ours.some(([side, price]) => (side === "buy" ? price >= state.touch.ask : price <= state.touch.bid))) crossing++;
        if (live.placed.length === 1 && live.placed[0]![0] === "sell") longLimit++; // at the long limit: no bid
        if (live.placed.length === 1 && live.placed[0]![0] === "buy") shortLimit++;
      }
      // The minute did reach both inventory limits and a strongly one-sided tape.
      expect(longLimit).toBeGreaterThan(0);
      expect(shortLimit).toBeGreaterThan(0);
      expect(leaning).toBeGreaterThan(10);
      // The policy quotes through the touch in this minute, so the comparison covers that case too.
      if (name === "rl") expect(crossing).toBeGreaterThan(0);
      await bot.stop();
    }, 60_000);
  }
});
