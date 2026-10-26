import type { Instrument } from "@ome/client";
import { HELD_TAG, STRATEGY_LABELS } from "./strategies.js";
import type { BacktestResult } from "./types.js";
import type { WindowComparison } from "./windows.js";

// Reports: a plain-text table for the terminal, and one self-contained HTML
// page (inline SVG and a few lines of script, no external files or
// libraries) comparing the strategies of one run.

const DAY_MS = 86_400_000;
const label = (name: string) => STRATEGY_LABELS[name] ?? name;
const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Whether a span crosses midnight UTC, so a time of day alone would not say when. */
const dated = (from: number, to: number) => date(from) !== date(to);
/** "14:30", or "10-24 14:30" when the span it belongs to crosses midnight. */
const when = (ms: number, withDate: boolean) => `${withDate ? `${date(ms).slice(5)} ` : ""}${time(ms).slice(0, 5)}`;
const money = (v: number) => `${v < 0 ? "-" : ""}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fixed = (v: number | null, digits = 2) => (v === null ? "n/a" : v.toFixed(digits));
/** Markouts at every horizon, "1.23 / -0.40 / ..." in bps. */
const markoutText = (r: BacktestResult, separator = " / ", digits = 2) => r.markouts.map((m) => fixed(m.bps, digits)).join(separator);
const whole = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
/** A markout horizon: "10 s", or "15 min" from a minute up. */
const horizon = (ms: number, space = " ") => (ms < 60_000 ? `${ms / 1_000}${space}s` : `${ms / 60_000}${space}min`);
const horizonText = (r: BacktestResult) => r.markouts.map((m) => horizon(m.horizonMs, "")).join("/");
const percent = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(0)}%`);

/** Rows as aligned text: the first column to the left, numbers to the right. */
function textTable(rows: readonly string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  return rows.map((row) => row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("  ")).join("\n");
}

/** The strategies that placed quotes; a taker has nothing to say about where its quotes sat. */
const quoters = (results: readonly BacktestResult[]) => results.filter((r) => r.quotes.placed > 0);
const distanceText = (r: BacktestResult, separator: string) => {
  const d = r.quotes.distanceBps;
  return d === null ? "n/a" : [d.p10, d.median, d.p90].map((v) => v.toFixed(2)).join(separator);
};

/** Quotes that crossed the touch on arrival and took liquidity: how many, and their share of all the fill quantity. */
const tookText = (r: BacktestResult, separator: string) => {
  const m = r.quotes.marketable;
  const all = r.fills.makerQuantity + r.fills.takerQuantity;
  return `${whole(m.orders)}${separator}${percent(all === 0 ? null : m.quantity / all)}`;
};
/** Quotes requote held at the touch instead of crossing (crossing "hold"): how many, and their share of the maker fill quantity. */
const heldText = (r: BacktestResult, separator: string) => {
  const held = r.quotes.tags[HELD_TAG];
  return held === undefined ? `0${separator}n/a` : `${whole(held.orders)}${separator}${percent(held.fillShare)}`;
};

/** One row of numbers per strategy, for the terminal. */
export function summaryTable(results: readonly BacktestResult[], instrument: Instrument): string {
  const qty = (units: number) => (units / instrument.quantityScale).toFixed(3);
  const cur = instrument.currency;
  const first = results[0];
  const rows = [
    [
      "strategy",
      `P&L ${cur}`,
      "after close",
      "return bps",
      "Sharpe (ann.)",
      `max DD ${cur}`,
      "fills (maker/taker)",
      `fees ${cur}`,
      `turnover ${cur}`,
      "mean |inv|",
      "max |inv|",
      `markout ${first === undefined ? "" : horizonText(first)} bps`,
    ],
    ...results.map((r) => [
      r.strategy,
      money(r.pnl.total),
      money(r.pnl.afterClose),
      (r.pnl.return * 10_000).toFixed(2),
      fixed(r.sharpe.annualised, 1),
      money(r.maxDrawdown.amount),
      `${r.fills.count} (${r.fills.maker}/${r.fills.taker})`,
      money(r.pnl.fees),
      money(r.turnover.amount),
      qty(r.inventory.meanAbs),
      qty(r.inventory.maxAbs),
      markoutText(r, "/"),
    ]),
  ];
  return textTable(rows);
}

