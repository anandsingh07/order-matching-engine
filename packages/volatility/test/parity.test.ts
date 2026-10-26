import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FeatureWindow, LIVE_MODELS, loadManifest, VolatilityForecaster, type Bar } from "../src/index.js";

// Written by services/ai/volatility/train.py: real BTC/USDT bars, with the
// features and forecasts Python computed from them. If either side changes a
// definition without the other, these numbers stop matching.
interface Golden {
  bars: Bar[];
  rows: number[];
  features: number[][];
  predictions: Record<string, number[]>;
}
const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8")) as Golden;
const manifest = loadManifest();

describe("parity with the Python training pipeline", () => {
  it("computes the same features", () => {
    const window = new FeatureWindow();
    const rows = new Set(golden.rows);
    const seen: number[][] = [];
    golden.bars.forEach((bar, i) => {
      window.push(bar);
      if (rows.has(i)) seen.push(window.features());
    });
    expect(seen.length).toBe(golden.features.length);
    seen.forEach((row, r) => row.forEach((v, j) => expect(v).toBeCloseTo(golden.features[r]![j]!, 9)));
  });

  it.each(LIVE_MODELS)("forecasts the same with %s", (model) => {
    const forecaster = new VolatilityForecaster(manifest, model);
    const expected = golden.predictions[model]!;
    const got: number[] = [];
    const rows = new Set(golden.rows);
    golden.bars.forEach((bar, i) => {
      forecaster.push(bar);
      if (rows.has(i)) got.push(forecaster.logForecast());
    });
    got.forEach((v, r) => expect(v).toBeCloseTo(expected[r]!, 9));
  });

  it("runs the model the training run picked for live use", () => {
    expect(LIVE_MODELS).toContain(manifest.live_model);
    expect(new VolatilityForecaster(manifest).model).toBe(manifest.live_model);
  });
});
