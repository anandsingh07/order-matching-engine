import { MINUTE_MS, tapeBars } from "./data.js";
import type { BacktestResult, MarketData } from "./types.js";

// One window of real data says more about the window than about the
// strategies: a trend, a quiet hour or one sweep can decide it. So a long
// tape is also cut into consecutive windows, each a backtest of its own
// (flat start, the position closed at the end), and the strategies are
// compared window by window. Every strategy sees the same windows, so the
// differences are paired, as in the RL evaluation (services/ai/rl) and the
// live head-to-head (services/bots/src/compare.ts).

/**
 * Cuts a tape into consecutive windows of `minutes`, on whole minutes. Each
 * is warmed up with every bar that closed before it (the data's warm-up,
 * then the tape's own minute bars), so the volatility forecast in a window
 * is what it would have been live. A final window the tape does not reach
 * the last minute of is left out.
 */
export function splitWindows(data: MarketData, minutes: number): MarketData[] {
  if (data.kind !== "trades") throw new Error("windows need a tape of trades");
  if (!Number.isSafeInteger(minutes) || minutes <= 0) throw new Error(`invalid window length ${minutes}`);
  const { trades } = data;
  const first = trades[0];
  const last = trades.at(-1);
  if (first === undefined || last === undefined) return [];
  const length = minutes * MINUTE_MS;
  const bars = [...data.warmup, ...tapeBars(trades, last.time + MINUTE_MS)];
  const out: MarketData[] = [];
  let i = 0;
  for (let from = Math.floor(first.time / MINUTE_MS) * MINUTE_MS; from + length - MINUTE_MS <= last.time; from += length) {
    const start = i;
    while (i < trades.length && trades[i]!.time < from + length) i++;
    if (i === start) continue;
    out.push({ kind: "trades", symbol: data.symbol, trades: trades.slice(start, i), warmup: bars.filter((b) => b.time + MINUTE_MS <= from) });
  }
  return out;
}

// Two-sided 95% quantiles of Student's t for 1-30 degrees of freedom.
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

/** The 97.5% quantile of Student's t: the table, then the Cornish-Fisher expansion (accurate to 0.001 beyond 30). */
export function tQuantile975(df: number): number {
  if (df < 1) return Infinity;
  const tabled = T975[Math.floor(df) - 1];
  if (tabled !== undefined) return tabled;
  const z = 1.959964;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

/** Mean and a 95% confidence interval for it (Student's t, sample standard deviation). */
export function meanWithCi(xs: readonly number[]): { mean: number; sd: number; ci95: [number, number] | null } {
  const n = xs.length;
  const mean = n === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { mean, sd: 0, ci95: null };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const half = (tQuantile975(n - 1) * sd) / Math.sqrt(n);
  return { mean, sd, ci95: [mean - half, mean + half] };
}

export interface WindowComparison {
  minutes: number;
  /** The P&L compared: after closing each window's final position with a market order. */
  measure: "afterClose";
  baseline: string;
  windows: { from: number; to: number; trades: number; firstPrice: number | null; lastPrice: number | null; pnl: Record<string, number>; fills: Record<string, number> }[];
  strategies: {
    strategy: string;
    mean: number;
    sd: number;
    ci95: [number, number] | null;
    total: number;
    /** Windows with a P&L above zero. */
    positive: number;
    meanFills: number;
  }[];
  /** Each strategy minus the baseline, window by window. */
  versusBaseline: { strategy: string; mean: number; ci95: [number, number] | null; betterShare: number }[];
}

/** Compares strategies window by window; `runs[w]` holds every strategy's result on window `w`. */
export function compareWindows(runs: readonly (readonly BacktestResult[])[], minutes: number, baseline?: string): WindowComparison {
  const names = runs[0]?.map((r) => r.strategy) ?? [];
  const base = baseline !== undefined && names.includes(baseline) ? baseline : (names[0] ?? "");
  const windows = runs.map((rs) => {
    const d = rs[0]!.data;
    return {
      from: d.from,
      to: d.to,
      trades: d.events,
      firstPrice: d.firstPrice,
      lastPrice: d.lastPrice,
      pnl: Object.fromEntries(rs.map((r) => [r.strategy, r.pnl.afterClose])),
      fills: Object.fromEntries(rs.map((r) => [r.strategy, r.fills.count])),
    };
  });
  const pnlOf = (name: string) => windows.map((w) => w.pnl[name]!);
  const strategies = names.map((strategy) => {
    const pnl = pnlOf(strategy);
    return {
      strategy,
      ...meanWithCi(pnl),
      total: pnl.reduce((s, x) => s + x, 0),
      positive: pnl.filter((x) => x > 0).length,
      meanFills: windows.reduce((s, w) => s + w.fills[strategy]!, 0) / Math.max(1, windows.length),
    };
  });
  const basePnl = pnlOf(base);
  const versusBaseline = names
    .filter((n) => n !== base)
    .map((strategy) => {
      const diff = pnlOf(strategy).map((x, i) => x - basePnl[i]!);
      const { mean, ci95 } = meanWithCi(diff);
      return { strategy, mean, ci95, betterShare: diff.filter((d) => d > 0).length / Math.max(1, diff.length) };
    });
  return { minutes, measure: "afterClose", baseline: base, windows, strategies, versusBaseline };
}
