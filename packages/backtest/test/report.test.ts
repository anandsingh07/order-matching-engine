import { describe, expect, it } from "vitest";
import { htmlReport, quotesTable, runBacktest, summaryTable, type BacktestResult } from "../src/index.js";
import { scripted, t, tape, TOY } from "./helpers.js";

async function results(): Promise<BacktestResult[]> {
  const data = tape(t(0, 100, 1, "buy"), t(30_000, 90, 5, "sell"), t(90_000, 104, 5, "buy"), t(120_000, 101, 1, "sell"));
  const maker = scripted({ 0: (ctx) => ctx.placeLimit("buy", 95, 2) });
  // A name that would break the page if anything were not escaped.
  const hostile = { ...scripted({ 0: (ctx) => ctx.marketOrder("sell", 1) }), name: '</script><img src=x onerror="alert(1)">' };
  const config = { instrument: TOY, capital: 1_000, latencyMs: 0, slippageBps: 0 };
  return [(await runBacktest(maker, data, config)).result, (await runBacktest(hostile, data, config)).result];
}

describe("reports", () => {
  it("writes one self-contained page: inline SVG, no external files, everything escaped", async () => {
    const html = htmlReport(await results(), TOY, ['Notes are text, & "escaped"']);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<svg class="chart"');
    expect(html).not.toMatch(/<link|@import|src="http|href="http|<script src/);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&#60;/script&#62;&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
    // The chart data travels as JSON in a script tag, so "<" must not survive raw.
    const json = html.slice(html.indexOf('id="data">') + 10, html.indexOf("</script>", html.indexOf('id="data">')));
    expect(json).not.toContain("<");
    expect(JSON.parse(json).series[1].label).toContain("</script>");
    expect(html).toContain("Notes are text, &#38; &#34;escaped&#34;");
  });

  it("puts each strategy's numbers in the table and the terminal summary", async () => {
    const [maker, hostile] = await results();
    // The bid at 95 fills at 30 s, and the print at 101 marks it: +12.
    expect(maker!.pnl.total).toBe(12);
    const table = summaryTable([maker!, hostile!], TOY);
    expect(table.split("\n")).toHaveLength(3);
    expect(table.split("\n")[1]).toMatch(/^scripted\s+12\.00\s+/);
    expect(htmlReport([maker!], TOY)).toContain("<td>12.00</td>");
  });

  it("shows where the market makers' quotes sat, and leaves takers out", async () => {
    const [maker, hostile] = await results();
    // The bid at 95, placed with the last price at 100: 500 bps behind it, so not at the touch.
    expect(maker!.quotes.distanceBps).toEqual({ p10: 500, median: 500, p90: 500 });
    const lines = quotesTable([maker!, hostile!], TOY).split("\n");
    expect(lines).toHaveLength(3); // the title, the header and the one maker
    // Placed, distances, none took liquidity (0 of the fills), none held at the touch, 0% of fills at the touch.
    expect(lines[2]).toMatch(/^scripted\s+1\s+500\.00\/500\.00\/500\.00\s+0\/0%\s+0\/n\/a\s+0%\s/);
    expect(quotesTable([hostile!], TOY)).toBe("");
    const html = htmlReport([maker!, hostile!], TOY);
    expect(html).toContain("Where the quotes sat");
    expect(htmlReport([hostile!], TOY)).not.toContain("Where the quotes sat");
  });

  it("dates its times when a run crosses midnight, and labels bar markouts in minutes", async () => {
    const DAY = 86_400_000;
    const start = Date.UTC(2026, 6, 26, 20, 34);
    // Ninety days of bars, a close a day: the axis, title and readout must say which day.
    const bars = Array.from({ length: 90 }, (_, i) => ({ time: start + i * DAY, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1 }));
    const { result } = await runBacktest(scripted({ [start + DAY]: (ctx) => void ctx.marketOrder("buy", 1) }), { kind: "bars", symbol: "TOY", bars, warmup: [] }, { instrument: TOY, capital: 1_000, latencyMs: 0 });
    expect(result.markouts.map((m) => m.horizonMs)).toEqual([60_000, 300_000, 900_000]);
    const html = htmlReport([result], TOY);
    expect(html).toContain("<h1>TOY backtest, 2026-07-26 20:34 to 2026-10-23 20:35 UTC</h1>");
    const labels = [...html.matchAll(/<text class="tick" x="[\d.]+" y="[\d.]+" text-anchor="middle">([^<]*)<\/text>/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(2);
    for (const l of labels) expect(l).toMatch(/^\d\d-\d\d$/);
    expect(new Set(labels).size).toBe(labels.length / 2); // the same dates under both charts
    expect(html).toContain("Markout 1 min / 5 min / 15 min (bps)");
    expect(JSON.parse(html.slice(html.indexOf('id="data">') + 10, html.indexOf("</script>", html.indexOf('id="data">')))).dated).toBe(true);
    // A run within one day keeps its times of day.
    const [maker] = await results();
    expect(htmlReport([maker!], TOY)).toContain("<h1>TOY backtest, 1970-01-01 00:00:00 to 00:02:00 UTC</h1>");
  });
});
