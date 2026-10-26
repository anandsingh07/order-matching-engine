import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RlPolicy } from "@ome/bots";
import { BTCUSDT, loadMarketData, MINUTE_MS, siblingKlines } from "./data.js";
import { DEFAULT_CONFIG, runBacktest } from "./engine.js";
import { BAR_MARKOUT_HORIZONS_MS, MARKOUT_HORIZONS_MS, NEAR_TOUCH_BPS } from "./metrics.js";
import { htmlReport, quotesTable, summaryTable, windowsTable } from "./report.js";
import { createStrategy, NEEDS_TAPE, STRATEGY_NAMES, type Crossing, type StrategyName } from "./strategies.js";
import type { BacktestConfig, BacktestResult, QueueModel } from "./types.js";
import { compareWindows, splitWindows, type WindowComparison } from "./windows.js";

// Backtests strategies on real market data and writes a JSON and an HTML report.
//
//   pnpm --filter @ome/backtest backtest                                  every strategy on the bundled 30 minutes of BTC/USDT
//   pnpm --filter @ome/backtest backtest -- --strategy=as --latency-ms=50 --maker-fee-bps=1 --taker-fee-bps=5
//   pnpm --filter @ome/backtest backtest -- --data=btc.jsonl              a session recorded with pnpm bots -- --binance --record=btc.jsonl
//   pnpm --filter @ome/backtest backtest -- --strategy=ma --data=../../services/ai/data/btcusdt_1m.csv   bars (klines)
//   pnpm --filter @ome/backtest backtest -- --data=data/btcusdt-2026-10-24.aggtrades.csv --windows=30   a day, also compared window by window
//   options: --strategy=ladder,as,rl,ma|all --warmup=<klines.csv>|none --queue=through|touch --crossing=take|hold
//            --slippage-bps=1 --capital=100000 --sample-ms=1000 --out=reports/name
//            --windows=<minutes> --baseline=as (the strategy the paired differences are taken against)
// Relative paths are relative to packages/backtest, where pnpm runs the script.

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const num = (name: string, fallback: number) => {
  const text = arg(name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (Number.isNaN(value)) throw new Error(`--${name}=${text} is not a number`);
  return value;
};

const FIXTURE = fileURLToPath(new URL("../test/fixtures/btcusdt-2026-10-23T1430Z.aggtrades.csv", import.meta.url));
const dataPath = arg("data") ?? FIXTURE;
const warmupArg = arg("warmup");
const warmup = warmupArg === "none" ? null : (warmupArg ?? siblingKlines(dataPath));
const queue = (arg("queue") ?? DEFAULT_CONFIG.queue) as QueueModel;
if (queue !== "through" && queue !== "touch") throw new Error("--queue must be through or touch");
// "take", as the live bots send plain limit orders; "hold" posts a crossing quote at the touch instead.
const crossing = (arg("crossing") ?? "take") as Crossing;
if (crossing !== "take" && crossing !== "hold") throw new Error("--crossing must be take or hold");
const requested = (arg("strategy") ?? "all").split(",");
const names = (requested.includes("all") ? [...STRATEGY_NAMES] : requested) as StrategyName[];
for (const n of names) if (!STRATEGY_NAMES.includes(n)) throw new Error(`unknown strategy "${n}"; choose from ${STRATEGY_NAMES.join(", ")} or all`);

const instrument = { ...BTCUSDT, priceScale: num("price-scale", BTCUSDT.priceScale), quantityScale: num("quantity-scale", BTCUSDT.quantityScale) };
const data = loadMarketData(dataPath, instrument, { warmup });
const windowMinutes = arg("windows") === undefined ? null : num("windows", 30);
// Checked before any work is done: the windows cut a tape by its trades, and failing after the runs would lose their reports.
if (windowMinutes !== null && data.kind !== "trades") throw new Error("--windows needs a tape of trades; this data is 1-minute bars");
const span = data.kind === "trades" ? (data.trades.at(-1)?.time ?? 0) - (data.trades[0]?.time ?? 0) : data.bars.length * MINUTE_MS;
// Unless asked, the finest equity spacing that keeps the curve under ~3,600 points, so a day of data is not a 10 MB report.
const sampleMs = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, MINUTE_MS].find((ms) => span / ms <= 3_600) ?? MINUTE_MS;
const config: Partial<BacktestConfig> = {
  instrument,
  latencyMs: num("latency-ms", DEFAULT_CONFIG.latencyMs),
  makerFeeBps: num("maker-fee-bps", DEFAULT_CONFIG.makerFeeBps),
  takerFeeBps: num("taker-fee-bps", DEFAULT_CONFIG.takerFeeBps),
  slippageBps: num("slippage-bps", DEFAULT_CONFIG.slippageBps),
  queue,
  capital: num("capital", DEFAULT_CONFIG.capital),
  sampleMs: num("sample-ms", sampleMs),
};

