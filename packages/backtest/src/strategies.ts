import { readFileSync } from "node:fs";
import type { Side } from "@ome/client";
import {
  avellanedaStoikov,
  computeQuotes,
  DEFAULT_POLICY_DIR,
  FlowImbalance,
  observation,
  quotesFromAction,
  RlPolicy,
  wideningFor,
  type MarketMakerParams,
  type PolicyManifest,
  type Quote,
} from "@ome/bots";
import type { Strategy, StrategyContext } from "./types.js";

// The built-in strategies. The market makers are the live bots' own quoting
// code (@ome/bots) on the backtest's clock, sending its quotes the way the
// live QuotingBot does (plain limit orders), so a backtest measures the
// strategy that would actually run, not a re-implementation of it. What the
// backtest cannot reproduce is the market's response: see engine.ts.

/** services/bots/src/rl-policy.ts: the volatility observations are relative to this, and it stands in until there is a forecast. */
export const REFERENCE_VOL_BPS = 20;

/** The live BTC/USDT ladder's settings (services/bots/src/main.ts). */
export const LADDER_PARAMS: MarketMakerParams = {
  levels: 5,
  halfSpreadBps: 2,
  stepBps: 2,
  size: 2_000,
  maxPosition: 50_000,
  skewBps: 5,
  volatility: { normalSigmaPct: 0.2, max: 4 },
};

/** One inventory unit, as in the live head-to-head (services/bots/src/compare.ts): 0.02 BTC, one ladder level. */
export const UNIT_QUANTITY = 2_000;

/**
 * The live QuotingBot's action budget: a token bucket of `perSecond` actions
 * (orders plus cancels), kept under the gateway's rate limit.
 */
export class ActionBudget {
  private tokens: number;
  private refilled: number | null = null;

  constructor(readonly perSecond: number) {
    this.tokens = perSecond;
  }

