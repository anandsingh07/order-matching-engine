import { describe, expect, it } from "vitest";
import {
  compareWindows,
  createStrategy,
  meanWithCi,
  MINUTE_MS,
  runBacktest,
  splitWindows,
  tapeBars,
  tQuantile975,
  type BacktestResult,
  type MarketData,
  type MinuteBar,
} from "../src/index.js";
import { realData, scripted, t, tape, TOY } from "./helpers.js";

const trades = (d: MarketData) => {
  if (d.kind !== "trades") throw new Error("expected trades");
  return d.trades;
};

describe("windows", () => {
  it("cut the tape into whole-minute windows that add up to it exactly", () => {
    const data = realData();
    const parts = splitWindows(data, 10);
    expect(parts).toHaveLength(3); // 14:30, 14:40, 14:50
    expect(parts.flatMap(trades)).toEqual(trades(data));
    parts.forEach((part, k) => {
      const from = Math.floor(trades(data)[0]!.time / MINUTE_MS) * MINUTE_MS + k * 10 * MINUTE_MS;
      expect(trades(part).every((tr) => tr.time >= from && tr.time < from + 10 * MINUTE_MS)).toBe(true);
      // Warm-up: the 240 klines before the tape, then the window's predecessors' minutes; never anything after its start.
      expect(part.warmup).toHaveLength(240 + 10 * k);
      expect(part.warmup.at(-1)!.time + MINUTE_MS).toBe(from);
    });
  });

  it("leave out a last window the tape does not reach the final minute of", () => {
    const data = tape(t(0, 100, 1, "buy"), t(125_000, 101, 1, "buy"), t(130_000, 102, 1, "sell"));
    // Windows of 2 minutes: [0, 2 min) is complete; [2 min, 4 min) has trades only in its first minute.
    expect(splitWindows(data, 2).map((p) => trades(p).length)).toEqual([1]);
    expect(splitWindows(data, 1).map((p) => trades(p).length)).toEqual([1, 2]); // the empty minute is skipped
  });

  it("start each window with the volatility forecast the continuous run had at that moment", async () => {
    const data = realData();
    const continuous = new Map<number, number>();
    await runBacktest({ name: "probe", onBar: (ctx, bar) => void continuous.set(bar.time + MINUTE_MS, ctx.volatility!.sigma) }, data);
    const parts = splitWindows(data, 10);
    for (const part of parts.slice(1)) {
      // "That moment" is the window's start, taken from its own trades, never from its warm-up.
      const start = Math.floor(trades(part)[0]!.time / MINUTE_MS) * MINUTE_MS;
      expect(part.warmup.at(-1)!.time + MINUTE_MS).toBe(start);
      let sigma: number | undefined;
      await runBacktest({ name: "probe", init: (ctx) => void (sigma = ctx.volatility!.sigma) }, part);
      expect(continuous.has(start)).toBe(true);
      expect(sigma).toBe(continuous.get(start));
    }
  });

  it("tape bars are the engine's own bars", async () => {
    const data = realData();
    const bars: MinuteBar[] = [];
    await runBacktest({ name: "bars", onBar: (_ctx, bar) => void bars.push(bar) }, data);
    expect(tapeBars(trades(data))).toEqual(bars);
    // With a gap, the empty minutes are flat at the last price, as the engine makes them. A trade
    // exactly on a minute boundary (180 s) opens the new minute; it is not the old one's close.
    const gappy = tape(t(0, 100, 2, "buy"), t(30_000, 104, 1, "sell"), t(180_000, 102, 1, "sell"), t(200_000, 99, 1, "buy"), t(250_000, 98, 1, "buy"));
    const engine: MinuteBar[] = [];
    await runBacktest({ name: "bars", onBar: (_ctx, bar) => void engine.push(bar) }, gappy, { instrument: TOY });
    expect(tapeBars(trades(gappy))).toEqual(engine);
    // The minute the tape ends in (from 240 s) is incomplete and left out.
    expect(engine.map((b) => [b.time, b.open, b.close, b.volume])).toEqual([
      [0, 100, 104, 3],
      [60_000, 104, 104, 0],
      [120_000, 104, 104, 0],
      [180_000, 102, 99, 2],
    ]);
  });
});

