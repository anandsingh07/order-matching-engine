import { TradingClient, type Instrument } from "@ome/client";
import { Exchange } from "@ome/exchange";
import { DEFAULT_INSTRUMENTS, Gateway } from "@ome/gateway";
import { MarketMaker } from "./market-maker.js";
import { prng } from "./random.js";
import { AvellanedaStoikovMaker, RlMarketMaker } from "./rl-market-maker.js";
import { RlPolicy } from "./rl-policy.js";
import { ToxicFlow } from "./toxic-flow.js";

// Head-to-head of market-making strategies through the real exchange and
// gateway, in the RL training environment's market (toxic-flow.ts). Every
// strategy faces the same seeded fair-value path and order flow, so the
// comparison is paired, as it is offline.
//
//   pnpm --filter @ome/bots compare -- --episodes=5 --steps=900
//
// PnL is in the environment's units (bps of the start price, per inventory
// unit), so it can be read against services/bots/models/mm-policy.json.
//
// The rest of the market. In the Avellaneda-Stoikov model a market order that
// does not reach our quote still trades, with liquidity inside our quote, and
// so it still prints on the public tape. With our maker as the only liquidity
// here, such orders would vanish, and the tape would show only our own fills.
// That gap made the policy lose live (it reads the tape's imbalance) until a
// second participant supplied that inside liquidity: for every order that
// will not reach our quote, it rests the other side just inside it, and the
// order trades there. Our fills are unaffected; the tape is a real market's.

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const episodes = arg("episodes", 5);
const steps = arg("steps", 900);
const BOT_KEY = "compare";
const LIQUIDATION_BPS = 2;

const policy = await RlPolicy.load();
const { as_gamma: gamma, fixed_half_spread_bps: fixedHalf } = policy.manifest.baselines;
const { depth_decay: depthDecay, max_inventory: maxInventory } = policy.manifest.environment;
const btc = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "BTCUSDT") as Instrument;
const unitQuantity = 2_000; // 0.02 BTC
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Strategy = "fixed_spread" | "avellaneda_stoikov" | "ppo";
const STRATEGIES: Strategy[] = ["fixed_spread", "avellaneda_stoikov", "ppo"];

