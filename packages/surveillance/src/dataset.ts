import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LABELS, NOVEL_LABELS } from "./simulator.js";
import { collectSamples, toCsv, type Sample } from "./scenario.js";

// Builds the surveillance training set: one simulated market per seed.
//   pnpm --filter @ome/surveillance dataset -- --seeds=60 --minutes=10 --out=../../services/ai/data/surveillance.csv

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const seeds = Number(arg("seeds", "60"));
const minutes = Number(arg("minutes", "10"));
const out = arg("out", "../../services/ai/data/surveillance.csv");

const start = performance.now();
const samples: Sample[] = [];
for (let seed = 0; seed < seeds; seed++) samples.push(...collectSamples(seed, minutes * 60_000));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, toCsv(samples));

const counts = Object.fromEntries([...LABELS, ...NOVEL_LABELS].map((l) => [l, samples.filter((s) => s.label === l).length]));
console.log(`${samples.length} windows from ${seeds} simulated markets (${minutes} min each) in ${((performance.now() - start) / 1000).toFixed(1)}s`);
console.log(counts);
console.log(`wrote ${out}`);
