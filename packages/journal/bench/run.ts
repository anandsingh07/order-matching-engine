import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStream, type EngineCommand } from "@ome/core";
import { DurableOrderBook, type DurableOptions } from "../src/index.js";

/**
 * Cost of durability: the same command stream through the journal under each
 * fsync policy. `pnpm bench -- --ops=50000`
 */

const ops = Number(process.argv.find((a) => a.startsWith("--ops="))?.split("=")[1] ?? 20_000);
const stream = new CommandStream(42);
const commands: EngineCommand[] = Array.from({ length: ops }, () => stream.next());

function run(label: string, options: DurableOptions, count: number): void {
  const dir = mkdtempSync(join(tmpdir(), "ome-bench-"));
  try {
    const book = DurableOrderBook.open(dir, options);
    const start = process.hrtime.bigint();
    for (let i = 0; i < count; i++) book.apply(commands[i]!);
    book.sync();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    book.close();
    const perSec = Math.round(count / (ms / 1000)).toLocaleString("en-US");
    console.log(`${label.padEnd(24)} ${perSec.padStart(10)} commands/sec  (${count.toLocaleString("en-US")} in ${Math.round(ms)} ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log();
// fsync per command is slow, so it gets a smaller sample.
run("fsync always", { fsync: "always" }, Math.min(ops, 2_000));
run("fsync batch (100)", { fsync: "batch", batchSize: 100 }, ops);
run("fsync batch (1000)", { fsync: "batch", batchSize: 1000 }, ops);
run("fsync never (OS cache)", { fsync: "never" }, ops);
console.log();
