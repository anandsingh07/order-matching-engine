// Measures every parser on the labelled phrasings: per-field accuracy,
// full-order exact match, "unclear" detection, wrong proposals, latency.
//
//   pnpm --filter @ome/nl-orders eval                                  # dev, holdout, fresh and review; rules and every installed model
//   pnpm --filter @ome/nl-orders eval -- --set=holdout --models=qwen2.5:3b --verbose
//   pnpm --filter @ome/nl-orders eval -- --json=results.json           # per-case results, for a closer look
//
// Requests run one at a time, as a single user would send them, after one
// untimed warm-up request per model (the cold load is reported separately).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_OLLAMA_URL, parseOrder, toProposal, type MarketInstrument, type ParseMode, type ParseResult } from "../src/index.ts";
import { FIELDS, scoreCase, summarize, type CaseScore, type FixtureSet, type Summary } from "./score.ts";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k!, v ?? "true"] as const;
  }),
);
const fixtures = (name: string) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));
const instruments = JSON.parse(readFileSync(fixtures("instruments.json"), "utf8")) as MarketInstrument[];
const sets = (args.get("set") ?? "dev,holdout,fresh,review").split(",");
const url = args.get("url") ?? DEFAULT_OLLAMA_URL;
/** Generous, so slow answers are measured rather than cut off; the production default is 15 s. */
const timeoutMs = Number(args.get("timeout") ?? 60_000);
/** p95 latency a setup must stay under to be the default: over all its answers, and over the model's answers alone. */
const LATENCY_BUDGET_MS = 3000;
/**
 * The default is chosen here, by the rule fixed before this set was first
 * run. It is no longer untouched: validate.ts's bracket check came from a
 * holdout failure, and the review fixes (typo matching across words,
 * "every") changed two of its answers. fresh.json is the later check;
 * review.json holds the failures the review found, so the code was fixed to
 * pass it and it only shows they stay fixed.
 */
const SELECTION_SET = "holdout";

async function installedModels(): Promise<string[]> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

const installed = await installedModels();
const wanted = (args.get("models") ?? "qwen2.5:1.5b,qwen2.5:3b").split(",").filter((m) => m !== "");
const models = wanted.filter((m) => installed.includes(m));
for (const m of wanted.filter((m) => !installed.includes(m))) {
  console.log(installed.length === 0 ? `Ollama is not reachable at ${url}: skipping ${m}` : `${m} is not installed (ollama pull ${m}): skipping`);
}
const modes = (args.get("modes") ?? "rules,llm,hybrid").split(",") as ParseMode[];

interface Setup {
  name: string;
  mode: ParseMode;
  model?: string;
}
const setups: Setup[] = [];
if (modes.includes("rules")) setups.push({ name: "rules", mode: "rules" });
for (const model of models) {
  if (modes.includes("llm")) setups.push({ name: model, mode: "llm", model });
  if (modes.includes("hybrid")) setups.push({ name: `hybrid (rules + ${model})`, mode: "hybrid", model });
}

