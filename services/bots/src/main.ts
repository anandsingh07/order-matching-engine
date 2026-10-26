import { instrumentKind, TradingClient, type Instrument } from "@ome/client";
import { LayeringAgent, PumpAndDumpAgent, SpooferAgent, WashTraderAgent } from "@ome/surveillance";
import { BinanceFollower, BinanceTradeFeed, recordTo, replay, type RawTrade } from "./binance.js";
import { DerivativesMarketMaker } from "./derivatives-maker.js";
import { LiveMarket } from "./live-market.js";
import { MarketMaker, type MarketMakerParams } from "./market-maker.js";
import { NoiseTrader } from "./noise-trader.js";
import type { QuotingBot } from "./quoting-bot.js";
import { prng, RandomWalk } from "./random.js";
import { AvellanedaStoikovMaker, RlMarketMaker } from "./rl-market-maker.js";
import { RlPolicy } from "./rl-policy.js";

// Runs a market full of bots against a running gateway.
//
//   pnpm --filter @ome/bots start                         market makers + 3 noise traders
//   pnpm --filter @ome/bots start -- --binance            BTCUSDT follows the live Binance feed
//   pnpm --filter @ome/bots start -- --binance --record=btc.jsonl
//   pnpm --filter @ome/bots start -- --replay=btc.jsonl --speed=5
//   pnpm --filter @ome/bots start -- --cheaters           manipulators on INFY, for the surveillance demo
//   pnpm --filter @ome/bots start -- --cheaters-only      only the manipulators (INFY, or --cheaters=TCS), joining a market
//                                                         another bots process is already running
//   pnpm --filter @ome/bots start -- --rl=TCS             the RL market maker quotes TCS (--as=TCS: Avellaneda-Stoikov)
//   pnpm --filter @ome/bots start -- --no-derivatives     leave the futures and options unquoted
//   options: --url=http://127.0.0.1:8080 --noise=3 --seed=1 --cheaters=TCS
// When the gateway lists futures and options (it does by default), a derivatives market maker per
// underlying quotes all of them and hedges its delta in the stock, and a noise trader trades them.

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name: string) => process.argv.includes(`--${name}`);
const url = arg("url") ?? "http://127.0.0.1:8080";
// --cheaters-only: no market makers or noise traders of its own, so a second
// process can add the manipulators to a running market without doubling its liquidity.
const cheatersOnly = flag("cheaters-only");
const noiseCount = cheatersOnly ? 0 : Number(arg("noise") ?? 3);
const seed = Number(arg("seed") ?? Date.now() % 1_000_000);
const replayFile = arg("replay");
const useBinance = flag("binance") || replayFile !== undefined;

const random = prng(seed);
// Bots are the market's liquidity providers, so they trade on unlimited accounts.
const connectOptions = { botKey: process.env.BOT_KEY ?? "local-dev-bot-key" };
const instruments = await TradingClient.instruments(url);
const spot = instruments.filter((i) => instrumentKind(i) === "spot");
const stocks = spot.filter((i) => i.symbol !== "BTCUSDT");
const btc = instruments.find((i) => i.symbol === "BTCUSDT");

// Normal 15-minute volatility: about 1.5% for the simulated stocks' random walk, about 0.2% for BTC.
const STOCK_PARAMS: MarketMakerParams = {
  levels: 5,
  halfSpreadBps: 4,
  stepBps: 3,
  size: 25,
  maxPosition: 500,
  skewBps: 8,
  volatility: { normalSigmaPct: 1.5, max: 4 },
};
const BTC_PARAMS: MarketMakerParams = {
  levels: 5,
  halfSpreadBps: 2,
  stepBps: 2,
  size: 2_000,
  maxPosition: 50_000,
  skewBps: 5,
  volatility: { normalSigmaPct: 0.2, max: 4 },
};

const stoppers: (() => void | Promise<void>)[] = [];

