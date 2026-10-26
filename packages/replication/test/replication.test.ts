import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStream, OrderBook } from "@ome/core";
import { DurableOrderBook } from "@ome/journal";
import { afterEach, describe, expect, it } from "vitest";
import { Primary, Replica, readEpoch, writeEpoch } from "../src/index.js";

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ome-repl-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await pause(5);
  }
}

async function startPrimary(dir: string, options: Partial<Parameters<typeof Primary.start>[1]> = {}): Promise<Primary> {
  const primary = await Primary.start(DurableOrderBook.open(dir, { fsync: "batch" }), { port: 0, epoch: readEpoch(dir), heartbeatMs: 20, ...options });
  cleanup.push(() => primary.close().then(() => primary.book.close()));
  return primary;
}

function startReplica(dir: string, port: number, options: Partial<Parameters<typeof Replica.start>[1]> = {}): Replica {
  const replica = Replica.start(dir, { port, failoverMs: 200, retryMs: 20, ...options });
  cleanup.push(() => replica.close());
  return replica;
}

/** Applies `count` commands from the stream and waits until all are acknowledged. */
async function run(primary: Primary, stream: CommandStream, count: number): Promise<void> {
  let last: Promise<void> = Promise.resolve();
  for (let i = 0; i < count; i++) last = primary.apply(stream.next()).acknowledged;
  await last;
}

describe("replication", () => {
  it("gives the replica exactly the primary's state", async () => {
    const primary = await startPrimary(tempDir());
    const replica = startReplica(tempDir(), primary.port);
    await run(primary, new CommandStream(1), 3_000);
    expect(replica.book.lastCommand).toBe(3_000);
    expect(replica.book.book.snapshot()).toEqual(primary.book.book.snapshot());
  });

  it("in sync mode, acknowledges nothing until the replica has it on disk", async () => {
    const primary = await startPrimary(tempDir());
    let acknowledged = false;
    void primary.apply(new CommandStream(2).next()).acknowledged.then(() => (acknowledged = true));
    await pause(150);
    expect(acknowledged).toBe(false); // on disk here, but nowhere else yet
    startReplica(tempDir(), primary.port);
    await until(() => acknowledged);
  });

  it("in async mode, acknowledges without a replica", async () => {
    const primary = await startPrimary(tempDir(), { mode: "async" });
    await primary.apply(new CommandStream(2).next()).acknowledged;
  });

  it("catches a reconnecting replica up from the backlog, or from a snapshot when it is too far behind", async () => {
    const primary = await startPrimary(tempDir(), { backlog: 100 });
    const replicaDir = tempDir();
    const stream = new CommandStream(3);
    let replica = startReplica(replicaDir, primary.port);
    await run(primary, stream, 500);

    // Down for 50 commands: replayed from the backlog.
    replica.close();
    await until(() => !primary.replicaConnected);
    let last = primary.apply(stream.next()).acknowledged;
    for (let i = 1; i < 50; i++) last = primary.apply(stream.next()).acknowledged;
    replica = startReplica(replicaDir, primary.port);
    await last;
    expect(replica.book.book.snapshot()).toEqual(primary.book.book.snapshot());

    // Down for 1,000 commands, more than the backlog keeps: restarted from a snapshot.
    replica.close();
    await until(() => !primary.replicaConnected);
    for (let i = 0; i < 1_000; i++) last = primary.apply(stream.next()).acknowledged;
    replica = startReplica(replicaDir, primary.port);
    await last;
    expect(replica.book.lastCommand).toBe(1_550);
    expect(replica.book.book.snapshot()).toEqual(primary.book.book.snapshot());
    // The restored state is durable: reopened from disk, it is the same.
    replica.close();
    const reopened = DurableOrderBook.open(replicaDir);
    expect(reopened.book.snapshot()).toEqual(primary.book.book.snapshot());
    reopened.close();
  });

  it("promotes the replica when the primary goes silent, with a higher epoch", async () => {
    const primary = await startPrimary(tempDir());
    let promotedAt: { epoch: number; last: number } | null = null;
    const replica = startReplica(tempDir(), primary.port, { onPromote: (book, epoch) => (promotedAt = { epoch, last: book.lastCommand }) });
    await run(primary, new CommandStream(4), 200);
    await pause(400);
    expect(promotedAt).toBeNull(); // heartbeats keep it a replica while the primary is idle

    await primary.close();
    await until(() => promotedAt !== null, 2_000);
    expect(promotedAt).toEqual({ epoch: 1, last: 200 });
    expect(readEpoch(replica.dir)).toBe(1);
  });

  it("fences: an old primary cannot lead a newer replica, and steps down when it meets one", async () => {
    // A replica that has seen epoch 5 meets a primary still on epoch 0.
    const newerDir = tempDir();
    writeEpoch(newerDir, 5);
    let fencedBy: number | null = null;
    const oldPrimary = await Primary.start(DurableOrderBook.open(tempDir()), { port: 0, epoch: 0, heartbeatMs: 20 }, (e) => (fencedBy = e));
    cleanup.push(() => oldPrimary.close().then(() => oldPrimary.book.close()));
    const replica = startReplica(newerDir, oldPrimary.port);
    await until(() => fencedBy !== null);
    expect(fencedBy).toBe(5);
    expect(oldPrimary.fenced).toBe(true);
    expect(() => oldPrimary.apply(new CommandStream(5).next())).toThrow(/fenced/);
    expect(replica.book.lastCommand).toBe(0); // and it took nothing from it
  });

  it("discards an old primary's unacknowledged commands when it rejoins as a replica", async () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const a = await startPrimary(dirA);
    const b = startReplica(dirB, a.port);
    await run(a, new CommandStream(6), 100);

    // B loses touch; A applies 5 more commands that never reach B, so are never acknowledged.
    b.close();
    await until(() => !a.replicaConnected);
    const lost = new CommandStream(999);
    for (let i = 0; i < 5; i++) void a.apply(lost.next()).acknowledged.catch(() => {});
    expect(a.book.lastCommand).toBe(105);
    await a.close();
    a.book.close();
    cleanup.splice(0); // a is closed by hand

    // B takes over at epoch 1 and carries on with different commands.
    writeEpoch(dirB, 1);
    const bPrimary = await startPrimary(dirB);
    const other = new CommandStream(7);
    const later = Array.from({ length: 5 }, () => bPrimary.apply(other.next()).acknowledged);

    // A comes back as a replica. It says it has 105 commands, but its last 5 never
    // happened as far as the exchange is concerned: it must start again from B's state.
    const aReplica = startReplica(dirA, bPrimary.port);
    await Promise.all(later);
    await until(() => aReplica.book.lastCommand === 105 && readEpoch(dirA) === 1);
    expect(aReplica.book.book.snapshot()).toEqual(bPrimary.book.book.snapshot());

    const expected = new OrderBook();
    const original = new CommandStream(6);
    for (let i = 0; i < 100; i++) expected.apply(original.next());
    const replay = new CommandStream(7);
    for (let i = 0; i < 5; i++) expected.apply(replay.next());
    expect(aReplica.book.book.snapshot()).toEqual(expected.snapshot());
  });
});
