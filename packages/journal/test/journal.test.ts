import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStream, OrderBook } from "@ome/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableOrderBook, type EngineClass } from "../src/index.js";
import { ENGINES } from "./fixtures/engines.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ome-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The state an in-memory book reaches after the first `count` commands of a seeded stream. */
function expectedState(seed: number, count: number) {
  const book = new OrderBook();
  const stream = new CommandStream(seed);
  for (let i = 0; i < count; i++) book.apply(stream.next());
  return book.snapshot();
}

function fill(engine: EngineClass, seed: number, count: number, snapshotEvery = 0): void {
  const book = DurableOrderBook.open(dir, { fsync: "never", engine });
  const stream = new CommandStream(seed);
  for (let i = 1; i <= count; i++) {
    book.apply(stream.next());
    if (snapshotEvery > 0 && i % snapshotEvery === 0) book.snapshot();
  }
  book.close();
}

const files = (prefix: string) => readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
const lastSegment = () => join(dir, files("journal-").at(-1)!);

// The expected states always come from @ome/core's OrderBook, so the Rust
// engine is checked against the TypeScript one as well as against itself.
describe.each(Object.entries(ENGINES))("DurableOrderBook (%s engine)", (_name, engine) => {
  it("rebuilds the exact state from the journal", () => {
    fill(engine, 1, 2_000);
    const book = DurableOrderBook.open(dir, { engine });
    expect(book.book).toBeInstanceOf(engine);
    expect(book.lastCommand).toBe(2_000);
    expect(book.book.snapshot()).toEqual(expectedState(1, 2_000));
    book.close();
  });

  it("rebuilds from snapshot plus journal and prunes old files", () => {
    fill(engine, 2, 2_500, 500);
    expect(files("snapshot-")).toEqual(["snapshot-000000002000.json", "snapshot-000000002500.json"]);
    // Only the segment after the oldest kept snapshot, and the current one, remain.
    expect(files("journal-")).toEqual(["journal-000000002001.log", "journal-000000002501.log"]);
    const book = DurableOrderBook.open(dir, { engine });
    expect(book.book.snapshot()).toEqual(expectedState(2, 2_500));
    book.close();
  });

  it("falls back to the previous snapshot if the newest one is corrupt", () => {
    fill(engine, 3, 1_200, 500);
    const newest = join(dir, files("snapshot-").at(-1)!);
    writeFileSync(newest, readFileSync(newest, "utf8").replace(/"seq":\d/, '"seq":9'));
    const book = DurableOrderBook.open(dir, { engine });
    expect(book.lastCommand).toBe(1_200);
    expect(book.book.snapshot()).toEqual(expectedState(3, 1_200));
    expect(files("snapshot-")).toEqual(["snapshot-000000000500.json"]);
    book.close();
  });

  it("drops a torn final record and keeps working", () => {
    fill(engine, 4, 300);
    appendFileSync(lastSegment(), '1a2b3c4d {"n":301,"c":{"type":"cancel"'); // crash mid-write
    const book = DurableOrderBook.open(dir, { engine });
    expect(book.lastCommand).toBe(300);
    const stream = new CommandStream(4);
    for (let i = 0; i < 300; i++) stream.next();
    for (let i = 0; i < 50; i++) book.apply(stream.next());
    book.close();

    const reopened = DurableOrderBook.open(dir, { engine });
    expect(reopened.book.snapshot()).toEqual(expectedState(4, 350));
    reopened.close();
  });

  it("recovers the matching prefix when the journal is cut at any byte", () => {
    fill(engine, 5, 200);
    const path = lastSegment();
    const size = statSync(path).size;
    const original = readFileSync(path);
    for (const cut of [0, 1, 37, Math.floor(size / 3), Math.floor(size / 2), size - 1]) {
      writeFileSync(path, original);
      truncateSync(path, cut);
      const complete = original.subarray(0, cut).toString("utf8").split("\n").length - 1;
      const book = DurableOrderBook.open(dir, { engine });
      expect(book.lastCommand).toBe(complete);
      expect(book.book.snapshot()).toEqual(expectedState(5, complete));
      book.close();
    }
  });

  it("refuses to silently drop data after a corrupt record in the middle", () => {
    fill(engine, 6, 100);
    const path = lastSegment();
    const lines = readFileSync(path, "utf8").split("\n");
    lines[50] = lines[50]!.replace('"n":51', '"n":59');
    writeFileSync(path, lines.join("\n"));
    expect(() => DurableOrderBook.open(dir, { engine })).toThrow(/Corrupt journal record 51/);
  });

  it("reports durability according to the fsync policy", () => {
    const stream = new CommandStream(7);
    const batch = DurableOrderBook.open(dir, { fsync: "batch", batchSize: 10, engine });
    for (let i = 0; i < 25; i++) batch.apply(stream.next());
    expect(batch.lastCommand).toBe(25);
    expect(batch.durableCommand).toBe(20);
    batch.sync();
    expect(batch.durableCommand).toBe(25);
    batch.close();
  });
});
