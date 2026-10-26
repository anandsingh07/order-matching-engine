import { TradingClient, type Instrument } from "@ome/client";
import { Exchange } from "@ome/exchange";
import { DEFAULT_INSTRUMENTS, Gateway } from "@ome/gateway";
import {
  InvestorAgent,
  LayeringAgent,
  MarketMakerAgent,
  NoiseAgent,
  SpooferAgent,
  SurveillanceModel,
  WashTraderAgent,
  type Agent,
  type Calibration,
} from "@ome/surveillance";
import { describe, expect, it } from "vitest";
import { LiveMarket, MarketMaker, NoiseTrader, prng } from "../src/index.js";

interface Assessed {
  traderName: string;
  assessment: { flagged: boolean; label: string; suspicion: number; flaggedBy: string[]; reasons: { text: string }[] };
}
interface Report {
  mode: "shadow" | "live";
  calibration: Calibration[];
  model: { thresholds: { classifier: number; anomaly: number } };
  current: Assessed[];
  alerts: Assessed[];
}

const MANIPULATORS = ["spoofer", "layerer", "wash-a", "wash-b"];
const HONEST = ["bot-mm", "bot-noise", "sim-mm", "sim-noise-1", "sim-noise-2", "sim-investor"];
const infy = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "INFY") as Instrument;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A gateway with surveillance, and helpers to put honest traders and manipulators on INFY. */
async function market() {
  const exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
  const model = await SurveillanceModel.load();
  const gateway = await Gateway.create({ exchange, bookIntervalMs: 20, botKey: "k", surveillance: { model, adminKey: "admin", scanIntervalMs: 1_000 } });
  const url = await gateway.listen(0);
  const stoppers: (() => void | Promise<void>)[] = [];

  async function agents(list: Agent[], seed: number): Promise<void> {
    const clients = new Map<string, TradingClient>();
    for (const a of list) clients.set(a.id, await TradingClient.connect(url, a.id, { botKey: "k" }));
    const live = new LiveMarket(infy, list, clients, prng(seed));
    live.start();
    stoppers.push(() => {
      live.stop();
      for (const c of clients.values()) c.close();
    });
  }

  return {
    url,
    report: async () => (await (await fetch(`${url}/api/surveillance?key=admin`)).json()) as Report,
    /** The live rule-based market maker and noise bot, plus the simulator's honest agents. */
    async honest(): Promise<void> {
      const mmClient = await TradingClient.connect(url, "bot-mm", { botKey: "k" });
      const maker = new MarketMaker(mmClient, infy, () => infy.referencePrice, { levels: 5, halfSpreadBps: 4, stepBps: 3, size: 25, maxPosition: 500, skewBps: 8 }, 250);
      maker.start();
      const noiseClient = await TradingClient.connect(url, "bot-noise", { botKey: "k" });
      const noise = new NoiseTrader(noiseClient, [infy], prng(3), { meanIntervalMs: 300, maxLots: 20, marketShare: 0.3, restMs: 4_000 });
      noise.start();
      stoppers.push(async () => {
        noise.stop();
        await maker.stop();
        mmClient.close();
        noiseClient.close();
      });
      await pause(1_000); // let the book fill first
      await agents([new MarketMakerAgent("sim-mm", 10, 2), new NoiseAgent("sim-noise-1", 800), new NoiseAgent("sim-noise-2", 1_200), new InvestorAgent("sim-investor")], 11);
    },
    async manipulators(): Promise<void> {
      await agents([new SpooferAgent("spoofer", 0.8, 2_500), new LayeringAgent("layerer", 0.8, 2_500), ...WashTraderAgent.pair("wash-a", "wash-b", 0.8, 2_500)], 12);
    },
    async close(): Promise<void> {
      for (const stop of stoppers.reverse()) await stop();
      await gateway.close();
      await exchange.stop();
    },
  };
}

function summarise(report: Report): Map<string, Assessed["assessment"]> {
  const byName = new Map(report.current.map((a) => [a.traderName, a.assessment]));
  for (const [name, a] of byName) {
    console.log(`${name.padEnd(14)} ${a.flagged ? "FLAGGED" : "ok     "} ${a.label.padEnd(14)} suspicion ${a.suspicion.toFixed(2)} by ${a.flaggedBy.join("+") || "-"} | ${a.reasons[0]?.text}`);
  }
  return byName;
}

describe("surveillance end to end", () => {
  it("catches manipulators trading over the network", async () => {
    const m = await market();
    try {
      await m.honest();
      await m.manipulators();
      await pause(25_000);
      const byName = summarise(await m.report());
      // Every manipulator is caught, trading for real over the network...
      for (const name of MANIPULATORS) expect(byName.get(name)?.flagged, name).toBe(true);
      expect(byName.get("spoofer")!.label).toBe("spoofing");
      expect(byName.get("wash-a")!.label).toBe("wash_trading");
      // Without calibration, this live market (thinner than anything
      // simulated, its market makers filled almost entirely by one aggressive
      // noise bot) makes 3-4 of the 6 honest traders look unusual; CPU load
      // from other tests running alongside moves timing, and with it one
      // trader either way. This bound records that measured gap, not a goal.
      // Shadow mode, below, is the fix.
      const falsePositives = HONEST.filter((n) => byName.get(n)?.flagged);
      expect(falsePositives.length, `honest traders flagged: ${falsePositives.join(", ")}`).toBeLessThanOrEqual(4);
    } finally {
      await m.close();
    }
  }, 60_000);

  it("shadow mode calibrates on honest traffic, then still catches manipulators with fewer false alarms", async () => {
    const m = await market();
    try {
      expect(await (await fetch(`${m.url}/api/surveillance/shadow?action=start&key=admin`, { method: "POST" })).json()).toEqual({ mode: "shadow" });
      await m.honest();
      await pause(20_000);
      const during = await m.report();
      expect(during.mode).toBe("shadow");
      expect(during.alerts).toEqual([]); // scored, but nothing alerts

      const finished = (await (await fetch(`${m.url}/api/surveillance/shadow?action=finish&key=admin`, { method: "POST" })).json()) as { mode: string; calibration: Calibration[] };
      expect(finished.mode).toBe("live");
      const infyCalibration = finished.calibration.find((c) => c.symbol === "INFY");
      expect(infyCalibration?.windows).toBeGreaterThanOrEqual(30);
      const trained = during.model.thresholds;
      console.log(`INFY calibrated on ${infyCalibration!.windows} windows: classifier ${trained.classifier.toFixed(3)} -> ${infyCalibration!.thresholds.classifier.toFixed(3)}, anomaly ${trained.anomaly.toFixed(1)} -> ${infyCalibration!.thresholds.anomaly.toFixed(1)}`);
      // Calibration only loosens, and within its caps.
      expect(infyCalibration!.thresholds.classifier).toBeGreaterThanOrEqual(trained.classifier);
      expect(infyCalibration!.thresholds.anomaly).toBeLessThanOrEqual(trained.anomaly);

      await m.manipulators();
      await pause(25_000);
      const byName = summarise(await m.report());
      for (const name of MANIPULATORS) expect(byName.get(name)?.flagged, name).toBe(true);
      const falsePositives = HONEST.filter((n) => byName.get(n)?.flagged);
      expect(falsePositives.length, `honest traders flagged: ${falsePositives.join(", ")}`).toBeLessThanOrEqual(1);
    } finally {
      await m.close();
    }
  }, 90_000);
});