// --rl=SYMBOL quotes that symbol with the trained RL policy instead of the ladder;
// --as=SYMBOL with the Avellaneda-Stoikov closed form it was measured against.
const rlSymbol = arg("rl");
const asSymbol = arg("as");
const policy = rlSymbol !== undefined || asSymbol !== undefined ? await RlPolicy.load() : undefined;

async function startMaker(instrument: Instrument, fair: () => number, params: MarketMakerParams): Promise<QuotingBot> {
  const strategy = instrument.symbol === rlSymbol ? "rl" : instrument.symbol === asSymbol ? "as" : "ladder";
  const client = await TradingClient.connect(url, `${strategy === "ladder" ? "mm" : strategy}-${instrument.symbol}`, connectOptions);
  // One inventory unit is one ladder level's size; the RL policy was trained with a limit of 10 units.
  const single = { unitQuantity: params.size, maxInventory: policy?.manifest.environment.max_inventory ?? 10 };
  const maker =
    strategy === "rl"
      ? new RlMarketMaker(client, instrument, fair, single, policy!)
      : strategy === "as"
        ? new AvellanedaStoikovMaker(client, instrument, fair, single, policy!.manifest.baselines.as_gamma, policy!.manifest.environment.depth_decay)
        : new MarketMaker(client, instrument, fair, params);
  maker.start();
  if (strategy !== "ladder") console.log(`${instrument.symbol}: quoted by the ${strategy === "rl" ? "RL policy" : "Avellaneda-Stoikov maker"}`);
  stoppers.push(async () => {
    await maker.stop();
    client.close();
  });
  return maker;
}

const makers: QuotingBot[] = [];
for (const stock of cheatersOnly ? [] : stocks) {
  // Each stock's fair value is a random walk at about 0.05% volatility per second.
  const walk = new RandomWalk(stock.referencePrice, 0.0005, random, stock.tickSize * 10);
  let last = performance.now();
  const fair = () => {
    const now = performance.now();
    walk.step((now - last) / 1000);
    last = now;
    return walk.current;
  };
  makers.push(await startMaker(stock, fair, STOCK_PARAMS));
}

if (!cheatersOnly && btc !== undefined && useBinance) {
  const client = await TradingClient.connect(url, "binance-follower", connectOptions);
  const follower = new BinanceFollower(client, btc);
  follower.start();
  makers.push(await startMaker(btc, () => follower.fairPrice ?? btc.referencePrice, BTC_PARAMS));
  const recordFile = arg("record");
  const record = recordFile === undefined ? undefined : recordTo(recordFile);
  const onTrade = (trade: RawTrade) => {
    follower.onTrade(trade);
    record?.(trade);
  };
  if (replayFile !== undefined) {
    const abort = new AbortController();
    void replay(replayFile, onTrade, Number(arg("speed") ?? 1), abort.signal).then((n) => console.log(`replay finished: ${n} trades`));
    stoppers.push(() => abort.abort());
  } else {
    const feed = new BinanceTradeFeed("btcusdt", onTrade, undefined, console.log);
    feed.start();
    stoppers.push(() => feed.stop());
  }
  stoppers.push(() => {
    follower.stop();
    client.close();
  });
  setInterval(() => console.log(`binance: ${follower.received} real trades in, ${follower.sent} orders out, fair ${follower.fairPrice}`), 10_000).unref();
} else if (!cheatersOnly && btc !== undefined) {
  const walk = new RandomWalk(btc.referencePrice, 0.001, random, 100);
  makers.push(await startMaker(btc, () => walk.step(0.25), BTC_PARAMS));
}

const tradeable = useBinance ? stocks : spot;
for (let i = 0; i < noiseCount; i++) {
  const client = await TradingClient.connect(url, `noise-${i + 1}`, connectOptions);
  const trader = new NoiseTrader(client, tradeable, prng(seed + i + 1), {
    meanIntervalMs: 150,
    maxLots: 20,
    marketShare: 0.3,
    restMs: 4_000,
    // 50 lots of 0.00001 BTC: retail BTC orders of about $40-800.
    lotMultiplier: { BTCUSDT: 50 },
  });
  trader.start();
  stoppers.push(() => {
    trader.stop();
    client.close();
  });
}