async function episode(strategy: Strategy, seed: number): Promise<{ pnl: number; fills: number; inventory: number }> {
  const exchange = Exchange.start({ symbols: [btc.symbol], workers: 1 });
  const gateway = await Gateway.create({ exchange, instruments: [btc], botKey: BOT_KEY, rateLimit: { burst: 2_000, perSecond: 2_000 }, bookIntervalMs: 1_000 });
  const url = await gateway.listen(0);
  const makerClient = await TradingClient.connect(url, strategy, { botKey: BOT_KEY });
  const flowClient = await TradingClient.connect(url, "flow", { botKey: BOT_KEY });
  const restClient = await TradingClient.connect(url, "rest-of-market", { botKey: BOT_KEY });
  const flow = new ToxicFlow(prng(seed));
  const fair = () => (btc.referencePrice * flow.mid) / 10_000;
  const single = { unitQuantity, maxInventory, maxActionsPerSecond: 10_000 };

  const maker =
    strategy === "ppo"
      ? new RlMarketMaker(makerClient, btc, fair, single, policy)
      : strategy === "avellaneda_stoikov"
        ? new AvellanedaStoikovMaker(makerClient, btc, fair, single, gamma, depthDecay)
        : new MarketMaker(makerClient, btc, fair, {
            levels: 1,
            halfSpreadBps: fixedHalf,
            stepBps: 0,
            size: unitQuantity,
            maxPosition: unitQuantity * maxInventory,
            skewBps: 0,
            maxActionsPerSecond: 10_000,
          });
  if (!(maker instanceof MarketMaker)) maker.listen(); // the single-quote makers read the tape

  let id = 0;
  for (let t = 0; t < steps; t++) {
    // As in the environment: quote, then the second's market orders arrive, then the price moves.
    if (maker instanceof MarketMaker) await maker.requote();
    else await maker.step();
    const { buys, sells } = flow.orders();
    const price = fair();
    const book = maker.tracker.open;
    const ourAsk = Math.min(...[...book.values()].filter((o) => o.side === "sell").map((o) => o.price));
    const ourBid = Math.max(...[...book.values()].filter((o) => o.side === "buy").map((o) => o.price));
    const marketOrder = async (side: "buy" | "sell", reach: number) => {
      const limit = side === "buy" ? Math.ceil(price * (1 + reach / 10_000)) : Math.floor(price * (1 - reach / 10_000));
      const reachesUs = side === "buy" ? limit >= ourAsk : limit <= ourBid;
      // An order that will not reach our quote trades with the rest of the market, just inside it
      // (unless that resting order would itself trade with our other side, which is rare).
      const crossesUs = side === "buy" ? limit <= ourBid : limit >= ourAsk;
      if (!reachesUs && !crossesUs) {
        const opposite = side === "buy" ? "sell" : "buy";
        await restClient.placeOrder(btc.symbol, `r${id++}`, { type: "limit", side: opposite, price: limit, quantity: unitQuantity });
      }
      await flowClient.placeOrder(btc.symbol, `f${id++}`, { type: "limit", side, price: limit, quantity: unitQuantity, timeInForce: "IOC" });
    };
    // Sequential, as each order changes what the next one meets.
    for (const reach of buys) await marketOrder("buy", reach);
    for (const reach of sells) await marketOrder("sell", reach);
    flow.move();
    await pause(1); // let the maker's execution reports arrive before it quotes again
  }
  await pause(50);
  const tracker = maker.tracker;
  const unitsHeld = tracker.position / unitQuantity;
  const bps = (btc.referencePrice / 10_000) * unitQuantity; // one bp of the start price, per unit, in tick x quantity
  const pnl = tracker.pnl(fair()) / bps - LIQUIDATION_BPS * Math.abs(unitsHeld);
  await maker.stop();
  makerClient.close();
  flowClient.close();
  restClient.close();
  await gateway.close();
  await exchange.stop();
  return { pnl, fills: tracker.fills, inventory: unitsHeld };
}

const results = new Map<Strategy, { pnl: number; fills: number }[]>(STRATEGIES.map((s) => [s, []]));
for (let e = 0; e < episodes; e++) {
  const seed = 2_000_000 + e;
  const line: string[] = [];
  for (const strategy of STRATEGIES) {
    const r = await episode(strategy, seed);
    results.get(strategy)!.push(r);
    line.push(`${strategy} ${r.pnl.toFixed(0)} (${r.fills} fills)`);
  }
  console.log(`episode ${e + 1}/${episodes}: ${line.join(" | ")}`);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
console.log(`\nlive, ${episodes} episodes of ${steps} s through the real gateway (PnL in bps per unit):`);
for (const [strategy, rs] of results) {
  const pnl = rs.map((r) => r.pnl);
  console.log(`  ${strategy.padEnd(20)} PnL ${mean(pnl).toFixed(1).padStart(8)}  sd ${sd(pnl).toFixed(1).padStart(7)}  fills ${mean(rs.map((r) => r.fills)).toFixed(0)}`);
}
const diff = results.get("ppo")!.map((r, i) => r.pnl - results.get("avellaneda_stoikov")![i]!.pnl);
const half = (1.96 * sd(diff) * Math.sqrt(diff.length / Math.max(1, diff.length - 1))) / Math.sqrt(diff.length);
console.log(`  PPO - AS, paired: ${mean(diff).toFixed(1)} (95% CI ${(mean(diff) - half).toFixed(1)} to ${(mean(diff) + half).toFixed(1)})`);
const offline = policy.manifest.results;
console.log(`offline, for comparison: PPO PnL ${offline.ppo?.pnl_mean}, AS ${offline.avellaneda_stoikov?.pnl_mean}, fixed ${offline.fixed_spread?.pnl_mean}`);
process.exit(0);
