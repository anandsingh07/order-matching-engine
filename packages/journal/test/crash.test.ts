import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandStream, OrderBook } from "@ome/core";
import { describe, expect, it } from "vitest";
import { DurableOrderBook } from "../src/index.js";
import { ENGINES, type EngineName } from "./fixtures/engines.js";

const child = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "crash-child.ts");

/**
 * Starts the child engine and hard-kills it (no shutdown hooks, no flush)
 * once it has acknowledged at least `target` commands. Resolves with the
 * highest acknowledged command number.
 */
function runUntilKilled(dir: string, seed: number, target: number, engine: EngineName): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", child, dir, String(seed), "333", engine], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let acked = 0;
    let buffered = "";
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) acked = Math.max(acked, Number(line));
      if (acked >= target) proc.kill("SIGKILL");
    });
    proc.on("exit", (_code, signal) => {
      if (signal === "SIGKILL" || acked >= target) resolve(acked);
      else reject(new Error(`child exited early: ${stderr}`));
    });
  });
}

/**
 * Kills the child six times. `childEngine` and `recoveryEngine` give, per
 * round, the engine that writes the directory and the one that recovers it.
 * The expected state always comes from @ome/core's OrderBook.
 */
async function killAndRecover(seed: number, childEngine: (round: number) => EngineName, recoveryEngine: (round: number) => EngineName) {
  const dir = mkdtempSync(join(tmpdir(), "ome-crash-"));
  try {
    let acked = 0;
    for (let round = 1; round <= 6; round++) {
      // Kill at a different, uneven point each round, before and after snapshots.
      acked = await runUntilKilled(dir, seed, acked + 150 + round * 97, childEngine(round));

      const engine = ENGINES[recoveryEngine(round)];
      const recovered = DurableOrderBook.open(dir, { engine });
      expect(recovered.book).toBeInstanceOf(engine);
      expect(recovered.lastCommand).toBeGreaterThanOrEqual(acked);

      const expected = new OrderBook();
      const stream = new CommandStream(seed);
      for (let i = 0; i < recovered.lastCommand; i++) expected.apply(stream.next());
      expect(recovered.book.snapshot()).toEqual(expected.snapshot());
      recovered.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(Object.keys(ENGINES) as EngineName[])("crash recovery (%s engine)", (engine) => {
  it(
    "recovers every acknowledged command after repeated hard kills",
    () => killAndRecover(11, () => engine, () => engine),
    120_000,
  );
});

describe("crash recovery across engines", () => {
  it(
    "recovers a directory with the other engine after each hard kill, switching every round",
    // Odd rounds run TypeScript and recover with Rust; even rounds the reverse.
    () => killAndRecover(13, (round) => (round % 2 === 1 ? "ts" : "rust"), (round) => (round % 2 === 1 ? "rust" : "ts")),
    120_000,
  );
});
