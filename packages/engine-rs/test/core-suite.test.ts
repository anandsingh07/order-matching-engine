import { describe, expect, it, vi } from "vitest";
import * as core from "../../core/src/index.js";
import { RustOrderBook } from "../src/index.js";

// The TypeScript engine's own test files, run unchanged with OrderBook
// swapped for the Rust engine: its unit tests (every rule and tie-break),
// its invariants, its snapshot round trips, and its differential test
// against the deliberately naive reference engine, a second oracle that
// shares no code with either engine.
vi.mock("../../core/src/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../core/src/index.js")>();
  const { RustOrderBook } = await import("../src/rust-order-book.js");
  return { ...original, OrderBook: RustOrderBook };
});

import "../../core/test/order-book.test.js";
import "../../core/test/advanced-orders.test.js";
import "../../core/test/auction.test.js";
import "../../core/test/invariants.test.js";
import "../../core/test/snapshot.test.js";
import "../../core/test/differential.test.js";

describe("the core suite in this file", () => {
  it("runs against the Rust engine, not the TypeScript one", () => {
    expect(core.OrderBook).toBe(RustOrderBook);
    expect(new core.OrderBook()).toBeInstanceOf(RustOrderBook);
  });
});
