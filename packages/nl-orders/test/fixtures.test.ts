import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedOrder, scoreCase, summarize, type FixtureSet } from "../eval/score.ts";
import { parseOrder, type MarketInstrument } from "../src/index.ts";

// The labelled phrasings are themselves checked: a mislabelled case would
// silently distort every accuracy number in the README.

const read = <T>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const instruments = read<MarketInstrument[]>("instruments.json");
const sets = { dev: read<FixtureSet>("dev.json"), holdout: read<FixtureSet>("holdout.json"), fresh: read<FixtureSet>("fresh.json"), review: read<FixtureSet>("review.json") };
/**
 * Exact answers by the rules, measured with eval/run.ts on the final code;
 * any drop is a regression in the rules. Counts, not shares: a share of
 * 0.87 let holdout lose one of its 76 without failing.
 */
const RULES_EXACT: Record<string, number> = { dev: 86, holdout: 77, fresh: 55, review: 53 };
/** Minimum orders, cancels, unclear and cases per set. Fresh is a smaller, later check; review holds the review's failures, mostly unclear. */
const COVERAGE: Record<string, [number, number, number, number]> = { dev: [20, 3, 10, 80], holdout: [20, 3, 10, 80], fresh: [20, 3, 10, 50], review: [10, 3, 30, 50] };

describe.each(Object.entries(sets))("labelled phrasings: %s", (name, set) => {
  it("are well formed: every order label is a valid order on its instrument", () => {
    for (const c of set.cases) {
      const e = c.expect;
      if (e.kind !== "order") continue;
      const instrument = instruments.find((i) => i.symbol === e.symbol);
      expect(instrument, c.text).toBeDefined();
      const order = expectedOrder(e, instrument!);
      const prices = [order.type === "limit" ? order.price : undefined, order.type === "stop" ? order.stopPrice : undefined, order.type === "stop" ? order.limitPrice : undefined];
      for (const p of prices) if (p !== undefined) expect(p % instrument!.tickSize, c.text).toBe(0);
      expect(order.quantity % instrument!.lotSize, c.text).toBe(0);
      expect(order.quantity, c.text).toBeGreaterThan(0);
    }
    expect(new Set(set.cases.map((c) => c.text)).size, "no duplicates").toBe(set.cases.length);
  });

  it("cover orders, cancels and unclear requests", () => {
    const kinds = set.cases.map((c) => c.expect.kind);
    const [orders, cancels, unclear, size] = COVERAGE[name]!;
    expect(kinds.filter((k) => k === "order").length).toBeGreaterThan(orders);
    expect(kinds.filter((k) => k === "cancel").length).toBeGreaterThan(cancels);
    expect(kinds.filter((k) => k === "unclear").length).toBeGreaterThan(unclear);
    expect(set.cases.length).toBeGreaterThanOrEqual(size);
  });

  it("the rule-based parser still scores what the README reports, and never proposes a wrong order", async () => {
    const scores = [];
    for (const c of set.cases) scores.push(scoreCase(c, await parseOrder(c.text, instruments, { mode: "rules" }), instruments));
    expect(scores.filter((s) => s.exact).length).toBeGreaterThanOrEqual(RULES_EXACT[name]!);
    expect(summarize(scores).wrongProposalCount).toBe(0);
  });
});