describe("comparing windows", () => {
  it("gives a Student-t confidence interval, checked by hand", () => {
    expect(tQuantile975(1)).toBe(12.706);
    expect(tQuantile975(30)).toBe(2.042);
    expect(tQuantile975(47)).toBeCloseTo(2.0117, 3); // the expansion beyond the table
    expect(tQuantile975(1_000_000)).toBeCloseTo(1.96, 3);
    // Mean 2.5, sample sd sqrt(5/3), half-width 3.182 x sd / 2.
    const { mean, sd, ci95 } = meanWithCi([1, 2, 3, 4]);
    expect(mean).toBe(2.5);
    expect(sd).toBeCloseTo(Math.sqrt(5 / 3), 12);
    expect(ci95![0]).toBeCloseTo(2.5 - (3.182 * Math.sqrt(5 / 3)) / 2, 12);
    expect(meanWithCi([7]).ci95).toBeNull();
  });

  it("pairs every strategy with the baseline window by window", async () => {
    // Two windows of a minute; a buyer and a seller of one unit at the first print, closed at each window's end.
    const data = tape(t(0, 100, 1, "buy"), t(30_000, 110, 1, "buy"), t(60_000, 100, 1, "sell"), t(90_000, 90, 1, "sell"), t(119_000, 85, 1, "sell"));
    const config = { instrument: TOY, capital: 1_000, latencyMs: 0, slippageBps: 0 };
    const runs: BacktestResult[][] = [];
    for (const part of splitWindows(data, 1)) {
      const row: BacktestResult[] = [];
      for (const side of ["buy", "sell"] as const) {
        const s = { ...scripted({ [trades(part)[0]!.time]: (ctx) => void ctx.marketOrder(side, 1) }), name: side };
        row.push((await runBacktest(s, part, config)).result);
      }
      runs.push(row);
    }
    const cmp = compareWindows(runs, 1, "sell");
    // Window 1 ends on a buy at 110, so the touch is 109 / 110: bought at the ask (100) and
    // closed at the bid (109): +9; sold at the bid (99) and closed at the ask (110): -11.
    // Window 2 opens on a sell at 100 (touch 100 / 101) and ends on a sell at 85 (touch 85 / 86):
    // bought at 101, closed at 85: -16; sold at 100, closed at 86: +14.
    expect(cmp.windows.map((w) => w.pnl)).toEqual([
      { buy: 9, sell: -11 },
      { buy: -16, sell: 14 },
    ]);
    expect(cmp.baseline).toBe("sell");
    expect(cmp.versusBaseline).toHaveLength(1);
    expect(cmp.versusBaseline[0]!.mean).toBe((9 - -11 + (-16 - 14)) / 2);
    expect(cmp.versusBaseline[0]!.betterShare).toBe(0.5);
    expect(cmp.strategies.map((s) => [s.strategy, s.total, s.positive])).toEqual([
      ["buy", -7, 1],
      ["sell", 3, 1],
    ]);
  });

  it("runs the built-in strategies on windows of the real tape", async () => {
    const parts = splitWindows(realData(), 10);
    const runs: BacktestResult[][] = [];
    for (const part of parts) runs.push([(await runBacktest(await createStrategy("as"), part)).result, (await runBacktest(await createStrategy("ma"), part)).result]);
    const cmp = compareWindows(runs, 10, "as");
    expect(cmp.windows).toHaveLength(3);
    expect(cmp.strategies.map((s) => s.strategy)).toEqual(["as", "ma"]);
    expect(cmp.strategies[0]!.total).toBeCloseTo(runs.reduce((s, r) => s + r[0]!.pnl.afterClose, 0), 9);
  }, 60_000);
});
