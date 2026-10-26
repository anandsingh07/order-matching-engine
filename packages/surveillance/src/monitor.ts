import type { Depth, Side } from "@ome/core";
import { describeOrder, marketContext, TraderActivity } from "./features.js";
import type { Assessment, SurveillanceModel, Thresholds } from "./model.js";

/** Per-symbol thresholds learned from known-honest live traffic, and how much traffic they rest on. */
export interface Calibration {
  symbol: string;
  windows: number;
  thresholds: Thresholds;
}

export interface ShadowOptions {
  /** Share of honest windows allowed to alert after calibration. */
  falsePositiveRate: number;
  /** Below this many scored windows a symbol keeps the trained thresholds. */
  minWindows: number;
  /** Calibration never raises the classifier threshold above this... */
  maxClassifier: number;
  /** ...nor lowers the anomaly threshold by more than this (log-likelihood). */
  maxAnomalyShift: number;
}

/**
 * The caps are measured, not guessed: on the held-out simulated markets, a
 * classifier threshold of 0.95 still catches 94.7% of known manipulation
 * (97.3% at the trained 0.73), and an anomaly threshold 30 lower still
 * catches 95.5% of the never-trained quote stuffing (99.7%); past that,
 * detection of the unknown falls quickly (31% at 120 lower).
 */
export const DEFAULT_SHADOW: ShadowOptions = { falsePositiveRate: 0.01, minWindows: 30, maxClassifier: 0.95, maxAnomalyShift: 30 };

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

export interface Alert {
  traderId: string;
  symbol: string;
  time: number;
  assessment: Assessment;
}

interface Tracked {
  traderId: string;
  symbol: string;
  activity: TraderActivity;
}

/**
 * Live surveillance: the same per-trader feature windows as the simulator,
 * fed from the gateway's order flow and scored periodically by the model.
 * Keeps the latest assessment of every active trader and a log of alerts.
 *
 * Shadow mode is how a new market goes live. The model's thresholds were
 * calibrated on simulated markets, and a real one can differ (a thin book
 * makes an honest market maker look unusual). In shadow mode everything is
 * scored but nothing alerts, and the scores are kept per symbol. Finishing
 * the shadow period sets each symbol's thresholds so that only
 * `falsePositiveRate` of that traffic would have alerted. That assumes the
 * shadow traffic is honest, so calibration is bounded: it only ever loosens
 * the trained thresholds, never by more than the caps, and a symbol with
 * little traffic keeps the trained ones.
 */
export class SurveillanceMonitor {
  private readonly tracked = new Map<string, Tracked>();
  /** Engine order id -> remaining quantity, to know when a resting order is gone. */
  private readonly remaining = new Map<string, { key: string; quantity: number }>();
  private readonly latest = new Map<string, Alert>();
  private readonly log: Alert[] = [];
  /** Scores seen per symbol during shadow mode; null when not in shadow mode. */
  private shadowScores: Map<string, { suspicion: number[]; normality: number[] }> | null = null;
  private readonly calibrated = new Map<string, Calibration>();

  constructor(
    private readonly model: SurveillanceModel,
    private readonly options: { windowMs: number; maxAlerts: number } = { windowMs: 30_000, maxAlerts: 500 },
    private readonly shadow: ShadowOptions = DEFAULT_SHADOW,
  ) {}

  get mode(): "shadow" | "live" {
    return this.shadowScores === null ? "live" : "shadow";
  }

  /** Starts a shadow period: score everything, alert on nothing, keep the scores. */
  startShadow(): void {
    this.shadowScores = new Map();
  }

  /** Ends the shadow period, calibrates each symbol from its traffic, and goes live. */
  finishShadow(): Calibration[] {
    const scores = this.shadowScores ?? new Map();
    this.shadowScores = null;
    const trained = this.model.thresholds;
    const s = this.shadow;
    for (const [symbol, { suspicion, normality }] of scores) {
      if (suspicion.length < s.minWindows) continue;
      const thresholds = {
        // Just above the honest traffic's top (1 - rate) quantile, but never stricter than trained, nor past the cap.
        classifier: Math.min(s.maxClassifier, Math.max(trained.classifier, quantile(suspicion, 1 - s.falsePositiveRate) + 1e-6)),
        anomaly: Math.max(trained.anomaly - s.maxAnomalyShift, Math.min(trained.anomaly, quantile(normality, s.falsePositiveRate))),
      };
      this.calibrated.set(symbol, { symbol, windows: suspicion.length, thresholds });
    }
    return this.calibration();
  }