// Futures and options: one market maker per underlying, following the series as they roll.
const derivativeMakers: DerivativesMarketMaker[] = [];
const underlyings = new Set(instruments.flatMap((i) => (instrumentKind(i) === "spot" || i.underlying === undefined ? [] : [i.underlying])));
if (!cheatersOnly && !flag("no-derivatives")) {
  for (const symbol of underlyings) {
    const underlying = spot.find((i) => i.symbol === symbol);
    if (underlying === undefined) continue;
    const client = await TradingClient.connect(url, `deriv-mm-${symbol}`, connectOptions);
    const maker = new DerivativesMarketMaker(client, underlying);
    await maker.start(instruments);
    derivativeMakers.push(maker);
    stoppers.push(async () => {
      await maker.stop();
      client.close();
    });
  }
  if (derivativeMakers.length > 0) {
    // Retail flow in the futures and options, so the makers' quotes trade (and get hedged) like the stocks'.
    // Slower than the stock noise: 22 series of small size, not 5 symbols.
    const isDerivative = (i: Instrument) => instrumentKind(i) !== "spot";
    const client = await TradingClient.connect(url, "noise-derivatives", connectOptions);
    const trader = new NoiseTrader(client, instruments.filter(isDerivative), prng(seed + 50), {
      meanIntervalMs: 500,
      maxLots: 5,
      marketShare: 0.3,
      restMs: 4_000,
    });
    // It follows the listing cycle: expired series drop out and new ones join.
    const off = client.on("instruments", (m) => trader.setInstruments(m.instruments.filter(isDerivative)));
    trader.start();
    stoppers.push(() => {
      off();
      trader.stop();
      client.close();
    });
    console.log(`derivatives quoted on ${[...underlyings].join(", ")}, with a noise trader in them`);
  }
}

// Manipulators for the surveillance demo: the same agents that generated the
// training data, trading live on one symbol through their own accounts.
const cheaterSymbol = arg("cheaters") ?? (flag("cheaters") || cheatersOnly ? "INFY" : undefined);
if (cheaterSymbol !== undefined) {
  const instrument = instruments.find((i) => i.symbol === cheaterSymbol);
  if (instrument === undefined) throw new Error(`unknown symbol for --cheaters: ${cheaterSymbol}`);
  const agents = [
    new SpooferAgent("spoofer", 0.7, 2_500),
    new LayeringAgent("layerer", 0.7, 2_500),
    new PumpAndDumpAgent("pumper", 0.7, 2_500),
    ...WashTraderAgent.pair("wash-a", "wash-b", 0.7, 2_500),
  ];
  const clients = new Map<string, TradingClient>();
  for (const agent of agents) clients.set(agent.id, await TradingClient.connect(url, agent.id, connectOptions));
  const live = new LiveMarket(instrument, agents, clients, prng(seed + 99));
  live.start();
  stoppers.push(() => {
    live.stop();
    for (const c of clients.values()) c.close();
  });
  console.log(`manipulators trading ${cheaterSymbol}: ${agents.map((a) => a.id).join(", ")}`);
}

console.log(
  `${cheatersOnly ? "manipulators" : "bots"} running against ${url} (seed ${seed}${useBinance && !cheatersOnly ? ", BTCUSDT from Binance" : ""}). Ctrl+C to stop.`,
);
setInterval(() => {
  const summary = makers.map((m) => `${m.tracker.symbol} pos ${m.tracker.position} fills ${m.tracker.fills}`);
  for (const d of derivativeMakers) {
    const { delta } = d.exposure();
    const fills = d.trackers.reduce((n, t) => n + t.fills, 0);
    summary.push(`${d.underlying.symbol} derivatives: ${d.series.length} series, fills ${fills}, delta ${delta.toFixed(0)}, hedge ${d.hedge.position}`);
  }
  if (summary.length > 0) console.log(summary.join(" | "));
}, 10_000).unref();

async function shutdown(): Promise<void> {
  console.log("stopping bots...");
  for (const stop of stoppers.reverse()) await stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
