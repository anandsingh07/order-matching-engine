import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FeatureWindow, FLOOR, HORIZON, type Bar } from "./features.js";

/** The forecasters that run live; all three are a few lines of arithmetic per minute. */
export const LIVE_MODELS = ["ewma", "har", "garch"] as const;
export type LiveModel = (typeof LIVE_MODELS)[number];

/** What services/ai/volatility/train.py writes to models/volatility.json. */
export interface VolatilityManifest {
  version: number;
  trained_at: string;
  data: { symbol: string; minutes: number; from: string; to: string; split: string };
  horizon_minutes: number;
  chosen: string;
  best_in_walk_forward: string;
  chosen_by: string;
  /** The model the gateway runs: `chosen` if it can run live, otherwise the best one that can. */
  live_model: string;
  live_model_note: string;
  models: {
    har: { intercept: number; coefficients: number[] };
    ewma: { lambda: number };
    garch: { omega: number; alpha: number; beta: number; scale: number };
  };
  results: Record<string, { walk_forward_qlike: number; p_worse_than_best: number; test: { qlike: number; rmse_log_vol: number; r2_log_vol: number } }>;
}

export const DEFAULT_MANIFEST = fileURLToPath(new URL("../models/volatility.json", import.meta.url));

export function loadManifest(path = DEFAULT_MANIFEST): VolatilityManifest {
  return JSON.parse(readFileSync(path, "utf8")) as VolatilityManifest;
}

export interface Forecast {
  model: LiveModel;
  horizonMinutes: number;
  /** Forecast standard deviation of the log return over the horizon: 0.004 means a typical move of 0.4%. */
  sigma: number;
  /** Bars the forecast is based on. */
  bars: number;
}

/**
 * Forecasts volatility over the next 15 minutes from 1-minute bars, one bar
 * at a time, with no look-ahead: the exact computation the Python training
 * run evaluated (test/parity.test.ts holds them to the same numbers).
 */
export class VolatilityForecaster {
  readonly model: LiveModel;
  private readonly window = new FeatureWindow();
  private ewmaVariance = 0;
  private garchVariance: number;

  constructor(
    private readonly manifest: VolatilityManifest,
    model: string = manifest.live_model,
  ) {
    if (!(LIVE_MODELS as readonly string[]).includes(model)) {
      throw new Error(`model "${model}" cannot run live; choose one of ${LIVE_MODELS.join(", ")}`);
    }
    this.model = model as LiveModel;
    const { omega, alpha, beta } = manifest.models.garch;
    this.garchVariance = omega / (1 - alpha - beta);
  }

  push(bar: Bar): void {
    this.window.push(bar);
    const r = this.window.lastReturn;
    const i = this.window.size - 1; // index of this bar; bar 0 has no return
    if (i >= 1) {
      // A running mean until there are enough returns for the exponential weights.
      const w = Math.max(1 - this.manifest.models.ewma.lambda, 1 / i);
      this.ewmaVariance = (1 - w) * this.ewmaVariance + w * r * r;
    }
    const { omega, alpha, beta, scale } = this.manifest.models.garch;
    const x = r * scale;
    this.garchVariance = omega + alpha * x * x + beta * this.garchVariance;
  }

  get bars(): number {
    return this.window.size;
  }

  /** ln of the forecast volatility, as the training run computes it. */
  logForecast(): number {
    switch (this.model) {
      case "ewma":
        return Math.log(Math.max(Math.sqrt(HORIZON * this.ewmaVariance), FLOOR));
      case "har": {
        const { intercept, coefficients } = this.manifest.models.har;
        return this.window.features().reduce((sum, f, j) => sum + f * coefficients[j]!, intercept);
      }
      case "garch": {
        // The sum of the next 15 one-minute variances, which revert geometrically to the long-run level.
        const { omega, alpha, beta, scale } = this.manifest.models.garch;
        const persistence = alpha + beta;
        const longRun = omega / (1 - persistence);
        const total = HORIZON * longRun + ((this.garchVariance - longRun) * (1 - persistence ** HORIZON)) / (1 - persistence);
        return Math.log(Math.sqrt(Math.max(total, 1e-12)) / scale);
      }
    }
  }

  /** The forecast, or null until there is a horizon's worth of history. */
  forecast(): Forecast | null {
    if (this.window.size < HORIZON) return null;
    return { model: this.model, horizonMinutes: HORIZON, sigma: Math.exp(this.logForecast()), bars: this.window.size };
  }
}
