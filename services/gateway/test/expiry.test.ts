import type { Instrument } from "@ome/client";
import { Exchange } from "@ome/exchange";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUMENTS, Gateway, type GatewayOptions } from "../src/index.js";
import { TestClient } from "./client.js";

// Derivatives through the real gateway, with an injected clock: the expiry
// cycle is the default 30 minutes, and the test moves time instead of waiting.

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 25, h, m, s);
let clock = at(10, 10);
let exchange: Exchange;
let gateway: Gateway;
let base: string;
const clients: TestClient[] = [];

async function start(options: Partial<GatewayOptions> = {}) {
  clock = at(10, 10);
  exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
  gateway = await Gateway.create({
    exchange,
    now: () => clock,
    bookIntervalMs: 20,
    botKey: "k",
    derivatives: { underlyings: [{ symbol: "TCS", multiplier: 10, strikeStep: 5_000 }] },
    ...options,
  });
  base = await gateway.listen(0);
}

async function client(name: string, botKey?: string): Promise<TestClient> {
  const c = await TestClient.connect(base, name, botKey);
  clients.push(c);
  return c;
}

const limit = (symbol: string, clientOrderId: string, side: "buy" | "sell", price: number, quantity: number) => ({
  op: "order",
  symbol,
  clientOrderId,
  order: { type: "limit", side, price, quantity },
});

const instruments = async () => (await (await fetch(`${base}/api/instruments`)).json()) as Instrument[];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await gateway.close();
  await exchange.stop();
});

