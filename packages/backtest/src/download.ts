import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { aggTradesCsv, downloadAggTrades, downloadKlines, klinesCsv, MINUTE_MS } from "./data.js";

// Downloads real Binance trades for a backtest, plus 1-minute klines from
// before them to warm up the volatility forecaster (its features look back
// 240 minutes) and bar strategies.
//
//   pnpm --filter @ome/backtest download -- --start=2026-10-23T14:30:00Z --minutes=30 --out=test/fixtures/btcusdt-2026-10-23T1430Z.aggtrades.csv
//   options: --symbol=BTCUSDT --warmup-minutes=240
//
// Writes <name>.aggtrades.csv and <name>.klines.csv (warm-up and the period
// itself); the backtest CLI picks the klines file up as warm-up on its own.

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const symbol = (arg("symbol") ?? "BTCUSDT").toUpperCase();
const startText = arg("start");
if (startText === undefined) throw new Error("--start=<ISO time> is required, e.g. --start=2026-10-23T14:30:00Z");
const start = Date.parse(startText);
if (Number.isNaN(start)) throw new Error(`cannot read --start=${startText}`);
const end = start + Number(arg("minutes") ?? 30) * MINUTE_MS;
const warmupMinutes = Number(arg("warmup-minutes") ?? 240);
const out = arg("out") ?? `${symbol.toLowerCase()}-${new Date(start).toISOString().slice(0, 16).replace(/[-:]/g, "")}Z.aggtrades.csv`;
if (!out.endsWith(".aggtrades.csv")) throw new Error("--out must end in .aggtrades.csv (the klines go next to it)");

const log = (line: string) => console.log(line);
const trades = await downloadAggTrades(symbol, start, end, { log });
const klines = await downloadKlines(symbol, start - warmupMinutes * MINUTE_MS, end, { log });
mkdirSync(dirname(out), { recursive: true });
const tradesCsv = aggTradesCsv(trades);
writeFileSync(out, tradesCsv);
const klinesOut = out.replace(/\.aggtrades\.csv$/, ".klines.csv");
writeFileSync(klinesOut, klinesCsv(klines));
const first = trades[0];
const last = trades.at(-1);
console.log(`wrote ${trades.length} trades (${(tradesCsv.length / 1e6).toFixed(2)} MB) to ${out}`);
if (first !== undefined && last !== undefined) {
  console.log(`  ${new Date(first.T).toISOString()} to ${new Date(last.T).toISOString()}, ids ${first.a}-${last.a} (no gaps)`);
}
console.log(`wrote ${klines.length} one-minute klines to ${klinesOut}`);
