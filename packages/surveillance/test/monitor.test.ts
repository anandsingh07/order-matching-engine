import { describe, expect, it } from "vitest";
import { DEFAULT_SHADOW, SurveillanceMonitor, type Assessment, type SurveillanceModel, type Thresholds } from "../src/index.js";

const TRAINED: Thresholds = { classifier: 0.7, anomaly: -12 };

/** A stand-in model that gives every window the next of the given scores and applies the thresholds it is handed. */
function stubModel(scores: () => { suspicion: number; normality: number }): SurveillanceModel {
  return {
    thresholds: TRAINED,
    async assess(rows: number[][], thresholds: (row: number) => Thresholds = () => TRAINED): Promise<Assessment[]> {
      return rows.map((_, i) => {
        const { suspicion, normality } = scores();
        const t = thresholds(i);
        const flaggedBy: Assessment["flaggedBy"] = [];
        if (suspicion >= t.classifier) flaggedBy.push("classifier");
        if (normality < t.anomaly) flaggedBy.push("anomaly");
        return { label: "honest", suspicion, probabilities: {}, normality, flagged: flaggedBy.length > 0, flaggedBy, reasons: [] };
      });
    },
  } as unknown as SurveillanceModel;
}

/** One trader active on each symbol at time `now`. */
function activity(monitor: SurveillanceMonitor, now: number, symbols: string[]): void {
  symbols.forEach((symbol, i) => monitor.order(`t${i}`, symbol, `${symbol}:${now}`, now, "buy", 100, 1, { bids: [], asks: [] }));
}

describe("shadow mode", () => {
  it("scores without alerting, then calibrates each symbol to its honest traffic", async () => {
    let n = 0;
    // INFY's honest traders look somewhat suspicious and unusual; the scores climb from 0.50 to 0.89 and fall from -10 to -49.
    const monitor = new SurveillanceMonitor(stubModel(() => ({ suspicion: 0.5 + (n % 40) / 100, normality: -10 - (n++ % 40) })), undefined, { ...DEFAULT_SHADOW, falsePositiveRate: 0.05 });
    monitor.startShadow();
    expect(monitor.mode).toBe("shadow");
    for (let s = 0; s < 40; s++) {
      activity(monitor, s * 1_000, ["INFY"]);
      expect(await monitor.scan(s * 1_000)).toEqual([]); // flagged windows, but no alerts
    }
    expect(monitor.history()).toEqual([]);

    const [infy] = monitor.finishShadow();
    expect(monitor.mode).toBe("live");
    expect(infy!.windows).toBe(40);
    // 95% of the honest windows would now pass the classifier: just above suspicion 0.87.
    expect(infy!.thresholds.classifier).toBeCloseTo(0.87, 4);
    // The anomaly side would go to -48, past the cap, so the cap binds.
    expect(infy!.thresholds.anomaly).toBe(-12 - 30);
  });

  it("never tightens, and caps how far it loosens", async () => {
    let n = 0;
    // TCS looks squeaky clean; BTC's honest traffic looks extremely suspicious.
    const scores = [
      { suspicion: 0.01, normality: 5 },
      { suspicion: 0.999, normality: -500 },
    ];
    const monitor = new SurveillanceMonitor(stubModel(() => scores[n++ % 2]!));
    monitor.startShadow();
    for (let s = 0; s < 40; s++) {
      activity(monitor, s * 1_000, ["TCS", "BTC"]);
      await monitor.scan(s * 1_000);
    }
    const calibration = new Map(monitor.finishShadow().map((c) => [c.symbol, c.thresholds]));
    expect(calibration.get("TCS")).toEqual(TRAINED); // clean traffic does not make it stricter
    expect(calibration.get("BTC")).toEqual({ classifier: DEFAULT_SHADOW.maxClassifier, anomaly: TRAINED.anomaly - DEFAULT_SHADOW.maxAnomalyShift });

    // Live: the same extreme window on BTC still alerts, because the caps hold.
    n = 1;
    activity(monitor, 100_000, ["BTC"]); // the shadow-period traders have gone quiet by now
    const alerts = await monitor.scan(100_000);
    expect(alerts.map((a) => a.symbol)).toEqual(["BTC"]);
  });

  it("leaves a symbol with too little traffic on the trained thresholds", async () => {
    const monitor = new SurveillanceMonitor(stubModel(() => ({ suspicion: 0.9, normality: -30 })));
    monitor.startShadow();
    for (let s = 0; s < DEFAULT_SHADOW.minWindows - 1; s++) {
      activity(monitor, s * 1_000, ["SBIN"]);
      await monitor.scan(s * 1_000);
    }
    expect(monitor.finishShadow()).toEqual([]);
  });
});
