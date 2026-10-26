import { exponential, gaussian } from "./random.js";

/**
 * The RL training environment's market (services/ai/rl/env.py), rebuilt to
 * run through the real exchange: a hidden fair value with volatility bursts
 * and trends, and market orders that lean with the trend (informed flow).
 *
 * Each market order is sent as an IOC limit order reaching a random distance
 * from fair value, exponential with rate k (in bps), so it fills a quote with
 * probability exp(-k * distance): the same fill model as the environment.
 */
export interface ToxicFlowParams {
  arrivalRate: number;
  depthDecay: number;
  volBps: number;
  burstMultiplier: number;
  burstStartRate: number;
  burstEndRate: number;
  trendStartRate: number;
  trendEndRate: number;
  trendDriftBps: number;
  flowLean: number;
}

export const DEFAULT_TOXIC_FLOW: ToxicFlowParams = {
  arrivalRate: 1,
  depthDecay: 0.5,
  volBps: 20,
  burstMultiplier: 3,
  burstStartRate: 1 / 400,
  burstEndRate: 1 / 60,
  trendStartRate: 1 / 180,
  trendEndRate: 1 / 60,
  trendDriftBps: 0.25,
  flowLean: 0.6,
};

/** Poisson sample by counting exponential gaps (fine for small rates). */
function poisson(random: () => number, rate: number): number {
  let n = 0;
  for (let t = exponential(random, 1 / rate); t < 1; t += exponential(random, 1 / rate)) n++;
  return n;
}

export class ToxicFlow {
  /** Fair value in bps of the start price (starts at 10,000), as in the environment. */
  mid = 10_000;
  burst = false;
  trend: -1 | 0 | 1 = 0;

  constructor(
    private readonly random: () => number,
    private readonly p: ToxicFlowParams = DEFAULT_TOXIC_FLOW,
  ) {}

  /** The current volatility over 15 minutes, in bps. */
  get vol(): number {
    return this.p.volBps * (this.burst ? this.p.burstMultiplier : 1);
  }

  /** One second of market orders: how far (in bps from fair) each buy and sell reaches. */
  orders(): { buys: number[]; sells: number[] } {
    const p = this.p;
    const r = this.random;
    if (this.burst) this.burst = r() >= p.burstEndRate;
    else this.burst = r() < p.burstStartRate;
    if (this.trend === 0) {
      if (r() < p.trendStartRate) this.trend = r() < 0.5 ? 1 : -1;
    } else if (r() < p.trendEndRate) this.trend = 0;
    const reach = () => exponential(r, 1 / p.depthDecay);
    const buys = Array.from({ length: poisson(r, p.arrivalRate * (1 + p.flowLean * this.trend)) }, reach);
    const sells = Array.from({ length: poisson(r, p.arrivalRate * (1 - p.flowLean * this.trend)) }, reach);
    return { buys, sells };
  }

  /** The fair value moves: trend drift plus noise. */
  move(): void {
    this.mid += this.p.trendDriftBps * this.trend + (this.vol / Math.sqrt(900)) * gaussian(this.random);
  }
}
