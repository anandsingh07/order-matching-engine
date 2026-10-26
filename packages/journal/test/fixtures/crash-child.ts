import { CommandStream } from "@ome/core";
import { DurableOrderBook } from "../../src/index.js";
import { ENGINES, type EngineName } from "./engines.js";

// Runs a durable book on a seeded command stream until it is killed.
// After every batch it prints the last durable command number, so the parent
// knows exactly what was acknowledged before it pulled the plug.
//
//   node --import tsx crash-child.ts <dir> <seed> <snapshotEvery> [ts|rust]

const [dir, seedArg, snapshotEveryArg, engineArg = "ts"] = process.argv.slice(2);
const snapshotEvery = Number(snapshotEveryArg);
const engine = ENGINES[engineArg as EngineName];
if (engine === undefined) throw new Error(`unknown engine ${engineArg}`);
const book = DurableOrderBook.open(dir!, { fsync: "always", engine });
const stream = new CommandStream(Number(seedArg));
// Resume where the last run stopped.
for (let i = 0; i < book.lastCommand; i++) stream.next();

function batch(): void {
  for (let i = 0; i < 25; i++) {
    book.apply(stream.next());
    if (book.lastCommand % snapshotEvery === 0) book.snapshot();
  }
  process.stdout.write(`${book.durableCommand}\n`);
  // Yield so stdout is flushed to the parent between batches.
  setImmediate(batch);
}

batch();