/** Where each market maker's quotes sat, and what its quotes at the touch did, for the terminal; empty without quotes. */
export function quotesTable(results: readonly BacktestResult[], instrument: Instrument): string {
  const makers = quoters(results);
  const first = makers[0];
  if (first === undefined) return "";
  const near = first.quotes.nearBps;
  const rows = [
    ["strategy", "quotes", "distance p10/median/p90 bps", "took (orders/fill qty)", "held at touch (orders/maker qty)", `maker qty from quotes < ${near} bps`, `their markout ${horizonText(first)} bps`],
    ...makers.map((r) => [
      r.strategy,
      whole(r.quotes.placed),
      distanceText(r, "/"),
      tookText(r, "/"),
      heldText(r, "/"),
      percent(r.quotes.near.fillShare),
      r.quotes.near.markouts.map((m) => fixed(m.bps)).join("/"),
    ]),
  ];
  return `where the quotes sat (distance from the last trade price when each was placed):\n${textTable(rows)}`;
}

const ci = (c: [number, number] | null) => (c === null ? "n/a" : `${money(c[0])} to ${money(c[1])}`);

/** The window-by-window comparison, for the terminal. */
export function windowsTable(w: WindowComparison, instrument: Instrument): string {
  const cur = instrument.currency;
  const rows = [
    ["strategy", `mean P&L ${cur}`, "95% CI", "sd", "positive", `total ${cur}`, "fills/window"],
    ...w.strategies.map((s) => [s.strategy, money(s.mean), ci(s.ci95), money(s.sd), `${s.positive}/${w.windows.length}`, money(s.total), s.meanFills.toFixed(1)]),
  ];
  const table = textTable(rows);
  const versus = w.versusBaseline.map(
    (v) => `  ${v.strategy} - ${w.baseline}: ${money(v.mean)} ${cur} a window (95% CI ${ci(v.ci95)}), better in ${(v.betterShare * 100).toFixed(0)}% of windows`,
  );
  return [`${w.windows.length} windows of ${w.minutes} minutes; P&L after closing each window's position:`, table, `paired, window by window:`, ...versus].join("\n");
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The window comparison as a card: the summary, the paired differences, and every window in a disclosure. */
function windowsCard(w: WindowComparison, instrument: Instrument): string {
  const cur = instrument.currency;
  const withDate = w.windows.length > 0 && dated(w.windows[0]!.from, w.windows.at(-1)!.to);
  const price = (ticks: number | null) => (ticks === null ? "n/a" : (ticks / instrument.priceScale).toLocaleString("en-US"));
  const key = (name: string) => `<span class="key" style="background:var(--s${SLOT[name] ?? 5})"></span>${escape(label(name))}`;
  const head = (cells: string[]) => `<thead><tr>${cells.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead>`;
  const body = (rows: string[][]) => `<tbody>${rows.map((row) => `<tr>${row.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`).join("")}</tbody>`;
  const summary =
    `<table>${head(["Strategy", `Mean P&L per window (${cur})`, "95% CI", "Standard deviation", "Windows above zero", `Total (${cur})`, "Fills per window"])}` +
    body(w.strategies.map((s) => [key(s.strategy), money(s.mean), ci(s.ci95), money(s.sd), `${s.positive} of ${w.windows.length}`, money(s.total), s.meanFills.toFixed(1)])) +
    `</table>`;
  const versus =
    `<table>${head([`Paired against ${label(w.baseline)}`, `Mean difference per window (${cur})`, "95% CI", "Windows better"])}` +
    body(w.versusBaseline.map((v) => [key(v.strategy), money(v.mean), ci(v.ci95), `${(v.betterShare * 100).toFixed(0)}%`])) +
    `</table>`;
  const names = w.strategies.map((s) => s.strategy);
  const each =
    `<table>${head(["Window (UTC)", "Trades", "Price", ...names.map((n) => `${label(n).split(" (")[0]!} (${cur})`)])}` +
    body(w.windows.map((x) => [`${escape(when(x.from, withDate))} to ${escape(when(x.to, withDate && date(x.to) !== date(x.from)))}`, x.trades.toLocaleString("en-US"), `${price(x.firstPrice)} to ${price(x.lastPrice)}`, ...names.map((n) => money(x.pnl[n]!))])) +
    `</table>`;
  return (
    `<section class="card"><h2>Window by window: ${w.windows.length} windows of ${w.minutes} minutes</h2>` +
    `<p class="facts">Each window is a backtest of its own: flat at the start, warmed up with every bar before it, and its position closed with a market order at the end. Every strategy sees the same windows, so the differences are paired. The intervals treat windows as independent; consecutive windows share a market regime, so they are if anything too narrow.</p>` +
    `<div class="table-wrap">${summary}</div><div class="table-wrap" style="margin-top:12px">${versus}</div>` +
    `<details style="margin-top:12px"><summary>Every window</summary><div class="table-wrap">${each}</div></details></section>`
  );
}

/** Where the market makers' quotes sat, and what the ones at the touch did, as a card; empty without quotes. */
function quotesCard(results: readonly BacktestResult[], instrument: Instrument, slotOf: (name: string) => number): string {
  const makers = quoters(results);
  const first = makers[0];
  if (first === undefined) return "";
  const near = first.quotes.nearBps;
  const last = first.data.lastPrice;
  const tick = last === null ? "" : `: one tick is ${((instrument.tickSize / last) * 10_000).toPrecision(2)} bps at the last price`;
  const headers = [
    "Strategy",
    "Quotes placed",
    "Distance from the last price, p10 / median / p90 (bps)",
    "Crossed the touch and took: orders / share of fill quantity",
    "Held at the touch instead: orders / share of maker fill quantity",
    `Maker fill quantity from quotes within ${near} bps`,
    `Their markout ${first.markouts.map((m) => horizon(m.horizonMs)).join(" / ")} (bps)`,
  ];
  const rows = makers.map((r) => [
    `<span class="key" style="background:var(--s${slotOf(r.strategy)})"></span>${escape(label(r.strategy))}`,
    whole(r.quotes.placed),
    distanceText(r, " / "),
    tookText(r, " / "),
    heldText(r, " / "),
    percent(r.quotes.near.fillShare),
    r.quotes.near.markouts.map((m) => fixed(m.bps, 1)).join(" / "),
  ]);
  return (
    `<section class="card"><h2>Where the quotes sat</h2>` +
    `<p class="facts">Each quote's distance from the last trade price when it was placed, on its passive side (below the price for a bid, above it for an ask). Quotes within ${near} bps are at the touch${escape(tick)}. A quote the strategy wanted through the touch either took liquidity on arrival, as the live bots' plain limit orders do, or, with crossing "hold", was posted at the touch instead. The last two columns are what the quotes at the touch did.</p>` +
    `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((row) => `<tr>${row.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`).join("") +
    `</tbody></table></div></section>`
  );
}

/** Every k-th point (and always the last), so a long run stays a light page. */
function thin<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  const k = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % k === 0);
  if ((points.length - 1) % k !== 0) out.push(points.at(-1)!);
  return out;
}

/** Round axis ticks (1, 2 or 5 times a power of ten) whose span covers [lo, hi]. */
function ticks(lo: number, hi: number, target = 5): number[] {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const out: number[] = [];
  const top = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= top + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

// The reference categorical palette, in its validated order; colour follows
// the strategy, never its rank, so a run with fewer strategies keeps its colours.
const SLOT: Record<string, number> = { ladder: 1, as: 2, rl: 3, ma: 4 };

interface Plot {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Horizontal gridlines with their labels, and the baseline. */
function yAxis(p: Plot, yTicks: readonly number[], y: (v: number) => number, format: (v: number) => string): string {
  const parts = yTicks.map(
    (v) =>
      `<line class="grid" x1="${p.left}" x2="${p.width - p.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` +
      `<text class="tick" x="${p.left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${escape(format(v))}</text>`,
  );
  parts.push(`<line class="axis" x1="${p.left}" x2="${p.width - p.right}" y1="${p.height - p.bottom}" y2="${p.height - p.bottom}"/>`);
  return parts.join("");
}

/**
 * UTC time labels on whole minutes, spaced to give about six. From a day
 * apart up they are dates (MM-DD); on a shorter span that crosses midnight,
 * the midnight label is the date, so every label says when it is.
 */
function timeAxis(p: Plot, x0: number, x1: number, x: (t: number) => number): string {
  const span = (x1 - x0) / 60_000;
  const step = ([1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 10_080, 20_160].find((m) => span / m <= 6) ?? 43_200) * 60_000;
  const parts: string[] = [];
  for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) {
    const text = step >= DAY_MS || (dated(x0, x1) && t % DAY_MS === 0) ? date(t).slice(5) : time(t).slice(0, 5);
    parts.push(`<text class="tick" x="${x(t).toFixed(1)}" y="${p.height - p.bottom + 18}" text-anchor="middle">${text}</text>`);
  }
  return parts.join("");
}

/**
 * The comparison page: P&L over time for every strategy (one axis, a legend,
 * direct end labels and a crosshair readout), the price over the same window
 * as a separate chart, the metrics as a table, and the assumptions in words.
 */
export function htmlReport(
  results: readonly BacktestResult[],
  instrument: Instrument,
  notes: readonly string[] = [],
  windows?: WindowComparison,
  /** Facts about the run beyond the engine's config (the CLI adds the crossing mode). */
  extraFacts: readonly string[] = [],
): string {
  const first = results[0];
  if (first === undefined) throw new Error("no results to report");
  const cur = instrument.currency;
  const price = (ticks: number) => ticks / instrument.priceScale;
  const series = results.map((r) => ({
    name: r.strategy,
    label: label(r.strategy),
    slot: SLOT[r.strategy] ?? 5 + (results.filter((o) => SLOT[o.strategy] === undefined).indexOf(r) % 4),
    points: thin(r.equity, 1_500).map(([t, e]) => [t, e - r.config.capital] as [number, number]),
  }));
  const x0 = first.data.from;
  const x1 = Math.max(first.data.to, x0 + 1);
  const all = series.flatMap((s) => s.points.map((p) => p[1]));
  const yt = ticks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = yt[0]!;
  const hi = yt.at(-1)!;

  const p: Plot = { width: 960, height: 340, left: 72, right: 170, top: 16, bottom: 32 };
  const x = (t: number) => p.left + ((t - x0) / (x1 - x0)) * (p.width - p.left - p.right);
  const y = (v: number) => p.top + ((hi - v) / (hi - lo || 1)) * (p.height - p.top - p.bottom);
  const path = (pts: readonly [number, number][]) => pts.map(([t, v], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const lines = series.map((s) => `<path class="line" style="stroke:var(--s${s.slot})" d="${path(s.points)}"><title>${escape(s.label)}</title></path>`).join("");
  // Direct labels at the line ends, nudged apart when they would overlap.
  const ends = series.map((s) => ({ s, y: y(s.points.at(-1)?.[1] ?? 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i]!.y = Math.max(ends[i]!.y, ends[i - 1]!.y + 15);
  const endLabels = ends
    .map(({ s, y: ly }) => {
      const last = s.points.at(-1)!;
      return (
        `<line class="leader" x1="${x(last[0]).toFixed(1)}" y1="${y(last[1]).toFixed(1)}" x2="${(p.width - p.right + 8).toFixed(1)}" y2="${ly.toFixed(1)}"/>` +
        `<circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="4" class="dot" style="fill:var(--s${s.slot})"/>` +
        `<text class="end" x="${p.width - p.right + 12}" y="${(ly + 4).toFixed(1)}">${escape(s.label.split(" (")[0]!)} ${escape(money(last[1]))}</text>`
      );
    })
    .join("");
  const yFormat = (v: number) => (Math.abs(hi - lo) >= 10 ? v.toFixed(0) : v.toFixed(2));
  const pnlChart =
    `<svg class="chart" viewBox="0 0 ${p.width} ${p.height}" role="img" aria-label="P&amp;L over time, ${cur}" tabindex="0" id="pnl">` +
    yAxis(p, yt, y, yFormat) +
    timeAxis(p, x0, x1, x) +
    `<line class="zero" x1="${p.left}" x2="${p.width - p.right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` +
    lines +
    endLabels +
    `<line id="cross" class="cross" x1="0" x2="0" y1="${p.top}" y2="${p.height - p.bottom}" visibility="hidden"/>` +
    `<rect class="hit" x="${p.left}" y="${p.top}" width="${p.width - p.left - p.right}" height="${p.height - p.top - p.bottom}"/>` +
    `</svg>`;

  // The price, as its own chart: a second y-scale on the P&L chart would invent a relationship.
  const pp: Plot = { width: 960, height: 150, left: 72, right: 170, top: 12, bottom: 32 };
  const prices = thin(first.price.filter((q): q is [number, number] => q[1] !== null), 1_500);
  const pv = prices.map((q) => price(q[1]));
  const pt = ticks(Math.min(...pv), Math.max(...pv), 3);
  const py = (v: number) => pp.top + ((pt.at(-1)! - v) / (pt.at(-1)! - pt[0]! || 1)) * (pp.height - pp.top - pp.bottom);
  const px = (t: number) => pp.left + ((t - x0) / (x1 - x0)) * (pp.width - pp.left - pp.right);
  const pricePath = prices.map((q, i) => `${i === 0 ? "M" : "L"}${px(q[0]).toFixed(1)},${py(price(q[1])).toFixed(1)}`).join("");
  const priceChart =
    `<svg class="chart" viewBox="0 0 ${pp.width} ${pp.height}" role="img" aria-label="${escape(first.data.symbol)} last trade price">` +
    yAxis(pp, pt, py, (v) => v.toLocaleString("en-US")) +
    timeAxis(pp, x0, x1, px) +
    `<path class="line" style="stroke:var(--price)" d="${pricePath}"/></svg>`;

  const qty = (units: number) => (units / instrument.quantityScale).toFixed(3);
  const headers = [
    "Strategy",
    `P&L (${cur})`,
    "After closing",
    "Return (bps)",
    "Sharpe, annualised",
    `Max drawdown (${cur})`,
    "Fills (maker / taker)",
    `Fees (${cur})`,
    `Turnover (${cur})`,
    "Mean |inventory|",
    "Max |inventory|",
    `Markout ${first.markouts.map((m) => horizon(m.horizonMs)).join(" / ")} (bps)`,
    "Orders / cancels / rejected",
  ];
  const rows = results.map((r) => [
    `<span class="key" style="background:var(--s${series.find((s) => s.name === r.strategy)!.slot})"></span>${escape(label(r.strategy))}`,
    money(r.pnl.total),
    money(r.pnl.afterClose),
    (r.pnl.return * 10_000).toFixed(2),
    fixed(r.sharpe.annualised, 1),
    money(r.maxDrawdown.amount),
    `${r.fills.count} (${r.fills.maker} / ${r.fills.taker})`,
    money(r.pnl.fees),
    whole(r.turnover.amount),
    qty(r.inventory.meanAbs),
    qty(r.inventory.maxAbs),
    markoutText(r, " / ", 1),
    `<span title="${escape(Object.entries(r.orders.rejected).map(([k, v]) => `${v} ${k}`).join(", ") || "none rejected")}">` +
      `${r.orders.limit + r.orders.market} / ${r.orders.cancels} / ${Object.values(r.orders.rejected).reduce((a, b) => a + b, 0)}</span>`,
  ]);
  const table =
    `<table><thead><tr>${headers.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((row) => `<tr>${row.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`).join("") +
    `</tbody></table>`;

  const c = first.config;
  const legend = series.map((s) => `<span class="legend-item"><span class="line-key" style="background:var(--s${s.slot})"></span>${escape(s.label)}</span>`).join("");
  const multiDay = dated(x0, x1);
  const title = multiDay
    ? `${first.data.symbol} backtest, ${date(x0)} ${time(x0).slice(0, 5)} to ${date(x1)} ${time(x1).slice(0, 5)} UTC`
    : `${first.data.symbol} backtest, ${date(x0)} ${time(x0)} to ${time(x1)} UTC`;
  const facts = [
    `${first.data.events.toLocaleString("en-US")} real ${first.data.kind === "trades" ? "trades" : "1-minute bars"}`,
    `${first.data.warmupBars} warm-up bars`,
    `price ${first.data.firstPrice === null ? "n/a" : price(first.data.firstPrice).toLocaleString("en-US")} to ${first.data.lastPrice === null ? "n/a" : price(first.data.lastPrice).toLocaleString("en-US")}`,
    `latency ${c.latencyMs} ms`,
    `maker fee ${c.makerFeeBps} bps, taker fee ${c.takerFeeBps} bps`,
    `market-order slippage ${c.slippageBps} bps`,
    `queue model "${c.queue}"`,
    `capital ${c.capital.toLocaleString("en-US")} ${cur}`,
    ...extraFacts,
  ];
  const readout = {
    x0,
    x1,
    left: p.left,
    plotWidth: p.width - p.left - p.right,
    width: p.width,
    dated: multiDay,
    series: series.map((s) => ({ label: s.label, slot: s.slot, points: s.points })),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(first.data.symbol)} backtest</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948;
  --price: #52514e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
    --price: #c3c2b7;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  --price: #c3c2b7;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
.facts { color: var(--ink-2); margin: 0 0 20px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; position: relative; }
.chart-wrap { overflow-x: auto; }
.chart { width: 100%; min-width: 640px; height: auto; display: block; overflow: visible; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis, .zero { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dot { stroke: var(--surface); stroke-width: 2; }
.leader { stroke: var(--axis); stroke-width: 1; }
.end { fill: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.cross { stroke: var(--muted); stroke-width: 1; }
.hit { fill: transparent; cursor: crosshair; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; color: var(--ink-2); margin-bottom: 8px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.line-key { width: 14px; height: 2px; border-radius: 1px; display: inline-block; }
.key { width: 10px; height: 10px; border-radius: 2px; display: inline-block; margin-right: 8px; }
#tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); display: none; min-width: 180px; }
#tip .t { color: var(--muted); margin-bottom: 4px; }
#tip .row { display: flex; align-items: center; gap: 8px; }
#tip .row b { font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }
#tip .row span:last-child { color: var(--ink-2); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--grid); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
thead th { color: var(--ink-2); font-weight: 600; white-space: normal; vertical-align: bottom; font-size: 12px; }
th[scope="row"], thead th:first-child { text-align: left; font-weight: 500; }
ul { color: var(--ink-2); padding-left: 20px; margin: 0; }
details summary { cursor: pointer; color: var(--ink-2); margin-bottom: 8px; }
</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
<p class="facts">${facts.map(escape).join(" · ")}</p>
<section class="card">
<h2>P&amp;L over time (${escape(cur)}, marked to the last trade)</h2>
<div class="legend">${legend}</div>
<div class="chart-wrap">${pnlChart}</div>
<div id="tip" role="status" aria-live="polite"></div>
</section>
<section class="card">
<h2>${escape(first.data.symbol)} last trade price (${escape(cur)})</h2>
<div class="chart-wrap">${priceChart}</div>
</section>
<section class="card">
<h2>Results</h2>
<div class="table-wrap">${table}</div>
</section>
${quotesCard(results, instrument, (name) => series.find((s) => s.name === name)!.slot)}
${windows === undefined ? "" : windowsCard(windows, instrument)}
<section class="card">
<h2>How this was simulated</h2>
<ul>${notes.map((n) => `<li>${escape(n)}</li>`).join("")}</ul>
</section>
</main>
<script type="application/json" id="data">${JSON.stringify(readout).replace(/</g, "\\u003c")}</script>
<script>
(() => {
  const d = JSON.parse(document.getElementById("data").textContent);
  const svg = document.getElementById("pnl");
  const cross = document.getElementById("cross");
  const tip = document.getElementById("tip");
  const fmt = (v) => (v < 0 ? "-" : "") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let index = null;
  const nearest = (pts, t) => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid + 1; else hi = mid; }
    return lo > 0 && t - pts[lo - 1][0] < pts[lo][0] - t ? lo - 1 : lo;
  };
  function show(t) {
    const base = d.series[0].points;
    index = nearest(base, t);
    const at = base[index][0];
    const sx = d.left + ((at - d.x0) / (d.x1 - d.x0)) * d.plotWidth;
    cross.setAttribute("x1", sx); cross.setAttribute("x2", sx); cross.setAttribute("visibility", "visible");
    tip.replaceChildren();
    const head = document.createElement("div"); head.className = "t";
    const iso = new Date(at).toISOString();
    head.textContent = (d.dated ? iso.slice(0, 10) + " " + iso.slice(11, 16) : iso.slice(11, 19)) + " UTC"; tip.append(head);
    for (const s of d.series) {
      const p = s.points[nearest(s.points, at)];
      const row = document.createElement("div"); row.className = "row";
      const key = document.createElement("span"); key.className = "line-key"; key.style.background = "var(--s" + s.slot + ")";
      const value = document.createElement("b"); value.textContent = fmt(p[1]);
      const name = document.createElement("span"); name.textContent = s.label;
      row.append(key, value, name); tip.append(row);
    }
    const box = svg.getBoundingClientRect();
    const card = tip.parentElement.getBoundingClientRect();
    const px = box.left - card.left + (sx / d.width) * box.width;
    tip.style.display = "block";
    tip.style.left = Math.min(px + 12, card.width - tip.offsetWidth - 8) + "px";
    tip.style.top = (box.top - card.top + 8) + "px";
  }
  function hide() { cross.setAttribute("visibility", "hidden"); tip.style.display = "none"; }
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * d.width;
    if (vx < d.left || vx > d.left + d.plotWidth) return hide();
    show(d.x0 + ((vx - d.left) / d.plotWidth) * (d.x1 - d.x0));
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    const pts = d.series[0].points;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = Math.max(1, Math.round(pts.length / 60));
    const next = Math.min(pts.length - 1, Math.max(0, (index ?? 0) + (e.key === "ArrowRight" ? step : -step)));
    show(pts[next][0]);
  });
})();
</script>
</body>
</html>
`;
}
