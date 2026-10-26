// One phrase through every parser, live, to see what each one makes of it:
//
//   pnpm --filter @ome/nl-orders try -- "buy 10 tata consultancy at 4100"
//   pnpm --filter @ome/nl-orders try -- --models=qwen2.5:3b "sell 3 tcs if it falls to 4000"
//   pnpm --filter @ome/nl-orders try -- --gateway=http://127.0.0.1:8080 "buy 5 infy"   # live instruments and prices
//
// For each setup it prints the proposal (or why it is unclear), what the model
// itself answered, and how long it took. Nothing is ever sent to an exchange.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Instrument, MarketStatus } from "@ome/client";
import { DEFAULT_OLLAMA_URL, parseOrder, type MarketInstrument, type ParseMode, type ParseResult } from "../src/index.ts";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const flags = new Map(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=") as [string, string?]).map(([k, v]) => [k, v ?? "true"] as const));
const text = argv.filter((a) => !a.startsWith("--")).join(" ");
if (text === "") {
  console.log('Usage: pnpm --filter @ome/nl-orders try -- "buy 10 tata consultancy at 4100"');
  process.exit(1);
}
const url = flags.get("url") ?? DEFAULT_OLLAMA_URL;

/** The gateway's spot instruments with their current prices, or the evaluation's fixed list. */
async function instruments(): Promise<MarketInstrument[]> {
  const gateway = flags.get("gateway");
  if (gateway === undefined) {
    return JSON.parse(readFileSync(fileURLToPath(new URL("../test/fixtures/instruments.json", import.meta.url)), "utf8")) as MarketInstrument[];
  }
  const [list, status] = await Promise.all([
    fetch(`${gateway}/api/instruments`).then((r) => r.json() as Promise<Instrument[]>),
    fetch(`${gateway}/api/status`).then((r) => r.json() as Promise<MarketStatus[]>),
  ]);
  const price = new Map(status.map((s) => [s.symbol, s.referencePrice]));
  return list.filter((i) => (i.kind ?? "spot") === "spot").map((i) => ({ ...i, lastPrice: price.get(i.symbol) ?? i.referencePrice }));
}

async function installed(): Promise<string[]> {
  try {
    const body = (await (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

function show(name: string, r: ParseResult) {
  console.log(`\n${name}  (${Math.round(r.latencyMs)} ms)`);
  if (r.kind === "error") return console.log(`  error: ${r.message}`);
  if (r.kind === "order") {
    console.log(`  PROPOSE: ${r.summary}`);
    console.log(`  wire:    ${JSON.stringify({ symbol: r.symbol, order: r.order })}`);
    for (const w of r.warnings) console.log(`  warning: ${w}`);
  } else console.log(r.kind === "cancel" ? `  PROPOSE: ${r.summary}` : `  UNCLEAR: ${r.summary}`);
  if (r.source === "llm") {
    const { explanation: _written, ...said } = r.fields;
    console.log(`  the model said: ${JSON.stringify(said)}`);
  }
  if (r.fallback !== undefined) console.log(`  (the rules answered: ${r.fallback})`);
}

const list = await instruments();
const wanted = (flags.get("models") ?? "qwen2.5:1.5b,qwen2.5:3b").split(",").filter((m) => m !== "");
const have = await installed();
const models = wanted.filter((m) => have.includes(m));
if (models.length < wanted.length) console.log(have.length === 0 ? `Ollama is not reachable at ${url}: rules only.` : `Not installed: ${wanted.filter((m) => !have.includes(m)).join(", ")}`);
console.log(`"${text}"  (${list.length} instruments${flags.has("gateway") ? ", live prices" : ""})`);

show("rules", await parseOrder(text, list, { mode: "rules" }));
for (const model of models) {
  for (const mode of ["llm", "hybrid"] as const satisfies readonly ParseMode[]) {
    // A first call may load the model from disk, hence the long timeout.
    show(mode === "llm" ? model : `hybrid (rules + ${model})`, await parseOrder(text, list, { mode, model, url, timeoutMs: 120_000, fallback: false }));
  }
}
