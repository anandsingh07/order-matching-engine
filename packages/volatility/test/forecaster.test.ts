import { describe, expect, it } from "vitest";
import { HORIZON, loadManifest, MinuteBars, VolatilityForecaster, VolatilityMonitor, type Bar } from "../src/index.js";

const manifest = loadManifest();
const MINUTE = 60_000;

/** A random walk with the given per-minute volatility. */
function walk(n: number, sigma: number, seed = 1, start = 100): Bar[] {
  let s = seed;
  const uniform = () => ((s = (s * 1_103_515_245 + 12_345) % 2 ** 31) + 1) / (2 ** 31 + 1);
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    const next = price * Math.exp(sigma * z);
    bars.push({ high: Math.max(price, next), low: Math.min(price, next), close: next });
    price = next;
  }
  return bars;
}

describe("MinuteBars", () => {
  it("builds OHLC bars from trades and closes a minute when the next one starts", () => {
    const bars = new MinuteBars();
    expect(bars.trade(100, 0)).toEqual([]);
    bars.trade(103, 10_000);
    bars.trade(98, 20_000);
    bars.trade(101, 59_999);
    expect(bars.trade(102, MINUTE)).toEqual([{ high: 103, low: 98, close: 101 }]);
  });

  it("fills minutes without trades with flat bars, up to the gap limit", () => {
    const bars = new MinuteBars(MINUTE, 5);
    bars.trade(100, 0);
    expect(bars.roll(3 * MINUTE + 1)).toEqual([
      { high: 100, low: 100, close: 100 },
      { high: 100, low: 100, close: 100 },
      { high: 100, low: 100, close: 100 },
    ]);
    // A bar with no trades yet starts at its first trade, not at the previous close.
    bars.trade(90, 3 * MINUTE + 2);
    expect(bars.roll(4 * MINUTE)).toEqual([{ high: 90, low: 90, close: 90 }]);
    expect(bars.roll(100 * MINUTE)).toHaveLength(1 + 5);
  });

  it("does nothing before the first trade", () => {
    expect(new MinuteBars().roll(10 * MINUTE)).toEqual([]);
  });
});

describe("VolatilityForecaster", () => {
  it.each(["ewma", "har", "garch"])("%s gives no forecast until it has a horizon of history", (model) => {
    const forecaster = new VolatilityForecaster(manifest, model);
    const bars = walk(HORIZON, 0.001);
    bars.slice(0, -1).forEach((b) => forecaster.push(b));
    expect(forecaster.forecast()).toBeNull();
    forecaster.push(bars.at(-1)!);
    expect(forecaster.forecast()?.model).toBe(model);
  });

  it.each(["ewma", "har"])("%s recovers the volatility of a random walk", (model) => {
    // 0.1% a minute is sqrt(15) * 0.1% = 0.39% over 15 minutes.
    const forecaster = new VolatilityForecaster(manifest, model);
    for (const bar of walk(600, 0.001)) forecaster.push(bar);
    const sigma = forecaster.forecast()!.sigma;
    expect(sigma).toBeGreaterThan(0.0039 * 0.7);
    expect(sigma).toBeLessThan(0.0039 * 1.5);
  });

  it("forecasts higher volatility after a volatile hour than after a calm one", () => {
    const calm = new VolatilityForecaster(manifest);
    const wild = new VolatilityForecaster(manifest);
    const base = walk(240, 0.0005);
    for (const bar of base) {
      calm.push(bar);
      wild.push(bar);
    }
    for (const bar of walk(60, 0.0005, 2, base.at(-1)!.close)) calm.push(bar);
    for (const bar of walk(60, 0.004, 2, base.at(-1)!.close)) wild.push(bar);
    expect(wild.forecast()!.sigma).toBeGreaterThan(3 * calm.forecast()!.sigma);
  });

  it("only looks backwards: a forecast does not depend on bars after it", () => {
    const bars = walk(400, 0.001);
    const a = new VolatilityForecaster(manifest, "har");
    const b = new VolatilityForecaster(manifest, "har");
    bars.slice(0, 300).forEach((bar) => a.push(bar));
    bars.forEach((bar, i) => {
      b.push(bar);
      if (i === 299) expect(b.logForecast()).toBe(a.logForecast());
    });
  });

  it("refuses a model that cannot run live", () => {
    expect(() => new VolatilityForecaster(manifest, "lstm")).toThrow(/cannot run live/);
  });
});

describe("VolatilityMonitor", () => {
  it("updates a symbol's forecast as its minutes close", () => {
    const monitor = new VolatilityMonitor(manifest, ["A", "B"]);
    let price = 100;
    for (let m = 0; m < HORIZON; m++) {
      price *= m % 2 === 0 ? 1.002 : 0.999;
      monitor.trade("A", price, m * MINUTE + 1);
    }
    expect(monitor.forecast("A")).toBeNull(); // the 15th minute is still open
    expect(monitor.roll(HORIZON * MINUTE)).toEqual(["A"]);
    expect(monitor.forecast("A")!.sigma).toBeGreaterThan(0);
    expect(monitor.forecast("B")).toBeNull();
    expect(monitor.forecast("unknown")).toBeNull();
  });
});