  /** Per-symbol thresholds in force (symbols not listed use the trained ones). */
  calibration(): Calibration[] {
    return [...this.calibrated.values()];
  }

  private thresholdsFor(symbol: string): Thresholds {
    return this.calibrated.get(symbol)?.thresholds ?? this.model.thresholds;
  }

  /** An order as it arrives, with the book (top levels) as it stood just before. */
  order(traderId: string, symbol: string, orderId: string, time: number, side: Side, price: number | null, quantity: number, book: Depth): void {
    this.track(traderId, symbol).activity.record(describeOrder(book, orderId, time, side, price, quantity));
    // Track every limit order from arrival, so one that fills completely
    // without ever resting still stops counting as live.
    if (price !== null) this.remaining.set(orderId, { key: this.key(traderId, symbol), quantity });
  }

  /** An order resting on the book with this much left (also after an amend sends it to the back). */
  rested(traderId: string, symbol: string, orderId: string, quantity: number): void {
    this.remaining.set(orderId, { key: this.key(traderId, symbol), quantity });
  }

  /** A deliberate cancel by the trader. */
  cancelled(traderId: string, symbol: string, orderId: string, time: number): void {
    this.track(traderId, symbol).activity.record({ kind: "cancel", time, orderId });
    this.remaining.delete(orderId);
  }

  /** An order that left the book for another reason (IOC remainder, self-trade prevention...). */
  removed(orderId: string): void {
    const r = this.remaining.get(orderId);
    if (r === undefined) return;
    this.tracked.get(r.key)?.activity.closed(orderId);
    this.remaining.delete(orderId);
  }

  fill(traderId: string, symbol: string, orderId: string, time: number, side: Side, quantity: number, liquidity: "maker" | "taker", counterpartyId: string): void {
    this.track(traderId, symbol).activity.record({ kind: "fill", time, orderId, side, quantity, liquidity, counterpartyId });
    const r = this.remaining.get(orderId);
    if (r !== undefined && (r.quantity -= quantity) <= 0) this.removed(orderId);
  }

  /** Scores every trader active in the window ending at `now`; returns the new alerts. */
  async scan(now: number): Promise<Alert[]> {
    const active = [...this.tracked.entries()].filter(([, t]) => t.activity.activeAt(now));
    for (const [key, t] of this.tracked) if (!t.activity.activeAt(now)) this.tracked.delete(key);
    const bySymbol = new Map<string, [string, TraderActivity][]>();
    for (const [, t] of active) {
      const list = bySymbol.get(t.symbol) ?? [];
      list.push([t.traderId, t.activity]);
      bySymbol.set(t.symbol, list);
    }
    const markets = new Map([...bySymbol].map(([symbol, list]) => [symbol, marketContext(now, list)]));
    const assessments = await this.model.assess(
      active.map(([, t]) => t.activity.features(now, markets.get(t.symbol)!)),
      (i) => this.thresholdsFor(active[i]![1].symbol),
    );
    const alerts: Alert[] = [];
    const shadow = this.shadowScores;
    active.forEach(([key, t], i) => {
      const alert: Alert = { traderId: t.traderId, symbol: t.symbol, time: now, assessment: assessments[i]! };
      this.latest.set(key, alert);
      if (shadow !== null) {
        const s = shadow.get(t.symbol) ?? { suspicion: [], normality: [] };
        s.suspicion.push(alert.assessment.suspicion);
        s.normality.push(alert.assessment.normality);
        shadow.set(t.symbol, s);
      } else if (alert.assessment.flagged) {
        alerts.push(alert);
      }
    });
    this.log.push(...alerts);
    if (this.log.length > this.options.maxAlerts) this.log.splice(0, this.log.length - this.options.maxAlerts);
    return alerts;
  }

  /** The latest assessment of every recently active trader, most suspicious first. */
  current(): Alert[] {
    return [...this.latest.values()].sort((a, b) => Number(b.assessment.flagged) - Number(a.assessment.flagged) || b.assessment.suspicion - a.assessment.suspicion);
  }

  /** Alerts so far, newest first. */
  history(): Alert[] {
    return [...this.log].reverse();
  }

  private key(traderId: string, symbol: string): string {
    return `${traderId}|${symbol}`;
  }

  private track(traderId: string, symbol: string): Tracked {
    const key = this.key(traderId, symbol);
    let t = this.tracked.get(key);
    if (t === undefined) this.tracked.set(key, (t = { traderId, symbol, activity: new TraderActivity(this.options.windowMs) }));
    return t;
  }
}
