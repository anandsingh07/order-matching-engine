import { Exchange } from "@ome/exchange";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUMENTS, Gateway, type GatewayOptions } from "../src/index.js";
import { TestClient } from "./client.js";

let exchange: Exchange;
let gateway: Gateway;
let base: string;
const clients: TestClient[] = [];

async function start(options: Partial<GatewayOptions> = {}) {
  exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
  gateway = await Gateway.create({ exchange, bookIntervalMs: 20, ...options });
  // GATEWAY_TEST_PROCESSES=2 runs every test here through front-end processes (cluster/pool.ts).
  const processes = Number(process.env.GATEWAY_TEST_PROCESSES ?? 1);
  base = processes >= 2 ? await gateway.listenFrontends({ port: 0, processes }) : await gateway.listen(0);
}

async function client(name: string): Promise<TestClient> {
  const c = await TestClient.connect(base, name);
  clients.push(c);
  return c;
}

const limit = (clientOrderId: string, side: "buy" | "sell", price: number, quantity: number) => ({
  op: "order",
  symbol: "TCS",
  clientOrderId,
  order: { type: "limit", side, price, quantity },
});

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await gateway.close();
  await exchange.stop();
});

describe("gateway", () => {
  it("sends a connection's commands to the engine in the order it sent them", async () => {
    const alice = await client("alice");
    const bob = await client("bob");
    // A cancel right behind its limit order on one connection.
    alice.send({ ...limit("a1", "buy", 400_000, 1), reqId: "a1" });
    alice.send({ op: "cancel", reqId: "c1", symbol: "TCS", clientOrderId: "a1" });
    expect(await alice.waitFor((m) => m.type === "ack" && m.reqId === "c1")).toMatchObject({ clientOrderId: "a1" });
    expect(await alice.waitFor((m) => m.event === "cancelled")).toMatchObject({ clientOrderId: "a1", remaining: 1 });

    // A limit order right behind a market order, which first waits on the book for its price
    // estimate. In order, the market order buys bob's 410_000; out of order, it would meet alice's
    // own cheaper 405_000 first.
    await bob.request(limit("b1", "sell", 410_000, 1));
    alice.send({ op: "order", reqId: "m1", symbol: "TCS", clientOrderId: "m1", order: { type: "market", side: "buy", quantity: 1 } });
    alice.send({ ...limit("a2", "sell", 405_000, 1), reqId: "a2" });
    expect(await alice.waitFor((m) => m.event === "fill" && m.clientOrderId === "m1")).toMatchObject({ price: 410_000, liquidity: "taker" });
    expect(await alice.waitFor((m) => m.event === "rested" && m.clientOrderId === "a2")).toMatchObject({ price: 405_000 });
    expect(alice.messages.filter((m) => m.type === "reject")).toEqual([]);
  });

  it("refuses a WebSocket without a valid session token", async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws?token=nope`);
    const code = await new Promise((resolve) => socket.addEventListener("close", (e) => resolve(e.code)));
    expect(code).toBe(4001);
  });

  it("acknowledges an order and reports it resting", async () => {
    const alice = await client("alice");
    expect(await alice.request(limit("a1", "sell", 410_000, 10))).toMatchObject({ type: "ack", clientOrderId: "a1" });
    expect(await alice.waitFor((m) => m.type === "execution" && m.event === "rested")).toMatchObject({
      symbol: "TCS",
      clientOrderId: "a1",
      price: 410_000,
      quantity: 10,
    });
  });

  it("reports fills privately to both sides and publishes an anonymous trade", async () => {
    const alice = await client("alice");
    const bob = await client("bob");
    const watcher = await client("watcher");
    watcher.send({ op: "subscribe", channels: ["trades:TCS", "book:TCS", "candles:TCS:1m"] });
    await watcher.waitFor((m) => m.type === "subscribed");

    await alice.request(limit("a1", "sell", 410_000, 10));
    await bob.request(limit("b1", "buy", 410_500, 4));

    expect(await alice.waitFor((m) => m.event === "fill")).toMatchObject({ clientOrderId: "a1", side: "sell", price: 410_000, quantity: 4, liquidity: "maker" });
    expect(await bob.waitFor((m) => m.event === "fill")).toMatchObject({ clientOrderId: "b1", side: "buy", price: 410_000, quantity: 4, liquidity: "taker" });
    expect(await watcher.waitFor((m) => m.type === "trade")).toMatchObject({ trade: { price: 410_000, quantity: 4, side: "buy" } });
    expect(await watcher.waitFor((m) => m.type === "candle")).toMatchObject({ candle: { open: 410_000, volume: 4 } });
    // Book updates are conflated on a timer, so a snapshot from before the
    // trade (10 resting) may arrive first. Wait for the post-trade state.
    const book = await watcher.waitFor((m) => m.type === "book" && (m.asks as { quantity: number }[])[0]?.quantity === 6);
    expect(book).toMatchObject({ asks: [{ price: 410_000, quantity: 6, orders: 1 }] });

    // Nobody learns who traded with whom.
    const leaks = (c: TestClient, other: TestClient) => c.messages.some((m) => JSON.stringify(m).includes(`"${other.traderId}`));
    expect(leaks(alice, bob)).toBe(false);
    expect(leaks(bob, alice)).toBe(false);
    expect(leaks(watcher, alice) || leaks(watcher, bob)).toBe(false);
  });

  it("keeps each trader's orders separate even with the same client order id", async () => {
    const alice = await client("alice");
    const bob = await client("bob");
    expect((await alice.request(limit("o1", "buy", 400_000, 5))).type).toBe("ack");
    expect((await bob.request(limit("o1", "buy", 399_000, 5))).type).toBe("ack");
    // Bob's cancel of "o1" can only ever reach Bob's own order.
    expect((await bob.request({ op: "cancel", symbol: "TCS", clientOrderId: "o1" })).type).toBe("ack");
    expect(await bob.request({ op: "cancel", symbol: "TCS", clientOrderId: "o1" })).toMatchObject({ reason: "unknown_order" });
    const book = (await (await fetch(`${base}/api/book/TCS`)).json()) as { bids: unknown[] };
    expect(book.bids).toEqual([{ price: 400_000, quantity: 5, orders: 1 }]);
  });

  it("validates every message and keeps the connection open", async () => {
    const alice = await client("alice");
    alice.socket.send("{not json");
    expect(await alice.waitFor((m) => m.type === "error")).toMatchObject({ message: "invalid JSON" });
    expect(await alice.request({ op: "order", symbol: "TCS", clientOrderId: "x", order: { type: "limit", side: "buy", price: -5, quantity: 1 } })).toMatchObject({
      type: "error",
      message: expect.stringContaining("order.price"),
    });
    expect(await alice.request({ ...limit("x1", "buy", 400_000, 1), symbol: "NOPE" })).toMatchObject({ reason: "unknown_symbol" });
    expect(await alice.request(limit("x2", "buy", 400_003, 1))).toMatchObject({ reason: "invalid_tick_size" });
    expect((await alice.request(limit("x3", "buy", 400_000, 1))).type).toBe("ack");
    expect(await alice.request(limit("x3", "buy", 400_000, 1))).toMatchObject({ reason: "duplicate_client_order_id" });
    expect(await alice.request({ op: "cancel", symbol: "TCS", clientOrderId: "bad id!" })).toMatchObject({ type: "error" });
    alice.send({ op: "ping", reqId: 7 });
    expect(await alice.waitFor((m) => m.type === "pong")).toMatchObject({ reqId: 7 });
  });

  it("returns engine rejections to the client", async () => {
    const alice = await client("alice");
    const reply = await alice.request({ op: "amend", symbol: "TCS", clientOrderId: "never-placed", quantity: 5 });
    expect(reply).toMatchObject({ type: "reject", reason: "unknown_order" });
  });
});