const coldStarts = new Map<string, number>();
async function warmUp(model: string) {
  const warm = () => parseOrder("buy 1 share of the first instrument", instruments, { mode: "llm", model, url, timeoutMs: 120_000, fallback: false });
  if (!coldStarts.has(model)) {
    // Unload first, so the first warm-up measures a real cold start (load + first answer).
    await fetch(`${url}/api/generate`, { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => undefined);
    coldStarts.set(model, (await warm()).latencyMs);
    return;
  }
  // Again before every later setup: with little free memory Ollama unloads
  // one model to load the other, and the first timed request would otherwise
  // be a cold load hidden in the latencies.
  await warm();
}

/**
 * The same answer without the text check (ground.ts): what the model's
 * reading alone would have proposed. Validation still runs; only the
 * comparison with the text is left out. No second model call.
 */
function unchecked(r: ParseResult): ParseResult {
  if (r.kind === "error" || r.source !== "llm") return r;
  const { fields, source, model, latencyMs } = r;
  return { ...toProposal(fields, instruments), fields, source, model, latencyMs };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const ms = (x: number) => `${Math.round(x)} ms`;
interface Run {
  set: string;
  setup: Setup;
  summary: Summary;
  scores: CaseScore[];
  /** For setups that use the model: the same answers scored without the text check. */
  raw: CaseScore[];
}
const results: Run[] = [];

for (const set of sets) {
  const data = JSON.parse(readFileSync(fixtures(`${set}.json`), "utf8")) as FixtureSet;
  for (const setup of setups) {
    if (setup.model !== undefined) await warmUp(setup.model);
    const scores: CaseScore[] = [];
    const raw: CaseScore[] = [];
    for (const c of data.cases) {
      // fallback: false, so a model failure counts as a failure instead of quietly becoming a rules answer.
      const r = await parseOrder(c.text, instruments, { mode: setup.mode, model: setup.model, url, timeoutMs, fallback: false });
      scores.push(scoreCase(c, r, instruments));
      raw.push(scoreCase(c, unchecked(r), instruments));
    }
    const summary = summarize(scores);
    results.push({ set, setup, summary, scores, raw });
    const m = summary.modelLatency;
    console.log(
      `${set.padEnd(8)} ${setup.name.padEnd(30)} exact ${pct(summary.exact).padStart(6)}  orders ${pct(summary.orderExact).padStart(6)}  ` +
        `unclear recall ${pct(summary.unclearRecall).padStart(6)}  wrong proposals ${String(summary.wrongProposalCount).padStart(2)}  ` +
        `p50 ${ms(summary.latency.p50).padStart(8)}  p95 ${ms(summary.latency.p95).padStart(8)}` +
        (setup.mode === "hybrid"
          ? `  (model used for ${m.count}/${scores.length}: p50 ${ms(m.p50)}, p95 ${ms(m.p95)}, max ${ms(m.max)})`
          : ""),
    );
    if (args.has("verbose")) {
      for (const [k, s] of scores.entries()) {
        if (s.exact) continue;
        const before = raw[k]!;
        const note = before.detail === s.detail ? "" : `   [model alone: ${before.detail}]`;
        console.log(`    x [${s.expected} -> ${s.got}, ${s.source}] ${s.text}  =>  ${s.detail}${note}`);
      }
    }
  }
}

console.log("\nPer-field accuracy on order phrasings (fields as extracted, before validation):");
console.log(`${"set".padEnd(8)} ${"setup".padEnd(30)} ${FIELDS.map((f) => f.padStart(12)).join("")}`);
for (const r of results) console.log(`${r.set.padEnd(8)} ${r.setup.name.padEnd(30)} ${FIELDS.map((f) => pct(r.summary.fieldAccuracy[f]).padStart(12)).join("")}`);

console.log("\nSummary:");
for (const r of results) {
  const s = r.summary;
  console.log(
    `${r.set.padEnd(8)} ${r.setup.name.padEnd(30)} cases ${s.cases} (${s.counts.order} orders, ${s.counts.cancel} cancels, ${s.counts.unclear} unclear)  ` +
      `cancel exact ${pct(s.cancelExact)}  false unclear ${pct(s.falseUnclear)}  max ${ms(s.latency.max)}`,
  );
}
for (const [model, t] of coldStarts) console.log(`cold start (load + first answer) ${model}: ${ms(t)}`);

// What the text check did to the model's answers: wrong proposals it
// stopped, and right ones it turned into "unclear".
const modelRuns = results.filter((r) => r.setup.model !== undefined);
if (modelRuns.length > 0) {
  console.log("\nThe text check (ground.ts: the model's numbers, side, instrument, order type and time in force must be backed by the text):");
  for (const r of modelRuns) {
    const before = summarize(r.raw);
    const stopped = r.raw.filter((s, k) => s.wrongProposal && !r.scores[k]!.wrongProposal).length;
    const cost = r.raw.filter((s, k) => s.exact && !r.scores[k]!.exact).length;
    console.log(
      `${r.set.padEnd(8)} ${r.setup.name.padEnd(30)} without it: exact ${pct(before.exact).padStart(6)}, wrong proposals ${String(before.wrongProposalCount).padStart(2)}  ` +
        `| with it: exact ${pct(r.summary.exact).padStart(6)}, wrong proposals ${String(r.summary.wrongProposalCount).padStart(2)}  ` +
        `| stopped ${stopped}, cost ${cost}`,
    );
  }
}

// The default: the most accurate setup on the selection set whose p95
// latency fits the budget; ties go to fewer wrong proposals, then speed.
// The budget holds for the model's answers alone too: hybrid's overall p95
// mostly counts rules answers that take no time (score.ts, modelLatency).
const selectOn = sets.includes(SELECTION_SET) ? [SELECTION_SET] : sets;
const pooled = setups.map((setup) => ({ setup, summary: summarize(results.filter((r) => r.setup === setup && selectOn.includes(r.set)).flatMap((r) => r.scores)) }));
const fits = (s: Summary) => s.latency.p95 <= LATENCY_BUDGET_MS && s.modelLatency.p95 <= LATENCY_BUDGET_MS;
const eligible = pooled.filter((p) => fits(p.summary));
type Ranked = (typeof pooled)[number];
const better = (a: Ranked, b: Ranked) =>
  b.summary.exact - a.summary.exact || a.summary.wrongProposalCount - b.summary.wrongProposalCount || a.summary.latency.p95 - b.summary.latency.p95;
const best = [...eligible].sort(better)[0];
// The model a caller gets on asking for "llm" or "hybrid": the one whose
// hybrid setup ranks first by the same order, latency budget or not, since
// asking for the model is accepting its latency.
const bestModel = [...pooled].filter((p) => p.setup.mode === "hybrid").sort(better)[0]?.setup.model;
console.log(
  `\nRule: highest exact match on ${selectOn.join(" + ")} with p95 latency <= ${LATENCY_BUDGET_MS} ms, overall and for the model's answers alone; ties: fewer wrong proposals, then lower p95.`,
);
for (const p of pooled) {
  console.log(
    `  ${p.setup.name.padEnd(30)} exact ${pct(p.summary.exact).padStart(6)}  wrong proposals ${String(p.summary.wrongProposalCount).padStart(2)}  ` +
      `p95 ${ms(p.summary.latency.p95).padStart(8)}  model answers p95 ${ms(p.summary.modelLatency.p95).padStart(8)}  ${fits(p.summary) ? "eligible" : "too slow"}`,
  );
}
console.log(best === undefined ? "No setup meets the latency budget." : `Default: ${best.setup.name}`);
if (bestModel !== undefined) console.log(`Model when the model is asked for: ${bestModel}`);

const out = args.get("json");
if (out !== undefined) {
  writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), coldStarts: Object.fromEntries(coldStarts), results }, null, 2));
  console.log(`Per-case results written to ${out}`);
}
