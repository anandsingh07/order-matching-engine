import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import { FEATURE_NAMES, type FeatureName } from "./features.js";

/** Alert thresholds: flag when suspicion >= classifier, or normality < anomaly. */
export interface Thresholds {
  classifier: number;
  anomaly: number;
}

/** What the training pipeline writes next to the ONNX files (services/ai/surveillance/train.py). */
export interface Manifest {
  version: number;
  trained_at: string;
  features: string[];
  labels: string[];
  thresholds: Thresholds;
  baseline: Record<string, { median: number; iqr: number }>;
  feature_importance: Record<string, number>;
  metrics: Record<string, unknown>;
}

export interface Reason {
  feature: FeatureName;
  value: number;
  /** The honest median. */
  typical: number;
  /** How unusual, in robust standard deviations from honest behaviour. */
  deviation: number;
  text: string;
}

export interface Assessment {
  /** The classifier's most likely class. */
  label: string;
  /** 1 - P(honest): how likely the window is manipulation of a known kind. */
  suspicion: number;
  probabilities: Record<string, number>;
  /** Log-likelihood under the honest density model; lower is more unusual. */
  normality: number;
  flagged: boolean;
  flaggedBy: ("classifier" | "anomaly")[];
  /** The features furthest from honest behaviour, most unusual first. */
  reasons: Reason[];
}

export const DEFAULT_MODEL_DIR = fileURLToPath(new URL("../models/", import.meta.url));

const pct = (v: number) => `${Math.round(v * 100)}%`;
const fromLog = (v: number, offset = 1) => 10 ** v - offset;
const duration = (ms: number) => (ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`);

/** Each feature in words, with the value and the honest median for comparison. */
const DESCRIBE: Record<FeatureName, (v: number, typical: number) => string> = {
  log_orders_per_min: (v, t) => `${fromLog(v).toFixed(0)} orders a minute (typical ${fromLog(t).toFixed(0)})`,
  cancel_ratio: (v, t) => `cancels ${pct(v)} of orders (typical ${pct(t)})`,
  log_order_to_trade: (v, t) => `${fromLog(v, 0.01).toFixed(1)} orders per trade (typical ${fromLog(t, 0.01).toFixed(1)})`,
  log_median_lifetime_ms: (v, t) => `cancelled orders live ${duration(fromLog(v))} (typical ${duration(fromLog(t))})`,
  fill_ratio: (v, t) => `${pct(v)} of order size gets filled (typical ${pct(t)})`,
  log_size_vs_touch: (v, t) => `orders ${fromLog(v).toFixed(1)}x the size at the best price (typical ${fromLog(t).toFixed(1)}x)`,
  mean_distance_bps: (v, t) => `orders sit ${v.toFixed(1)} bps behind the best price (typical ${t.toFixed(1)})`,
  cancel_after_opposite_fill: (v, t) => `${pct(v)} of cancels follow a fill on the other side (typical ${pct(t)})`,
  log_trades: (v, t) => `${fromLog(v).toFixed(0)} trades in the window (typical ${fromLog(t).toFixed(0)})`,
  excess_concentration: (v, t) =>
    `trades concentrated on few counterparties, ${v.toFixed(2)} above an even spread across this market (typical ${t.toFixed(2)})`,
  excess_partner_exclusivity: (v, t) =>
    `its main counterparty traded with it ${pct(v)} more than an even share of this market (typical ${pct(t)})`,
  two_way_counterparty_share: (v, t) => `${pct(v)} of volume traded both ways with the same counterparty (typical ${pct(t)})`,
  net_to_gross: (v, t) => `net position change is ${pct(v)} of volume traded (typical ${pct(t)})`,
  taker_share: (v, t) => `${pct(v)} of volume taken aggressively (typical ${pct(t)})`,
  resting_side_imbalance: (v, t) => `${pct(v)} of resting size on one side (typical ${pct(t)})`,
  max_levels_one_side: (v, t) => `orders stacked on ${v} price levels on one side (typical ${t})`,
};

/**
 * The trained surveillance models, run with onnxruntime inside Node: a
 * classifier for known manipulation patterns and a density model of honest
 * behaviour for anything unusual. A window is flagged if either crosses its
 * threshold, which training calibrated on held-out markets.
 */
export class SurveillanceModel {
  private constructor(
    readonly manifest: Manifest,
    private readonly classifier: ort.InferenceSession,
    private readonly density: ort.InferenceSession,
  ) {}

  static async load(dir = DEFAULT_MODEL_DIR): Promise<SurveillanceModel> {
    const manifest = JSON.parse(readFileSync(`${dir}/model.json`, "utf8")) as Manifest;
    // Features are a contract between the TypeScript extractor and the trained model.
    if (manifest.features.join(",") !== FEATURE_NAMES.join(",")) {
      throw new Error(`model expects features [${manifest.features.join(", ")}] but the extractor produces [${FEATURE_NAMES.join(", ")}]; retrain the model`);
    }
    const [classifier, density] = await Promise.all([
      ort.InferenceSession.create(`${dir}/classifier.onnx`),
      ort.InferenceSession.create(`${dir}/anomaly.onnx`),
    ]);
    return new SurveillanceModel(manifest, classifier, density);
  }

  /** The thresholds training calibrated on held-out simulated markets. */
  get thresholds(): Thresholds {
    return this.manifest.thresholds;
  }

  /** Scores many windows at once, against the trained thresholds or per-row ones (say, calibrated for a market). */
  async assess(rows: number[][], thresholds: (row: number) => Thresholds = () => this.manifest.thresholds): Promise<Assessment[]> {
    if (rows.length === 0) return [];
    const width = FEATURE_NAMES.length;
    const input = new ort.Tensor("float32", Float32Array.from(rows.flat()), [rows.length, width]);
    const [clf, dens] = await Promise.all([
      this.classifier.run({ features: input }, ["probabilities"]),
      this.density.run({ features: input }, ["score_samples"]),
    ]);
    const probabilities = clf.probabilities!.data as Float32Array;
    const scores = dens.score_samples!.data as Float32Array;
    const labels = this.manifest.labels;

    return rows.map((row, i) => {
      const { classifier: suspicionThreshold, anomaly: normalityThreshold } = thresholds(i);
      const p = Array.from(probabilities.subarray(i * labels.length, (i + 1) * labels.length));
      const best = p.indexOf(Math.max(...p));
      const suspicion = 1 - p[0]!;
      const normality = scores[i]!;
      const flaggedBy: Assessment["flaggedBy"] = [];
      if (suspicion >= suspicionThreshold) flaggedBy.push("classifier");
      if (normality < normalityThreshold) flaggedBy.push("anomaly");
      return {
        label: labels[best]!,
        suspicion,
        probabilities: Object.fromEntries(labels.map((l, k) => [l, p[k]!])),
        normality,
        flagged: flaggedBy.length > 0,
        flaggedBy,
        reasons: this.explain(row),
      };
    });
  }

  /**
   * The three features furthest from honest behaviour, measured in robust
   * standard deviations (distance from the honest median over IQR / 1.349).
   */
  explain(row: number[], count = 3): Reason[] {
    return FEATURE_NAMES.map((feature, i) => {
      const { median, iqr } = this.manifest.baseline[feature]!;
      const value = row[i]!;
      const scale = Math.max(iqr / 1.349, 0.05 * Math.abs(median), 1e-3);
      return { feature, value, typical: median, deviation: (value - median) / scale, text: DESCRIBE[feature](value, median) };
    })
      .sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
      .slice(0, count);
  }
}
