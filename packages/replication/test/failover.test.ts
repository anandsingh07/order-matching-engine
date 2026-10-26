import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandStream, OrderBook } from "@ome/core";
import { DurableOrderBook } from "@ome/journal";
import { describe, expect, it } from "vitest";
import { readEpoch } from "../src/index.js";

const script = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "node.ts");
const SEED = 21;

/** A node process, with every line it has printed, and the highest command it has acknowledged. */
class Node {
  readonly proc: ChildProcess;
  private readonly output: string[] = [];
  private stderr = "";
  acked = 0;
  private readonly exited: Promise<void>;

  constructor(
    readonly dir: string,
    args: string[],
  ) {
    this.proc = spawn(process.execPath, ["--import", "tsx", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let buffered = "";
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) {
        this.output.push(line);
        const ack = /^ack (\d+)$/.exec(line);
        if (ack) this.acked = Math.max(this.acked, Number(ack[1]));
      }
    });
    this.proc.stderr!.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.exited = new Promise((resolve) => this.proc.on("exit", () => resolve()));
  }

  /** Waits for a printed line matching `pattern` (already printed counts too). */
  async line(pattern: RegExp, timeoutMs = 10_000): Promise<RegExpExecArray> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      for (const l of this.output) {
        const m = pattern.exec(l);
        if (m) return m;
      }
      if (Date.now() > end) throw new Error(`no line matching ${pattern} from ${this.dir}; stderr: ${this.stderr}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async ackedAtLeast(n: number, timeoutMs = 15_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.acked < n) {
      if (Date.now() > end) throw new Error(`stuck at ack ${this.acked}, wanted ${n}; stderr: ${this.stderr}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async kill(): Promise<void> {
    this.proc.kill("SIGKILL");
    await this.exited;
  }
}

function expectReplayOf(dir: string): number {
  const book = DurableOrderBook.open(dir);
  const expected = new OrderBook();
  const stream = new CommandStream(SEED);
  for (let i = 0; i < book.lastCommand; i++) expected.apply(stream.next());
  expect(book.book.snapshot()).toEqual(expected.snapshot());
  const n = book.lastCommand;
  book.close();
  return n;
}

describe("failover", () => {
  it(
    "survives the primary being killed, again and again, without losing an acknowledged command",
    async () => {
      const dirs = [mkdtempSync(join(tmpdir(), "ome-node-a-")), mkdtempSync(join(tmpdir(), "ome-node-b-"))];
      const nodes: Node[] = [];
      try {
        let primary = new Node(dirs[0]!, ["primary", dirs[0]!, String(SEED)]);
        const port = (await primary.line(/^listening (\d+)$/))[1]!;
        let replica = new Node(dirs[1]!, ["replica", dirs[1]!, String(SEED), port]);
        nodes.push(primary, replica);
        let acked = 0;

        for (let round = 1; round <= 4; round++) {
          // Trade for a while, then pull the plug on the primary mid-stream.
          await primary.ackedAtLeast(acked + 200 + round * 37);
          await primary.kill();
          acked = Math.max(acked, primary.acked);

          // The replica notices the silence and takes over with everything acknowledged.
          const [, epoch, last] = await replica.line(new RegExp(`^promoted (\\d+) (\\d+)$`));
          expect(Number(epoch)).toBe(round);
          expect(Number(last), `round ${round}: acknowledged ${acked}, promoted with ${last}`).toBeGreaterThanOrEqual(acked);

          // The dead node comes back as the new primary's replica, and trading goes on.
          const newPort = (await replica.line(/^listening (\d+)$/))[1]!;
          const rejoined = new Node(primary.dir, ["replica", primary.dir, String(SEED), newPort]);
          nodes.push(rejoined);
          primary = replica;
          replica = rejoined;
          await primary.ackedAtLeast(acked + 1); // acknowledgements resume once the replica has caught up
        }
        await primary.ackedAtLeast(acked + 100);
        acked = primary.acked;
        await primary.kill();
        await replica.kill();

        // Both copies are exactly the reference engine's state for what they hold, and nothing acknowledged is missing.
        expect(expectReplayOf(primary.dir)).toBeGreaterThanOrEqual(acked);
        expect(expectReplayOf(replica.dir)).toBeGreaterThanOrEqual(acked);
        expect(readEpoch(primary.dir)).toBe(4);
      } finally {
        for (const n of nodes) if (n.proc.exitCode === null) n.proc.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 200));
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