describe("futures and options through the gateway", () => {
  it("lists a series, trades an option and a future, and cash-settles both at expiry", async () => {
    await start();
    const listed = await instruments();
    const future = listed.find((i) => i.symbol === "TCS-25OCT1030-F")!;
    const call = listed.find((i) => i.symbol === "TCS-25OCT1030-4100C")!;
    expect(future).toMatchObject({ kind: "future", underlying: "TCS", expiry: at(10, 30), multiplier: 10, referencePrice: 410_000 });
    expect(call).toMatchObject({ kind: "option", right: "call", strike: 410_000, multiplier: 10 });
    expect(listed.filter((i) => i.underlying === "TCS")).toHaveLength(11);

    const alice = await client("alice");
    const bob = await client("bob");
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");
    // Each connection starts with the current list, so a roll between /api/instruments and connecting is not missed.
    expect(((await alice.waitFor((m) => m.type === "instruments")).instruments as Instrument[]).map((i) => i.symbol)).toEqual(listed.map((i) => i.symbol));

    // Bob writes 4 calls to Alice at fair value, and sells her 3 futures at Rs 4,100.
    const premium = call.referencePrice; // ticks per share
    expect(await bob.request(limit(call.symbol, "c1", "sell", premium, 4))).toMatchObject({ type: "ack" });
    expect(await alice.request(limit(call.symbol, "c1", "buy", premium, 4))).toMatchObject({ type: "ack" });
    expect(await bob.request(limit(future.symbol, "f1", "sell", 410_000, 3))).toMatchObject({ type: "ack" });
    expect(await alice.request(limit(future.symbol, "f1", "buy", 410_000, 3))).toMatchObject({ type: "ack" });
    // An order still resting at expiry: cancelled, with the reason.
    expect(await alice.request(limit(call.symbol, "rest", "buy", 5, 1))).toMatchObject({ type: "ack" });
    const holding = await alice.waitFor(
      (m) => m.type === "account" && (m.positions as { symbol: string }[]).some((p) => p.symbol === future.symbol),
    );
    expect(holding.positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: call.symbol, quantity: 4, averagePrice: premium }),
        expect.objectContaining({ symbol: future.symbol, quantity: 3, averagePrice: 410_000 }),
      ]),
    );

    // TCS trades in the last minute before expiry: 10 at Rs 4,120 and 30 at Rs 4,130, a VWAP of Rs 4,127.50.
    clock = at(10, 29, 30);
    await mm.request(limit("TCS", "s1", "sell", 412_000, 10));
    await taker.request(limit("TCS", "b1", "buy", 412_000, 10));
    clock = at(10, 29, 45);
    await mm.request(limit("TCS", "s2", "sell", 413_000, 30));
    await taker.request(limit("TCS", "b2", "buy", 413_000, 30));
    await taker.waitFor((m) => m.type === "execution" && m.clientOrderId === "b2" && m.event === "fill");

    clock = at(10, 30);
    const settled = (c: TestClient, symbol: string) => c.waitFor((m) => m.type === "settlement" && m.symbol === symbol);
    // Future: 3 contracts x 10 shares x (4127.50 - 4100). Call: intrinsic 27.50 x 40 shares.
    expect(await settled(alice, future.symbol)).toMatchObject({ price: 412_750, basis: "vwap", quantity: 3, amount: 825, currency: "INR" });
    expect(await settled(alice, call.symbol)).toMatchObject({ price: 412_750, quantity: 4, amount: 1_100 });
    expect(await settled(bob, future.symbol)).toMatchObject({ price: 412_750, quantity: -3, amount: -825 });
    expect(await settled(bob, call.symbol)).toMatchObject({ price: 412_750, quantity: -4, amount: -1_100 });
    expect(await alice.waitFor((m) => m.type === "execution" && m.clientOrderId === "rest" && m.event === "cancelled")).toMatchObject({
      reason: "expired",
      remaining: 1,
    });
    expect(await alice.waitFor((m) => m.type === "notice" && String(m.text).startsWith(future.symbol))).toMatchObject({ level: "info" });

    // Cash, to the paisa: Alice paid the premium and received both settlements; Bob the reverse.
    const premiumRupees = (premium * 4 * 10) / 100;
    const inr = (m: Record<string, unknown>) => (m.balances as { currency: string; cash: number }[]).find((b) => b.currency === "INR")!.cash;
    const flat = (c: TestClient, cash: number) =>
      c.waitFor((m) => m.type === "account" && (m.positions as unknown[]).length === 0 && inr(m) === cash, 4_000);
    await flat(alice, 1_000_000 - premiumRupees + 825 + 1_100);
    await flat(bob, 1_000_000 + premiumRupees - 825 - 1_100);

    // The next series is listed around TCS's new price, and the old one is gone.
    const update = await alice.waitFor((m) => m.type === "instruments" && (m.instruments as Instrument[]).some((i) => i.symbol === "TCS-25OCT1100-F"));
    const symbols = (update.instruments as Instrument[]).map((i) => i.symbol);
    expect(symbols).toContain("TCS-25OCT1100-F");
    expect(symbols).toContain("TCS-25OCT1100-4150C"); // ATM for Rs 4,130 on Rs 50 strikes
    expect(symbols.some((s) => s.includes("1030"))).toBe(false);
    expect((await instruments()).map((i) => i.symbol)).toEqual(symbols);
    expect(await alice.request(limit(call.symbol, "late", "buy", premium, 1))).toMatchObject({ reason: "unknown_symbol" });
  }, 20_000);

  it("halts derivatives with their underlying, and bands options around their value", async () => {
    await start({ market: { openingAuctionMs: 1_000 } });
    const alice = await client("alice");
    const call = (await instruments()).find((i) => i.symbol === "TCS-25OCT1030-4100C")!;
    expect(await alice.request(limit(call.symbol, "a1", "buy", call.referencePrice, 1))).toMatchObject({ reason: "underlying_in_auction" });

    await alice.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "continuous", 4_000);
    const status = await alice.waitFor((m) => m.type === "status" && m.symbol === call.symbol);
    const band = status.band as { low: number; high: number };
    expect(status).toMatchObject({ phase: "continuous", breakerPct: null });
    expect(band.low).toBeLessThan(call.referencePrice);
    expect(band.high).toBeGreaterThan(call.referencePrice);
    expect(await alice.request(limit(call.symbol, "a2", "buy", band.high + 5, 1))).toMatchObject({ reason: "price_outside_band" });
    expect(await alice.request(limit(call.symbol, "a3", "buy", call.referencePrice, 1))).toMatchObject({ type: "ack" });
  }, 20_000);

  it("stops trading a series at its expiry instant, before the expiry check has run", async () => {
    // The roll timer never comes round in this test: only the clock passes expiry.
    await start({ rollIntervalMs: 3_600_000 });
    const alice = await client("alice");
    const bob = await client("bob");
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");
    const listed = await instruments();
    // The last series listed, which the roll would expire last.
    const put = listed.filter((i) => i.underlying === "TCS").at(-1)!;
    expect(put.symbol).toBe("TCS-25OCT1030-4200P");
    expect(await bob.request(limit(put.symbol, "p1", "sell", put.referencePrice, 2))).toMatchObject({ type: "ack" });
    await mm.request(limit("TCS", "s1", "sell", 413_000, 10));
    await taker.request(limit("TCS", "b1", "buy", 413_000, 10));

    // A market order is priced from the book before it is risk-checked; the clock passes expiry meanwhile.
    const depth = exchange.depth.bind(exchange);
    exchange.depth = async (symbol, levels) => {
      const book = await depth(symbol, levels);
      if (symbol === put.symbol && levels === 1) clock = at(10, 30, 5);
      return book;
    };
    expect(await alice.request({ op: "order", symbol: put.symbol, clientOrderId: "mkt", order: { type: "market", side: "buy", quantity: 2 } })).toMatchObject({
      reason: "series_expired",
    });
    // 5 s after expiry, the settlement price is already fixed (Rs 4,130, intrinsic Rs 70): nobody may trade on it.
    expect(clock).toBe(at(10, 30, 5));
    expect(await alice.request(limit(put.symbol, "late", "buy", put.referencePrice, 2))).toMatchObject({ type: "reject", reason: "series_expired" });
    expect(await bob.request({ op: "amend", symbol: put.symbol, clientOrderId: "p1", price: put.referencePrice - 5 })).toMatchObject({ reason: "series_expired" });
    // A trader can still take a resting order down.
    expect(await bob.request({ op: "cancel", symbol: put.symbol, clientOrderId: "p1" })).toMatchObject({ type: "ack" });
    // The stock itself trades on.
    expect(await alice.request(limit("TCS", "stock", "buy", 400_000, 1))).toMatchObject({ type: "ack" });
    await alice.waitFor((m) => m.type === "execution" && m.clientOrderId === "stock" && m.event === "rested");
    // The refused market order was counted against Alice while in flight; refused, it holds nothing. Only her
    // resting stock bid (Rs 4,000) is exposure.
    const seen = alice.messages.length;
    const account = await alice.waitFor((m) => m.type === "account" && alice.messages.indexOf(m) >= seen, 4_000);
    expect((account.balances as { currency: string }[]).find((b) => b.currency === "INR")).toMatchObject({ exposure: 4_000 });
  }, 20_000);

  it("does not let a burst of one-contract sells against a long of one open an unmargined short", async () => {
    await start({ risk: { startingCash: { INR: 20_000 } } });
    const alice = await client("alice");
    const mm = await client("mm", "k");
    const call = (await instruments()).find((i) => i.symbol === "TCS-25OCT1030-4100C")!;
    await mm.request(limit(call.symbol, "o1", "sell", call.referencePrice, 1));
    expect(await alice.request(limit(call.symbol, "buy", "buy", call.referencePrice, 1))).toMatchObject({ type: "ack" });
    await alice.waitFor((m) => m.type === "execution" && m.clientOrderId === "buy" && m.event === "fill");
    // Thirty sells sent together, so none has been answered when the next is checked. Only the first
    // closes the long; each later one opens a short needing Rs 410 x 10 of writing margin (10% of
    // Rs 4,100, at the money), on top of what the long and the resting sells already hold.
    const replies = await Promise.all(Array.from({ length: 30 }, (_, i) => alice.request(limit(call.symbol, `s${i}`, "sell", call.referencePrice, 1))));
    const acked = replies.filter((r) => r.type === "ack").length;
    // Premium about Rs 280 + 4 x Rs 4,100 = Rs 16,680 fits in Rs 20,000; a fifth would not.
    expect(acked).toBe(4);
    expect(replies.slice(acked).every((r) => r.reason === "insufficient_buying_power")).toBe(true);
  }, 20_000);

  it("refuses an order whose series finished expiring while its risk checks were running", async () => {
    await start();
    const alice = await client("alice");
    const call = (await instruments()).find((i) => i.symbol === "TCS-25OCT1030-4100C")!;
    // A market order is priced from the book before it is risk-checked. Hold it there while the clock
    // passes expiry and the roll settles and delists the series.
    const depth = exchange.depth.bind(exchange);
    let held = false;
    exchange.depth = async (symbol, levels) => {
      const book = await depth(symbol, levels);
      if (symbol === call.symbol && levels === 1 && !held) {
        held = true;
        clock = at(10, 30, 5);
        while ((await instruments()).some((i) => i.symbol === call.symbol)) await new Promise((r) => setTimeout(r, 20));
      }
      return book;
    };
    const reply = await alice.request({ op: "order", symbol: call.symbol, clientOrderId: "m1", order: { type: "market", side: "buy", quantity: 1 } });
    expect(held).toBe(true);
    // Not "unavailable", which is what the exchange says of a symbol it no longer lists.
    expect(reply).toMatchObject({ type: "reject", reason: "series_expired" });
  }, 20_000);
});
