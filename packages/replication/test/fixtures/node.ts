import { CommandStream } from "@ome/core";
import { DurableOrderBook } from "@ome/journal";
import { Primary, Replica, readEpoch } from "../../src/index.js";

// One exchange node for the failover test, run as its own process so it can
// be killed for real.
//
//   node --import tsx node.ts primary <dir> <seed>
//   node --import tsx node.ts replica <dir> <seed> <primaryPort>
//
// A primary trades: it applies the seeded command stream in batches and
// prints "ack <n>" once command n is acknowledged (on disk here and on the
// replica). A replica follows; if its primary dies it promotes itself, prints
// "promoted <epoch> <lastCommand>", and carries on as a primary.
// Every primary prints "listening <port>" for its replica to connect to.

const [role, dir, seedArg, portArg] = process.argv.slice(2);
const seed = Number(seedArg);
const out = (line: string) => process.stdout.write(`${line}\n`);

async function lead(book: DurableOrderBook, epoch: number): Promise<void> {
  const primary = await Primary.start(book, { port: 0, epoch, heartbeatMs: 25 }, () => process.exit(3));
  out(`listening ${primary.port}`);
  // Command n is always the n-th command of the stream, whoever applies it.
  const stream = new CommandStream(seed);
  for (let i = 0; i < book.lastCommand; i++) stream.next();
  for (;;) {
    let last: Promise<void> = Promise.resolve();
    let n = 0;
    for (let i = 0; i < 20; i++) ({ n, acknowledged: last } = primary.apply(stream.next()));
    await last;
    out(`ack ${n}`);
  }
}

if (role === "primary") {
  await lead(DurableOrderBook.open(dir!, { fsync: "batch" }), readEpoch(dir!));
} else {
  Replica.start(dir!, {
    port: Number(portArg),
    failoverMs: 300,
    retryMs: 20,
    onPromote: (book, epoch) => {
      out(`promoted ${epoch} ${book.lastCommand}`);
      void lead(book, epoch);
    },
  });
}
