import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

/**
 * The trained market-making policy (services/ai/rl/train.py) and the exact
 * observation and action conventions of its training environment
 * (services/ai/rl/env.py). test/rl.test.ts replays Python's golden cases
 * through this code, so the two cannot drift apart.
 */

export const REFERENCE_VOL_BPS = 20;
const MIN_HALF_SPREAD = 0.25;
const MAX_HALF_SPREAD = 25;
const MAX_SKEW = 10;

export const DEFAULT_POLICY_DIR = fileURLToPath(new URL("../models/", import.meta.url));

const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** What the policy sees: inventory, the volatility forecast, and the tape's buy/sell imbalance. */
export function observation(inventory: number, maxInventory: number, forecastVolBps: number, imbalance: number): number[] {
  return [inventory / maxInventory, clip(Math.log(forecastVolBps / REFERENCE_VOL_BPS), -3, 3), clip(imbalance, -1, 1)];
}

/** Action in [-1, 1]^2 -> distances of the bid and the ask from the mid, in bps. */
export function quotesFromAction(action: readonly number[]): { bidBps: number; askBps: number } {
  const a0 = clip(action[0]!, -1, 1);
  const a1 = clip(action[1]!, -1, 1);
  const half = Math.exp(Math.log(MIN_HALF_SPREAD) + ((a0 + 1) / 2) * (Math.log(MAX_HALF_SPREAD) - Math.log(MIN_HALF_SPREAD)));
  const skew = a1 * MAX_SKEW;
  return { bidBps: Math.max(half + skew, 0), askBps: Math.max(half - skew, 0) };
}

/**
 * Buy/sell imbalance of the public tape: per-second EWMAs of taker buys and
 * sells, as the environment computes it from its market orders.
 */
export class FlowImbalance {
  private buys = 0;
  private sells = 0;
  private buysEwma = 0;
  private sellsEwma = 0;

  constructor(private readonly decay = 0.1) {}

  add(takerSide: "buy" | "sell"): void {
    if (takerSide === "buy") this.buys++;
    else this.sells++;
  }

  /** Closes one second. */
  tick(): void {
    this.buysEwma += this.decay * (this.buys - this.buysEwma);
    this.sellsEwma += this.decay * (this.sells - this.sellsEwma);
    this.buys = this.sells = 0;
  }

  get value(): number {
    const total = this.buysEwma + this.sellsEwma;
    return total < 1e-9 ? 0 : (this.buysEwma - this.sellsEwma) / total;
  }
}

export interface PolicyManifest {
  trained_at: string;
  algorithm: string;
  environment: { max_inventory: number; depth_decay: number };
  baselines: { fixed_half_spread_bps: number; as_gamma: number };
  results: Record<string, { objective: number; pnl_mean: number; pnl_sd: number; sharpe_per_episode: number }>;
  comparison: Record<string, { mean: number; ci95: [number, number]; a_better_share: number }>;
  golden: { obs: number[]; action: number[]; quotes: [number, number] }[];
}

export class RlPolicy {
  private constructor(
    private readonly session: ort.InferenceSession,
    readonly manifest: PolicyManifest,
  ) {}

  static async load(dir = DEFAULT_POLICY_DIR): Promise<RlPolicy> {
    const manifest = JSON.parse(readFileSync(`${dir}/mm-policy.json`, "utf8")) as PolicyManifest;
    return new RlPolicy(await ort.InferenceSession.create(`${dir}/mm-policy.onnx`), manifest);
  }

  /** The policy's action for one observation. */
  async act(obs: readonly number[]): Promise<[number, number]> {
    const out = await this.session.run({ obs: new ort.Tensor("float32", Float32Array.from(obs), [1, obs.length]) });
    const action = out.action!.data as Float32Array;
    return [action[0]!, action[1]!];
  }
}

/**
 * The Avellaneda-Stoikov (2008) quotes, the closed-form baseline the policy
 * is compared with: distances of the bid and the ask from the mid, in bps.
 */
export function avellanedaStoikov(inventory: number, forecastVolBps: number, gamma: number, k: number, horizonS = 60): { bidBps: number; askBps: number } {
  const varPerSecond = (forecastVolBps / Math.sqrt(900)) ** 2;
  const skew = inventory * gamma * varPerSecond * horizonS;
  const half = 0.5 * gamma * varPerSecond * horizonS + Math.log(1 + gamma / k) / gamma;
  return { bidBps: Math.max(half + skew, 0), askBps: Math.max(half - skew, 0) };
}
