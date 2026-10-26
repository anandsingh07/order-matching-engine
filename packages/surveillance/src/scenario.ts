import {
  InvestorAgent,
  LadderMarketMakerAgent,
  LayeringAgent,
  MarketMakerAgent,
  MomentumAgent,
  NoiseAgent,
  PumpAndDumpAgent,
  QuoteStufferAgent,
  SpooferAgent,
  WashTraderAgent,
} from "./agents.js";
import { FEATURE_NAMES, marketContext } from "./features.js";
import { Simulation, type Agent, type Label } from "./simulator.js";

/**
 * A market with an honest majority (market makers, retail noise, momentum
 * traders, large investors) and one of each kind of manipulator.
 *
 * Market structure is randomised per seed (domain randomisation): thin
 * markets with one market maker and a few retail traders, deep ones with
 * several, two styles of market maker, varied activity. A model trained on
 * one kind of market flagged most honest traders in a thinner live market; it
 * has to learn what honest looks like across market conditions.
 */
export interface ScenarioOptions {
  /** Include manipulators at all. Defaults to true. */
  manipulators?: boolean;
  /** Include every kind of manipulator instead of a random subset (for evaluation). */
  everyManipulator?: boolean;
}

export function marketWithManipulators(seed: number, options: ScenarioOptions = {}): Simulation {
  const sim = new Simulation({ seed, start: 9_000 + (seed % 7) * 500 });
  const r = sim.random;
  const pick = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const intensity = () => 0.1 + 0.9 * r();

  const makers = pick(1, 4);
  for (let i = 0; i < makers; i++) {
    if (r() < 0.5) {
      const fast = r() < 0.5;
      sim.add(new MarketMakerAgent(`mm${i}`, pick(5, 30), pick(1, 3), fast ? [150, 500] : [500, 1_500]));
    } else {
      // Tight ladders, and wide ones spaced several ticks apart (as when quoting in basis points on a fine tick grid).
      const wide = r() < 0.5;
      sim.add(new LadderMarketMakerAgent(`ladder${i}`, pick(5, 40), pick(3, 6), wide ? pick(4, 20) : pick(1, 4), wide ? pick(2, 12) : 1));
    }
  }
  const noiseCount = pick(2, 8);
  for (let i = 0; i < noiseCount; i++) {
    // Retail styles vary too: some sit close to the touch, others spread orders several ticks out.
    const style = {
      offsets: [-pick(0, 3), pick(2, 8)] as [number, number],
      lifetimeMs: [pick(500, 3_000), pick(4_000, 30_000)] as [number, number],
      marketShare: 0.1 + 0.5 * r(),
    };
    sim.add(new NoiseAgent(`noise${i}`, pick(150, 3_000), style));
  }
  for (let i = 0; i < pick(0, 3); i++) sim.add(new MomentumAgent(`momentum${i}`));
  for (let i = 0; i < pick(0, 3); i++) sim.add(new InvestorAgent(`investor${i}`));
  if (options.manipulators !== false) {
    // Each manipulator is present in only some markets, so the data also has
    // thin, purely honest markets, where a few traders naturally trade mostly
    // with each other.
    const cover = () => pick(1_000, 4_000);
    const maybe = () => r() < 0.7 || options.everyManipulator === true;
    if (maybe()) sim.add(new SpooferAgent("spoofer", intensity(), cover()));
    if (maybe()) sim.add(new LayeringAgent("layerer", intensity(), cover()));
    if (maybe()) sim.add(new PumpAndDumpAgent("pumper", intensity(), cover()));
    if (maybe()) sim.add(...WashTraderAgent.pair("wash_a", "wash_b", intensity(), cover()));
    if (maybe()) sim.add(new QuoteStufferAgent("stuffer", intensity(), cover()));
  }
  return sim;
}

/** How blatant a manipulator is (0 for honest agents). */
export const intensityOf = (agent: Agent): number => ("intensity" in agent ? (agent as { intensity: number }).intensity : 0);

export interface Sample {
  seed: number;
  time: number;
  trader: string;
  label: Label;
  intensity: number;
  features: number[];
}

/**
 * Runs a scenario and snapshots every active trader's features every
 * `everyMs`. A manipulator's window is labelled with its manipulation only if
 * it was actually manipulating during that window; windows where it was only
 * cover-trading are ambiguous, so they are left out rather than mislabelled.
 */
export function collectSamples(seed: number, durationMs: number, options: ScenarioOptions = {}, everyMs = 10_000, warmupMs = 30_000): Sample[] {
  const sim = marketWithManipulators(seed, options);
  const samples: Sample[] = [];
  sim.run(durationMs, 50, {
    everyMs,
    call: (s) => {
      if (s.now < warmupMs) return;
      const market = marketContext(s.now, s.activity);
      for (const agent of s.agents) {
        const activity = s.activity.get(agent.id)!;
        if (!activity.activeAt(s.now)) continue;
        if (agent.label !== "honest" && !agent.manipulatedDuring(s.now - activity.windowMs, s.now)) continue;
        samples.push({
          seed,
          time: s.now,
          trader: agent.id,
          label: agent.label,
          intensity: intensityOf(agent),
          features: activity.features(s.now, market),
        });
      }
    },
  });
  return samples;
}

export function toCsv(samples: Sample[]): string {
  const header = ["seed", "time", "trader", "label", "intensity", ...FEATURE_NAMES].join(",");
  const rows = samples.map((s) => [s.seed, s.time, s.trader, s.label, s.intensity.toFixed(3), ...s.features.map((f) => f.toFixed(6))].join(","));
  return `${header}\n${rows.join("\n")}\n`;
}