const count = data.kind === "trades" ? data.trades.length : data.bars.length;
console.log(`${dataPath}: ${count} ${data.kind === "trades" ? "trades" : "1-minute bars"}, ${data.warmup.length} warm-up bars${warmup === null ? "" : ` from ${warmup}`}`);
const policy = names.includes("rl") ? await RlPolicy.load() : undefined;
const runnable = names.filter((name) => {
  if (data.kind === "bars" && NEEDS_TAPE.has(name)) {
    console.log(`${name}: skipped, a market maker needs a tape of trades to be filled by, not bars`);
    return false;
  }
  return true;
});
if (runnable.length === 0) process.exit(1);
const results: BacktestResult[] = [];
for (const name of runnable) {
  const started = performance.now();
  const { result } = await runBacktest(await createStrategy(name, { policy, crossing }), data, config);
  console.log(`${name}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  results.push(result);
}

const c = results[0]!.config;
console.log(
  `\nlatency ${c.latencyMs} ms, maker fee ${c.makerFeeBps} bps, taker fee ${c.takerFeeBps} bps, slippage ${c.slippageBps} bps, queue "${c.queue}", crossing "${crossing}", capital ${c.capital}`,
);
console.log(summaryTable(results, instrument));
const quotes = quotesTable(results, instrument);
if (quotes !== "") console.log(`\n${quotes}`);

let windows: WindowComparison | undefined;
if (windowMinutes !== null) {
  const parts = splitWindows(data, windowMinutes);
  const runs: BacktestResult[][] = [];
  for (const part of parts) {
    const row: BacktestResult[] = [];
    for (const name of runnable) row.push((await runBacktest(await createStrategy(name, { policy, crossing }), part, config)).result);
    runs.push(row);
  }
  windows = compareWindows(runs, windowMinutes, arg("baseline") ?? "as");
  console.log(`\n${windowsTable(windows, instrument)}`);
}

// The crossing mode only means something to a strategy that quotes.
const quoting = runnable.some((name) => NEEDS_TAPE.has(name));
const notes = [
  "The historical trades are taker flow. Each is replayed as an IOC order, capped at its real size, into the real matching engine (@ome/core), which holds only the strategy's resting quotes.",
  (c.queue === "through"
    ? 'Queue model "through" (conservative): a quote fills only when the market trades strictly through its price. The tape has no depth, so queue position is unknown, and this assumes the strategy was last in the queue.'
    : 'Queue model "touch" (optimistic): a trade at the quote\'s price fills it, as if the strategy were first in the queue.') +
    ' Running both models shows how much a result depends on queue position; they are models of it, not exact bounds.',
  "A print also proves an order on its far side: a buyer-initiated trade at a price lifted an ask resting there. A quote of ours at or through that price could not have rested beside it, so in both queue models the print fills it at its own price, capped by the print's size.",
  "The rest of the market's touch comes from the tape: a buyer-initiated trade printed at the ask, a seller-initiated one at the bid, and the spread is one tick.",
  ...(!quoting
    ? []
    : crossing === "take"
      ? [
          "Quotes are plain limit orders, as the live bots send them (the exchange has no post-only type). A quote that crosses the touch when it arrives takes liquidity at once: it fills in full as a taker at the touch plus the slippage, never past its limit, and pays the taker fee. It is assumed to find its whole size at the touch the tape implies; live, had that level just emptied, it would rest instead. The quotes table counts these.",
        ]
      : [
          'Crossing "hold": a quote the live bot would send through the touch is posted at the touch instead, as a post-only maker that slides its quote would. The live bots do not do this (they send plain limit orders, which would take liquidity), so this measures an alternative, not what runs live. The quotes table counts these held quotes and their share of the maker fills.',
        ]),
  `Every action takes effect ${c.latencyMs} ms after the decision. Market data and fills reach the strategy at once. At equal timestamps the tape comes before the strategy's actions.`,
  `Market orders fill at the touch plus ${c.slippageBps} bps slippage. Fees: maker ${c.makerFeeBps} bps, taker ${c.takerFeeBps} bps of notional.`,
  ...(data.kind === "bars"
    ? ["Bar data says what a minute did but not when, so each bar is one event at its close: a market order fills off the last close with a two-tick spread, never off a later open."]
    : []),
  "The strategy's trades do not move later historical prices (no market impact).",
  // Annualising a few hours of minute returns multiplies their noise by 725, so say so when it applies.
  `Sharpe ratio: mean over standard deviation of 1-minute equity changes, times the square root of 525,600 (minutes in a year).${span < 7 * 1_440 * MINUTE_MS ? " A run this short says little about it." : ""}`,
  data.kind === "bars"
    ? `Markouts: the last close ${BAR_MARKOUT_HORIZONS_MS.map((h) => h / MINUTE_MS).join(", ")} minutes after each fill, against the fill's price, in the fill's favour, in bps and weighted by quantity. On bars a fill is priced off a close that stays the price until the next close, so a horizon under a minute would measure only the slippage. They are computed after the run; no strategy sees them.`
    : `Markouts: the last trade price ${MARKOUT_HORIZONS_MS.map((h) => h / 1_000).join(" s, ")} s after each fill, against the fill's price, in the fill's favour, in bps and weighted by quantity. Negative means the fills were followed by moves against them (adverse selection). They are computed after the run; no strategy sees them.`,
  `Where the quotes sat: each limit order's distance from the last trade price when it was decided. Quotes placed within ${NEAR_TOUCH_BPS} bps of it count as at the touch; their share of the maker fill quantity and their markouts show where the fills and the adverse selection came from.`,
  `"After closing" closes the final position with a market order at the end.`,
];
const out = arg("out") ?? fileURLToPath(new URL(`../reports/${basename(dataPath).replace(/\.(aggtrades\.)?(csv|jsonl|ndjson|json)$/i, "")}`, import.meta.url));
mkdirSync(dirname(out), { recursive: true });
// Relative and with forward slashes, so a report reads the same whichever system wrote it.
const shown = (path: string | null) => (path === null ? null : relative(process.cwd(), path).split(sep).join("/"));
// Indented for reading, except the [time, value] pairs of the series, one per line.
const json = JSON.stringify({ data: shown(dataPath), warmup: shown(warmup), crossing, results, windows }, null, 1).replace(/\[\s+(-?[\d.e+-]+|null),\s+(-?[\d.e+-]+|null)\s+\]/g, "[$1,$2]");
writeFileSync(`${out}.json`, `${json}\n`);
writeFileSync(`${out}.html`, htmlReport(results, instrument, notes, windows, quoting ? [`crossing quotes "${crossing}"`] : []));
console.log(`\nwrote ${out}.json and ${out}.html`);
