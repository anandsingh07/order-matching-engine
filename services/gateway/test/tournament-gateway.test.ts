import type { EngineCommand } from "@ome/core";
import type { Leaderboard, Tournament } from "@ome/client";
import { Exchange } from "@ome/exchange";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUMENTS, Gateway, type GatewayOptions } from "../src/index.js";
import { TestClient } from "./client.js";

// A tournament through the real gateway, with an injected clock: the test
// moves time to the start and the end instead of waiting. Equity sampling
// and leaderboard pushes still run on real timers, made fast here.

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 25, h, m, s);
let clock = at(10, 0);
let exchange: Exchange;
let gateway: Gateway;
let base: string;
const clients: TestClient[] = [];

async function start(options: Partial<GatewayOptions> = {}, startAt = at(10, 0)) {
  clock = startAt;
  exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
  gateway = await Gateway.create({
    exchange,
    now: () => clock,
    bookIntervalMs: 20,
    botKey: "k",
    adminKey: "admin",
    tournaments: { fx: { INR: 1, USDT: 90 }, startingCash: { INR: 1_000_000, USDT: 10_000 }, sampleIntervalMs: 20, pushIntervalMs: 50 },
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

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const join = (id: string, c: TestClient) => post(`/api/tournaments/${id}/join`, { token: c.token });
const board = async (id: string) => (await (await fetch(`${base}/api/tournaments/${id}/leaderboard`)).json()) as Leaderboard;
const account = async (c: TestClient) =>
  (await (await fetch(`${base}/api/account?token=${c.token}`)).json()) as {
    balances: { currency: string; cash: number }[];
    positions: { symbol: string; quantity: number }[];
  };
const inrCash = async (c: TestClient) => (await account(c)).balances.find((b) => b.currency === "INR")!.cash;
const filled = (c: TestClient, clientOrderId: string) =>
  c.waitFor((m) => m.type === "execution" && m.clientOrderId === clientOrderId && m.event === "fill");

/** Polls until `check` passes: sampling runs on its own timer. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await gateway.close();
  await exchange.stop();
});

describe("tournaments through the gateway", () => {
  it("ranks a winner above a loser, excludes bots, pushes standings, and freezes them at the end", async () => {
    await start();

    // Only an admin creates tournaments.
    const spec = { name: "Diwali Cup", start: at(10, 1), end: at(10, 11) };
    expect((await post("/api/tournaments", spec)).status).toBe(403);
    expect((await post("/api/tournaments?key=admin", { ...spec, end: at(9, 0) })).status).toBe(400);
    const created = await post("/api/tournaments?key=admin", spec);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "t1", status: "upcoming", startingEquity: 1_900_000, participants: 0 });

    const alice = await client("alice");
    const bob = await client("bob");
    const carol = await client("carol");
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");

    // Joining: bots never, a trader with an open order not until it is gone, a bad token not at all.
    expect((await join("t1", alice)).status).toBe(200);
    expect((await join("t1", bob)).status).toBe(200);
    const bot = await join("t1", mm);
    expect(bot.status).toBe(409);
    expect(await bot.json()).toMatchObject({ error: "unlimited_account" });
    expect(await carol.request(limit("TCS", "c1", "buy", 400_000, 1))).toMatchObject({ type: "ack" });
    await carol.waitFor((m) => m.type === "execution" && m.event === "rested");
    expect(await (await join("t1", carol)).json()).toMatchObject({ error: "not_flat" });
    expect((await post("/api/tournaments/t1/join", { token: "nope" })).status).toBe(401);

    // Joining reset the account to the tournament's cash (the default account has $100,000).
    expect((await account(alice)).balances.map((b) => [b.currency, b.cash])).toEqual([
      ["INR", 1_000_000],
      ["USDT", 10_000],
    ]);
    // Entrants wait for the bell.
    expect(await alice.request(limit("TCS", "early", "buy", 410_000, 1))).toMatchObject({ type: "reject", reason: "tournament_not_started" });

    alice.send({ op: "subscribe", channels: ["leaderboard:t1", "leaderboard:t99"] });
    expect(await alice.waitFor((m) => m.type === "subscribed")).toMatchObject({ channels: ["leaderboard:t1"] });
    expect(await alice.waitFor((m) => m.type === "error")).toMatchObject({ message: "unknown channels: leaderboard:t99" });

    clock = at(10, 1);
    // Alice buys 100 TCS at Rs 4,100 and 0.05 BTC at $80,000; Bob sells 100 TCS short at Rs 4,100.
    await mm.request(limit("TCS", "m1", "sell", 410_000, 100));
    expect(await alice.request(limit("TCS", "a1", "buy", 410_000, 100))).toMatchObject({ type: "ack" });
    await mm.request(limit("BTCUSDT", "m2", "sell", 8_000_000, 5_000));
    expect(await alice.request(limit("BTCUSDT", "a2", "buy", 8_000_000, 5_000))).toMatchObject({ type: "ack" });
    // Bob's order rests and a market maker takes it: a maker fill is a trade too.
    expect(await bob.request(limit("TCS", "b1", "sell", 410_000, 100))).toMatchObject({ type: "ack" });
    await bob.waitFor((m) => m.type === "execution" && m.clientOrderId === "b1" && m.event === "rested");
    await mm.request(limit("TCS", "m3", "buy", 410_000, 100));
    expect(await filled(bob, "b1")).toMatchObject({ liquidity: "maker", quantity: 100 });
    // The bots move the marks: TCS to Rs 4,200, BTC to $82,000.
    await mm.request(limit("TCS", "m4", "sell", 420_000, 1));
    await taker.request(limit("TCS", "t1", "buy", 420_000, 1));
    await mm.request(limit("BTCUSDT", "m5", "sell", 8_200_000, 1));
    await taker.request(limit("BTCUSDT", "t2", "buy", 8_200_000, 1));

    // Alice: +Rs 10,000 on TCS and +$100 on BTC (Rs 9,000 at 90): +Rs 19,000 on Rs 19,00,000 is +1%.
    // Bob: -Rs 10,000, or -0.526%.
    const live = await eventually(
      () => board("t1"),
      (b) => b.entries.length === 2 && Math.abs((b.entries[0]?.returnPct ?? 0) - 1) < 1e-9 && (b.entries[1]?.returnPct ?? 0) < 0,
      10_000,
    );
    expect(live.tournament).toMatchObject({ status: "live", participants: 2 });
    expect(live.fx).toEqual({ INR: 1, USDT: 90 });
    const [first, second] = live.entries;
    expect(first).toMatchObject({ rank: 1, traderId: alice.traderId, name: "alice", trades: 2, maxDrawdownPct: 0 });
    expect(first!.equity).toBeCloseTo(1_919_000, 6);
    expect(second).toMatchObject({ rank: 2, traderId: bob.traderId, name: "bob", trades: 1 });
    expect(second!.equity).toBeCloseTo(1_890_000, 6);
    expect(second!.returnPct).toBeCloseTo((-10_000 / 1_900_000) * 100, 9);
    expect(second!.maxDrawdownPct).toBeCloseTo((10_000 / 1_900_000) * 100, 9);
    // The market makers traded far more than anyone, and are not on the board.
    expect(live.entries.map((e) => e.traderId)).not.toContain(mm.traderId);
    expect(live.entries.map((e) => e.traderId)).not.toContain(taker.traderId);

    // The WebSocket channel keeps pushing the standings.
    const pushed = await alice.waitFor(
      (m) => m.type === "leaderboard" && (m.entries as { returnPct: number }[])[0]?.returnPct !== undefined && Math.abs((m.entries as { returnPct: number }[])[0]!.returnPct - 1) < 1e-9,
      10_000,
    );
    expect((pushed.entries as { traderId: string }[]).map((e) => e.traderId)).toEqual([alice.traderId, bob.traderId]);

    // The end. Trades right after it, before anyone looks, must not reach the result:
    // TCS falls to Rs 4,000 and Alice sells there, which would put Bob ahead.
    clock = at(10, 11);
    await mm.request(limit("TCS", "m6", "buy", 400_000, 100));
    expect(await alice.request(limit("TCS", "a3", "sell", 400_000, 100))).toMatchObject({ type: "ack" });
    await mm.request(limit("TCS", "m7", "sell", 400_000, 1));
    await taker.request(limit("TCS", "t3", "buy", 400_000, 1));
    const final = await board("t1");
    expect(final.tournament.status).toBe("finished");
    expect(final.asOf).toBe(at(10, 11));
    expect(final.entries.map((e) => [e.rank, e.name, e.trades])).toEqual([
      [1, "alice", 2],
      [2, "bob", 1],
    ]);
    expect(final.entries[0]!.equity).toBeCloseTo(1_919_000, 6);
    // The channel pushes the frozen result once...
    const isFinal = (m: { type: string; tournament?: unknown }) => m.type === "leaderboard" && (m.tournament as Tournament).status === "finished";
    await alice.waitFor(isFinal, 10_000);
    // ...and nothing changes it later: the same after several sampling (20 ms) and push (50 ms) intervals,
    // during which the channel stays quiet, since the result cannot change.
    await new Promise((r) => setTimeout(r, 300));
    expect(await board("t1")).toEqual(final);
    const finals = alice.messages.filter(isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.entries).toEqual(final.entries);
    const tournaments = (await (await fetch(`${base}/api/tournaments`)).json()) as Tournament[];
    expect(tournaments.map((t) => [t.id, t.status])).toEqual([["t1", "finished"]]);

    // Entrants are free to join the next one, on the same terms: Alice still holds BTC.
    await post("/api/tournaments?key=admin", { name: "Next", start: at(10, 12), end: at(10, 20) });
    expect(await (await join("t2", alice)).json()).toMatchObject({ error: "not_flat" });
    expect((await join("t2", bob)).status).toBe(409); // still short TCS
  }, 20_000);

  it("does not let an order priced while its trader joins an upcoming tournament trade before the start", async () => {
    await start();
    await post("/api/tournaments?key=admin", { name: "Cup", start: at(10, 5), end: at(10, 30) });
    const alice = await client("alice");
    const mm = await client("mm", "k");
    await mm.request(limit("TCS", "m1", "sell", 410_000, 10));

    // A market order is priced from the book before it is risk-checked and counted as in flight.
    // Alice joins during that wait, so the join finds her account flat, resets it and enters her.
    const depth = exchange.depth.bind(exchange);
    let joined: Response | undefined;
    exchange.depth = async (symbol, levels) => {
      const book = await depth(symbol, levels);
      if (symbol === "TCS" && levels === 1 && joined === undefined) joined = await join("t1", alice);
      return book;
    };
    const reply = await alice.request({ op: "order", symbol: "TCS", clientOrderId: "a1", order: { type: "market", side: "buy", quantity: 1 } });
    expect(joined?.status).toBe(200);
    // The order must not go on to trade before the bell.
    expect(reply).toMatchObject({ type: "reject", reason: "tournament_not_started" });
    expect((await account(alice)).positions.filter((p) => p.quantity !== 0)).toEqual([]);
    expect(await inrCash(alice)).toBe(1_000_000);
    expect((await board("t1")).tournament).toMatchObject({ status: "upcoming", participants: 1 });
  });

  it("queues an entry for the tournament that starts at the end of the current one, and makes it at that end", async () => {
    await start();
    await post("/api/tournaments?key=admin", { name: "First", start: at(10, 0), end: at(10, 10) });
    await post("/api/tournaments?key=admin", { name: "Second", start: at(10, 10), end: at(10, 20) });
    const alice = await client("alice");
    const bob = await client("bob");
    const mm = await client("mm", "k");
    expect((await join("t1", alice)).status).toBe(200);
    expect((await join("t1", bob)).status).toBe(200);
    expect(await (await join("t2", alice)).json()).toMatchObject({ queued: true, tournament: { id: "t2", participants: 0 } });
    expect(await (await join("t2", bob)).json()).toMatchObject({ queued: true });
    expect((await board("t2")).queued).toEqual([alice.traderId, bob.traderId]);

    // Bob buys 1 TCS and still holds it at the bell; Alice makes Rs 1,000 on 10 TCS and closes out.
    await mm.request(limit("TCS", "m1", "sell", 410_000, 11));
    expect(await bob.request(limit("TCS", "b1", "buy", 410_000, 1))).toMatchObject({ type: "ack" });
    expect(await alice.request(limit("TCS", "a1", "buy", 410_000, 10))).toMatchObject({ type: "ack" });
    await mm.request(limit("TCS", "m2", "buy", 420_000, 10));
    expect(await alice.request(limit("TCS", "a2", "sell", 420_000, 10))).toMatchObject({ type: "ack" });
    await filled(alice, "a2");

    clock = at(10, 10);
    const firstBoard = await board("t1");
    expect(firstBoard.tournament.status).toBe("finished");
    // The final sample came before the reset: Alice's Rs 1,000 counts in the first, not the second.
    expect(firstBoard.entries[0]).toMatchObject({ traderId: alice.traderId });
    expect(firstBoard.entries[0]!.equity).toBeCloseTo(1_901_000, 6);
    const second = await board("t2");
    expect(second.tournament).toMatchObject({ status: "live", participants: 1 });
    expect(second.queued).toEqual([]);
    expect(second.entries).toMatchObject([{ traderId: alice.traderId, equity: 1_900_000, returnPct: 0 }]);
    expect(await alice.waitFor((m) => m.type === "notice" && String(m.text).startsWith("Second:"))).toMatchObject({
      level: "info",
      text: "Second: your account was reset to the starting cash, and you are in.",
    });
    expect(await bob.waitFor((m) => m.type === "notice" && String(m.text).startsWith("Second:"))).toMatchObject({ level: "warning" });
    expect(await inrCash(alice)).toBe(1_000_000);
    expect((await account(bob)).positions.find((p) => p.symbol === "TCS")).toMatchObject({ quantity: 1 });
    // Alice trades in the second straight away.
    await mm.request(limit("TCS", "m3", "sell", 420_000, 1));
    expect(await alice.request(limit("TCS", "a3", "buy", 420_000, 1))).toMatchObject({ type: "ack" });
  }, 20_000);

  it("freezes the result before an auction uncross that nobody sent (the circuit breaker's reopening)", async () => {
    // Every order passes the tournament lock, which freezes an ended tournament on its own. An uncross
    // is sent by the market's timer straight to the exchange, so only the freeze on engine events stops it.
    await start({
      tournaments: { startingCash: { INR: 1_000_000 }, sampleIntervalMs: 20, pushIntervalMs: 50 },
      market: { circuitBreaker: { windowMs: 60_000, movePct: 5, haltMs: 300 } },
    });
    await post("/api/tournaments?key=admin", { name: "Halt Cup", start: at(10, 0), end: at(10, 10) });
    const alice = await client("alice");
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");
    expect((await join("t1", alice)).status).toBe(200);
    await mm.request(limit("TCS", "m1", "sell", 410_000, 10));
    expect(await alice.request(limit("TCS", "a1", "buy", 410_000, 10))).toMatchObject({ type: "ack" });

    // A 7% jump to Rs 4,400 halts TCS into a call auction; Alice is up Rs 3,000.
    await mm.request(limit("TCS", "m2", "sell", 440_000, 1));
    await taker.request(limit("TCS", "t1", "buy", 440_000, 1));
    await alice.waitFor((m) => m.type === "status" && m.symbol === "TCS" && m.phase === "auction" && m.reason === "circuit_breaker");
    // Orders crossing at Rs 4,500 wait in the auction.
    await mm.request(limit("TCS", "m3", "sell", 450_000, 1));
    await taker.request(limit("TCS", "t2", "buy", 450_000, 1));

    // The tournament ends as the auction uncrosses.
    const send = exchange.send.bind(exchange);
    exchange.send = async (symbol: string, command: EngineCommand) => {
      if (command.type === "uncross") clock = at(10, 10);
      return send(symbol, command);
    };
    // The uncross runs on the halt's real-time timer.
    expect(await taker.waitFor((m) => m.type === "execution" && m.clientOrderId === "t2" && m.event === "fill", 10_000)).toMatchObject({ price: 450_000 });
    const final = await board("t1");
    expect(final.tournament.status).toBe("finished");
    // Marked at Rs 4,400, not at the uncross price of Rs 4,500.
    expect(final.entries[0]!.equity).toBeCloseTo(1_003_000, 6);
  }, 20_000);
});

describe("tournaments and derivatives", () => {
  // A future expiring on the very instant a tournament ends. Settlement credits cash without any engine
  // event, and the cancels of orders resting on the series are engine events: before the fix the result
  // included the settlement only when nothing was resting. Now it never does, either way.
  it.each([false, true])("marks a future at its own price, and never counts settlement after the end (order resting at expiry: %s)", async (resting) => {
    await start(
      {
        derivatives: { underlyings: [{ symbol: "TCS", multiplier: 10, strikeStep: 5_000 }] },
        rollIntervalMs: 20,
        // No sampling or pushing on a timer: the end freezes the result by whichever path reaches it first.
        tournaments: { startingCash: { INR: 1_000_000 }, sampleIntervalMs: 600_000, pushIntervalMs: 600_000 },
      },
      at(10, 10),
    );
    const fut = "TCS-25OCT1030-F";
    await post("/api/tournaments?key=admin", { name: "To Expiry", start: at(10, 10), end: at(10, 30) });
    const alice = await client("alice");
    const mm = await client("mm", "k");
    const taker = await client("taker", "k");
    expect((await join("t1", alice)).status).toBe(200);

    // Alice buys 3 futures (10 shares each) at Rs 4,100; the bots then trade the future at Rs 4,150, its mark.
    await mm.request(limit(fut, "f1", "sell", 410_000, 3));
    expect(await alice.request(limit(fut, "f1", "buy", 410_000, 3))).toMatchObject({ type: "ack" });
    await mm.request(limit(fut, "f2", "sell", 415_000, 1));
    await taker.request(limit(fut, "f2", "buy", 415_000, 1));
    // TCS trades in the last minute at a VWAP of Rs 4,127.50: the settlement price.
    clock = at(10, 29, 30);
    await mm.request(limit("TCS", "s1", "sell", 412_000, 10));
    await taker.request(limit("TCS", "b1", "buy", 412_000, 10));
    await mm.request(limit("TCS", "s2", "sell", 413_000, 30));
    await taker.request(limit("TCS", "b2", "buy", 413_000, 30));
    if (resting) expect(await mm.request(limit(fut, "rest", "buy", 400_000, 1))).toMatchObject({ type: "ack" });

    clock = at(10, 30);
    // Expiry runs on the roll timer (20 ms here); the generous waits only matter on a loaded machine.
    expect(await alice.waitFor((m) => m.type === "settlement" && m.symbol === fut, 10_000)).toMatchObject({ price: 412_750, quantity: 3, amount: 825 });
    // The account got the settlement: 3 x 10 x (4127.50 - 4100) = Rs 825.
    await eventually(() => inrCash(alice), (cash) => cash === 1_000_825, 10_000);
    // The frozen result is the position at its mark when the tournament ended: 3 x 10 x (4150 - 4100) = Rs 1,500.
    const final = await board("t1");
    expect(final.tournament.status).toBe("finished");
    expect(final.asOf).toBe(at(10, 30));
    expect(final.entries[0]!.equity).toBeCloseTo(1_001_500, 6);
  }, 20_000);
});

describe("tournaments off", () => {
  it("is off unless configured", async () => {
    exchange = Exchange.start({ symbols: ["TCS"], workers: 1 });
    gateway = await Gateway.create({ exchange });
    base = await gateway.listen(0);
    expect((await fetch(`${base}/api/tournaments`)).status).toBe(404);
  });
});