describe("gateway rate limiting", () => {
  it("limits orders per connection", async () => {
    await gateway.close();
    await exchange.stop();
    await start({ rateLimit: { burst: 5, perSecond: 0.001 } });
    const alice = await client("alice");
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => alice.request(limit(`r${i}`, "buy", 400_000, 1))));
    expect(replies.filter((r) => r.type === "ack")).toHaveLength(5);
    expect(replies.filter((r) => r.reason === "rate_limited")).toHaveLength(3);
  });
});

describe("gateway REST API", () => {
  it("serves instruments, health, books, trades and candles", async () => {
    const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<unknown>;
    expect(await get("/api/instruments")).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: "TCS", tickSize: 5 })]));
    expect(await get("/api/health")).toMatchObject({ status: "ok" });

    const alice = await client("alice");
    const bob = await client("bob");
    await alice.request(limit("a1", "sell", 410_000, 3));
    await bob.request(limit("b1", "buy", 410_000, 3));
    await bob.waitFor((m) => m.event === "fill");

    expect(await get("/api/trades/TCS")).toMatchObject([{ price: 410_000, quantity: 3, side: "buy" }]);
    expect(await get("/api/candles/TCS?interval=5s")).toMatchObject([{ open: 410_000, close: 410_000, volume: 3, trades: 1 }]);
    expect((await fetch(`${base}/api/book/NOPE`)).status).toBe(404);
    expect((await fetch(`${base}/api/candles/TCS?interval=7m`)).status).toBe(400);
    expect((await fetch(`${base}/api/session`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
  });
});