  refill(now: number): void {
    if (this.refilled !== null) this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.refilled) / 1000) * this.perSecond);
    this.refilled = now;
  }

  spend(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * What a quote that would cross the touch becomes. "take" is what the live
 * bots do: they send plain limit orders (the exchange has no post-only type),
 * so such a quote takes liquidity at once, as a taker. "hold" posts it at the
 * touch instead, as a post-only maker that slides its quote would: an
 * alternative to measure against, not what runs live.
 */
export type Crossing = "take" | "hold";

/** requote's label for a quote it held at the touch, so the result can say what those quotes did. */
export const HELD_TAG = "held";

/**
 * Moves the strategy's quotes to `desired` the way the live QuotingBot does:
 * cancels quotes no longer wanted, places the missing ones, and leaves
 * unchanged quotes alone so they keep their place in the queue. With a
 * budget, cancels go first, then the quotes nearest the touch (listed
 * first), and the rest wait for the next cycle.
 *
 * With crossing "take" (the default) every quote is a plain limit order, as
 * the live bot sends it, and one through the touch trades on arrival. With
 * "hold" quotes are post-only and one through the touch waits at the touch
 * instead (a second quote at the same price is dropped); those are tagged
 * HELD_TAG.
 */
export function requote(ctx: StrategyContext, desired: readonly Quote[], budget?: ActionBudget, crossing: Crossing = "take"): void {
  const touch = ctx.touch;
  if (touch === null) return;
  budget?.refill(ctx.now);
  const spend = () => budget?.spend() ?? true;
  const key = (side: Side, price: number) => `${side}:${price}`;
  const wanted = new Map<string, Quote & { held: boolean }>();
  for (const q of desired) {
    const price = crossing === "take" ? q.price : q.side === "buy" ? Math.min(q.price, touch.bid) : Math.max(q.price, touch.ask);
    if (price > 0 && !wanted.has(key(q.side, price))) wanted.set(key(q.side, price), { ...q, price, held: price !== q.price });
  }
  const have = new Set<string>();
  for (const order of ctx.openOrders()) {
    if (order.type !== "limit" || order.cancelRequested) continue;
    const k = key(order.side, order.price!);
    if (wanted.has(k) && !have.has(k)) have.add(k);
    else if (spend()) ctx.cancel(order.id);
  }
  for (const [k, q] of wanted) {
    if (have.has(k)) continue;
    if (!spend()) break;
    ctx.placeLimit(q.side, q.price, q.quantity, crossing === "take" ? { postOnly: false } : q.held ? { tag: HELD_TAG } : {});
  }
}

/**
 * The live ladder market maker (MarketMaker in @ome/bots): five levels a
 * side around the last price, skewed against inventory, widened by the
 * volatility forecast, requoted every 250 ms within 50 actions a second.
 */
export function ladderMaker(params: MarketMakerParams = LADDER_PARAMS, intervalMs = 250, crossing: Crossing = "take"): Strategy {
  const budget = new ActionBudget(params.maxActionsPerSecond ?? 50);
  return {
    name: "ladder",
    init: (ctx) => ctx.every(intervalMs, "quote"),
    onTimer: (ctx) => {
      if (ctx.lastPrice === null) return;
      const sigmaPct = ctx.volatility === null ? null : ctx.volatility.sigma * 100;
      requote(
        ctx,
        computeQuotes({ ...params, fair: ctx.lastPrice, position: ctx.position, tickSize: ctx.instrument.tickSize, widening: wideningFor(sigmaPct, params.volatility) }),
        budget,
        crossing,
      );
    },
  };
}

export interface SingleQuoteOptions {
  /** Quantity of one inventory unit; each quote is one unit. */
  unitQuantity: number;
  /** In units; the side that would grow inventory further stops quoting. */
  maxInventory: number;
  /** The live bot's action budget; 20 a second, as SingleQuoteMaker defaults to. */
  maxActionsPerSecond?: number;
  /** What a quote through the touch becomes (see Crossing); "take", as live, by default. */
  crossing?: Crossing;
}

type Distances = (inventory: number, forecastVolBps: number, imbalance: number) => { bidBps: number; askBps: number } | Promise<{ bidBps: number; askBps: number }>;

/**
 * One bid and one ask, set as distances from fair value once a second, from
 * what the live bot sees: inventory, the volatility forecast and the tape's
 * buy/sell imbalance. The same steps as SingleQuoteMaker in
 * services/bots/src/rl-market-maker.ts.
 */
function singleQuoteMaker(name: string, distances: Distances, o: SingleQuoteOptions): Strategy {
  const flow = new FlowImbalance();
  const budget = new ActionBudget(o.maxActionsPerSecond ?? 20);
  return {
    name,
    init: (ctx) => ctx.every(1_000, "step"),
    onTrade: (_ctx, trade) => flow.add(trade.takerSide),
    onTimer: async (ctx) => {
      flow.tick(); // closes the second's tape imbalance
      const fair = ctx.lastPrice;
      if (fair === null) return;
      const inventory = Math.round(ctx.position / o.unitQuantity);
      const volBps = ctx.volatility === null ? REFERENCE_VOL_BPS : ctx.volatility.sigma * 10_000;
      const { bidBps, askBps } = await distances(inventory, volBps, flow.value);
      const tick = ctx.instrument.tickSize;
      const bid = Math.floor((fair * (1 - bidBps / 10_000)) / tick) * tick;
      let ask = Math.ceil((fair * (1 + askBps / 10_000)) / tick) * tick;
      if (ask <= bid) ask = bid + tick;
      const quotes: Quote[] = [];
      if (inventory < o.maxInventory && bid > 0) quotes.push({ side: "buy", price: bid, quantity: o.unitQuantity });
      if (inventory > -o.maxInventory) quotes.push({ side: "sell", price: ask, quantity: o.unitQuantity });
      requote(ctx, quotes, budget, o.crossing);
    },
  };
}

/** The trained policy's manifest: its environment and the tuned baselines. */
export function readPolicyManifest(dir = DEFAULT_POLICY_DIR): PolicyManifest {
  return JSON.parse(readFileSync(`${dir}/mm-policy.json`, "utf8")) as PolicyManifest;
}

/** Avellaneda-Stoikov with the risk aversion tuned for the RL comparison, and the forecast as sigma. */
export function avellanedaStoikovMaker(manifest = readPolicyManifest(), unitQuantity = UNIT_QUANTITY, crossing: Crossing = "take"): Strategy {
  const { as_gamma: gamma } = manifest.baselines;
  const { depth_decay: k, max_inventory: maxInventory } = manifest.environment;
  return singleQuoteMaker("as", (inventory, volBps) => avellanedaStoikov(inventory, volBps, gamma, k), { unitQuantity, maxInventory, crossing });
}

/** The PPO policy (services/ai/rl), run through ONNX exactly as the live RlMarketMaker runs it. */
export function rlMaker(policy: RlPolicy, unitQuantity = UNIT_QUANTITY, crossing: Crossing = "take"): Strategy {
  const maxInventory = policy.manifest.environment.max_inventory;
  return singleQuoteMaker(
    "rl",
    async (inventory, volBps, imbalance) => quotesFromAction(await policy.act(observation(inventory, maxInventory, volBps, imbalance))),
    { unitQuantity, maxInventory, crossing },
  );
}

export interface CrossoverOptions {
  /** Bars in the fast and slow moving averages of the close. */
  fast: number;
  slow: number;
  /** Position held, long or short, in quantity units. */
  quantity: number;
}

/**
 * A taker: long while the fast moving average of minute closes is above the
 * slow one, short while it is below, switching with market orders at bar
 * closes. Short positions are allowed, as on a margin or perpetual account.
 * 10 units (0.2 BTC) matches the market makers' inventory limit.
 */
export function movingAverageCrossover(o: CrossoverOptions = { fast: 5, slow: 20, quantity: 10 * UNIT_QUANTITY }): Strategy {
  if (!(o.fast > 0 && o.fast < o.slow)) throw new Error("need 0 < fast < slow");
  return {
    name: "ma",
    onBar: (ctx) => {
      const bars = ctx.bars();
      if (bars.length < o.slow) return;
      const mean = (n: number) => bars.slice(-n).reduce((s, b) => s + b.close, 0) / n;
      const fast = mean(o.fast);
      const slow = mean(o.slow);
      if (fast === slow) return;
      const target = fast > slow ? o.quantity : -o.quantity;
      // Count market orders still on their way, so a slow fill is not sent twice.
      const inFlight = ctx.openOrders().reduce((s, order) => (order.type === "market" ? s + (order.side === "buy" ? 1 : -1) * order.quantity : s), 0);
      const delta = target - ctx.position - inFlight;
      if (delta !== 0) ctx.marketOrder(delta > 0 ? "buy" : "sell", Math.abs(delta));
    },
  };
}

export const STRATEGY_NAMES = ["ladder", "as", "rl", "ma"] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export const STRATEGY_LABELS: Record<string, string> = {
  ladder: "Ladder market maker",
  as: "Avellaneda-Stoikov",
  rl: "RL policy (PPO)",
  ma: "MA crossover (taker)",
};

/** Strategies that quote, and so need a tape of trades rather than bars. */
export const NEEDS_TAPE: ReadonlySet<string> = new Set(["ladder", "as", "rl"]);

/** A built-in strategy by name. The RL policy is loaded once and can be shared; `crossing` applies to the market makers. */
export async function createStrategy(name: StrategyName, options: { policy?: RlPolicy; crossing?: Crossing } = {}): Promise<Strategy> {
  const crossing = options.crossing ?? "take";
  switch (name) {
    case "ladder":
      return ladderMaker(LADDER_PARAMS, 250, crossing);
    case "as":
      return avellanedaStoikovMaker(readPolicyManifest(), UNIT_QUANTITY, crossing);
    case "rl":
      return rlMaker(options.policy ?? (await RlPolicy.load()), UNIT_QUANTITY, crossing);
    case "ma":
      return movingAverageCrossover();
  }
}
