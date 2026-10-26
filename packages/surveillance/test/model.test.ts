import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MODEL_DIR, FEATURE_NAMES, SurveillanceModel, SurveillanceMonitor, collectSamples, type Sample } from "../src/index.js";

let model: SurveillanceModel;
let samples: Sample[];

beforeAll(async () => {
  model = await SurveillanceModel.load();
  // Markets the model never saw (training used seeds below 150), each with
  // every kind of manipulator so all of them are measured.
  samples = [1_001, 1_002, 1_003, 1_004, 1_005, 1_006].flatMap((seed) => collectSamples(seed, 6 * 60_000, { everyManipulator: true }));
});

describe("SurveillanceModel (ONNX in Node)", () => {
  it("catches manipulators in unseen markets while rarely flagging honest traders", async () => {
    const assessments = await model.assess(samples.map((s) => s.features));
    const rate = (pick: (s: Sample) => boolean) => {
      const idx = samples.map((s, i) => (pick(s) ? i : -1)).filter((i) => i >= 0);
      return idx.filter((i) => assessments[i]!.flagged).length / idx.length;
    };
    // Six markets is a small sample; the authoritative numbers (24 held-out
    // markets) are in models/model.json. These bounds catch a broken model.
    expect(rate((s) => s.label === "honest")).toBeLessThan(0.05);
    expect(rate((s) => s.label !== "honest" && s.label !== "quote_stuffing")).toBeGreaterThan(0.8);
    expect(rate((s) => s.label === "quote_stuffing")).toBeGreaterThan(0.85); // never shown to the classifier
  });

  it("names the known pattern it flags and explains each flag in words", async () => {
    const spoofing = samples.filter((s) => s.label === "spoofing");
    const flagged = (await model.assess(spoofing.map((s) => s.features))).filter((a) => a.flaggedBy.includes("classifier"));
    expect(flagged.length).toBeGreaterThan(spoofing.length / 2);
    // When the classifier flags a spoofer, it says "spoofing" (not some other pattern)...
    expect(flagged.filter((a) => a.label === "spoofing").length / flagged.length).toBeGreaterThan(0.8);
    // ...and says why, against honest behaviour.
    expect(flagged[0]!.reasons).toHaveLength(3);
    expect(flagged[0]!.reasons[0]!.text).toMatch(/typical/);
  });

  it("refuses a model trained on different features", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ome-model-"));
    try {
      for (const f of ["classifier.onnx", "anomaly.onnx"]) copyFileSync(join(DEFAULT_MODEL_DIR, f), join(dir, f));
      const manifest = JSON.parse(readFileSync(join(DEFAULT_MODEL_DIR, "model.json"), "utf8"));
      manifest.features = [...FEATURE_NAMES].reverse();
      writeFileSync(join(dir, "model.json"), JSON.stringify(manifest));
      await expect(SurveillanceModel.load(dir)).rejects.toThrow(/retrain/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SurveillanceMonitor", () => {
  it("flags a layering trader from live-style events and leaves a quiet trader alone", async () => {
    const monitor = new SurveillanceMonitor(model);
    const touch = {
      bids: [10_000, 9_999, 9_998].map((price) => ({ price, quantity: 20, orders: 2 })),
      asks: [10_002, 10_003, 10_004].map((price) => ({ price, quantity: 20, orders: 2 })),
    };
    let id = 0;
    for (let t = 0; t < 30_000; t += 3_000) {
      // The layerer: six levels on one side, a trade on the other, then pull the ladder.
      const ladder = Array.from({ length: 6 }, (_, i) => `L${id++}`);
      ladder.forEach((oid, i) => monitor.order("layer", "TCS", oid, t, "buy", 10_000 - 1 - i, 40, touch));
      monitor.fill("layer", "TCS", `S${id}`, t + 100, "sell", 10, "taker", "mm");
      ladder.forEach((oid) => monitor.cancelled("layer", "TCS", oid, t + 600));
      // A quiet investor: one order now and then, left alone.
      if (t % 15_000 === 0) monitor.order("calm", "TCS", `C${id++}`, t, "sell", 10_002, 5, touch);
    }
    await monitor.scan(30_000);
    const current = Object.fromEntries(monitor.current().map((a) => [a.traderId, a.assessment]));
    expect(current.layer!.flagged).toBe(true);
    expect(current.calm!.flagged).toBe(false);
    expect(monitor.history().map((a) => a.traderId)).toContain("layer");
  });
});
