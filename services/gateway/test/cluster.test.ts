import http from "node:http";
import { Exchange } from "@ome/exchange";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUMENTS, Gateway, type GatewayOptions } from "../src/index.js";
import { TestClient } from "./client.js";

// Multi-process mode (src/cluster/): real front-end processes in front of a
// real core, with clients placed on chosen front-ends, checking what must
// hold across processes: private reports reach only their owner, duplicate
// client order ids are caught whichever front-end they arrive through, rate
// limits stay per connection, market data reaches every subscriber exactly
// once, sessions made through any front-end work on all of them, and
// nothing is left running afterwards.

const FRONTENDS = 3;
const BOT_KEY = "k";
let exchange: Exchange;
let gateway: Gateway;
let base: string;
const clients: TestClient[] = [];

async function start(options: Partial<GatewayOptions> = {}) {
  exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
  gateway = await Gateway.create({ exchange, bookIntervalMs: 20, botKey: BOT_KEY, ...options });
  base = await gateway.listenFrontends({ port: 0, processes: FRONTENDS });
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await gateway.close();
  await exchange.stop();
});

/**
 * POST /api/session on a fresh TCP connection that closes afterwards, so it is
 * spread over the front-ends like any other and does not linger as a
 * keep-alive connection that the balancer counts.
 */
function createSession(name: string): Promise<{ token: string; traderId: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/api/session`);
    const options = { host: url.hostname, port: url.port, path: url.pathname, method: "POST", agent: false, headers: { "content-type": "application/json" } };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve(JSON.parse(body) as { token: string; traderId: string }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ name, botKey: BOT_KEY }));
  });
}

/** A client whose connection is held by front-end `fe` (connections are spread by load, so retry until one lands there). */
async function clientOn(fe: number, name: string, token?: { token: string; traderId: string }): Promise<TestClient> {
  const count = (traderId: string) => {
    const per = new Map<number, number>();
    for (const f of gateway.frontendsOf(traderId)) per.set(f, (per.get(f) ?? 0) + 1);
    return per;
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    const before = token === undefined ? new Map<number, number>() : count(token.traderId);
    const session = token ?? (await createSession(name));
    // Let the front-end report the session request's connection closed, so only WebSockets are counted.
    if (token === undefined) await new Promise((r) => setTimeout(r, 30));
    const c = await TestClient.attach(base, session.token, session.traderId);
    // The front-end that gained a connection for this trader.
    const landed = [...count(c.traderId)].find(([f, n]) => n > (before.get(f) ?? 0))?.[0];
    if (landed === fe) {
      clients.push(c);
      return c;
    }
    c.close();
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`could not place a connection on front-end ${fe}`);
}

const limit = (clientOrderId: string, side: "buy" | "sell", price: number, quantity: number, symbol = "TCS") => ({
  op: "order",
  symbol,
  clientOrderId,
  order: { type: "limit", side, price, quantity },
});

describe("multi-process gateway", { timeout: 30_000 }, () => {
  it("reports fills only to the owner, on every front-end the owner is connected through", async () => {
    await start();
    const alice = await clientOn(0, "alice");
    const bob = await clientOn(1, "bob");
    const watcher = await clientOn(2, "watcher");
    const alice2 = await clientOn(2, "", { token: alice.token, traderId: alice.traderId });
    watcher.send({ op: "subscribe", channels: ["trades:TCS"] });
    await watcher.waitFor((m) => m.type === "subscribed");

    expect(await alice.request(limit("a1", "sell", 410_000, 5))).toMatchObject({ type: "ack" });
    expect(await bob.request(limit("b1", "buy", 410_000, 5))).toMatchObject({ type: "ack" });
    const fill = (c: TestClient, id: string) => c.waitFor((m) => m.type === "execution" && m.event === "fill" && m.clientOrderId === id);
    expect(await fill(alice, "a1")).toMatchObject({ side: "sell", price: 410_000, quantity: 5, liquidity: "maker" });
    expect(await fill(alice2, "a1")).toMatchObject({ side: "sell", price: 410_000, quantity: 5, liquidity: "maker" });
    expect(await fill(bob, "b1")).toMatchObject({ side: "buy", liquidity: "taker" });
    expect(await watcher.waitFor((m) => m.type === "trade")).toMatchObject({ symbol: "TCS", trade: { price: 410_000, quantity: 5 } });
    await new Promise((r) => setTimeout(r, 100));

    // Nobody sees anyone else's executions, ids or names.
    const leaks = (c: TestClient, others: string[]) => c.messages.filter((m) => others.some((o) => JSON.stringify(m).includes(o)));
    expect(leaks(bob, [alice.traderId, "a1", "alice"])).toEqual([]);
    expect(leaks(alice, [bob.traderId, "b1", "bob"])).toEqual([]);
    expect(leaks(watcher, [alice.traderId, bob.traderId, "a1", "b1"])).toEqual([]);
    expect(watcher.messages.filter((m) => m.type === "execution")).toEqual([]);
  });

  it("catches duplicate client order ids sent at once through two front-ends", async () => {
    await start();
    const one = await clientOn(0, "dup");
    const two = await clientOn(1, "", { token: one.token, traderId: one.traderId });
    const ids = Array.from({ length: 100 }, (_, i) => `d${i}`);
    const replies = await Promise.all(ids.flatMap((id) => [one, two].map((c) => c.request(limit(id, "buy", 400_000, 1)))));
    for (const id of ids) {
      const mine = replies.filter((r) => r.clientOrderId === id);
      expect(mine.filter((r) => r.type === "ack")).toHaveLength(1);
      expect(mine.filter((r) => r.type === "reject" && r.reason === "duplicate_client_order_id")).toHaveLength(1);
    }
  });

  it("rate-limits each connection separately", async () => {
    await start({ rateLimit: { burst: 5, perSecond: 0.001 } });
    const one = await clientOn(0, "fast");
    const two = await clientOn(1, "", { token: one.token, traderId: one.traderId });
    for (const [c, prefix] of [
      [one, "p"],
      [two, "q"],
    ] as const) {
      const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => c.request(limit(`${prefix}${i}`, "buy", 400_000, 1))));
      expect(replies.filter((r) => r.type === "ack")).toHaveLength(5);
      expect(replies.filter((r) => r.reason === "rate_limited")).toHaveLength(3);
    }
  });

  it("delivers every trade to every subscriber exactly once and in order, with no gap for a late subscriber", async () => {
    await start();
    const maker = await clientOn(0, "maker");
    const taker = await clientOn(1, "taker");
    const watchers: TestClient[] = [];
    for (let i = 0; i < 30; i++) {
      const session = await createSession(`w${i}`);
      const w = await TestClient.attach(base, session.token, session.traderId);
      clients.push(w);
      watchers.push(w);
    }
    // Spread by the balancer over every front-end.
    expect(new Set(watchers.flatMap((w) => gateway.frontendsOf(w.traderId))).size).toBe(FRONTENDS);
    for (const w of watchers) w.send({ op: "subscribe", channels: ["trades:TCS", "book:TCS"] });
    for (const w of watchers) {
      expect(await w.waitFor((m) => m.type === "subscribed")).toMatchObject({ channels: ["trades:TCS", "book:TCS"] });
      await w.waitFor((m) => m.type === "trades"); // the initial snapshot
    }

    let late: TestClient | null = null;
    const N = 60;
    for (let i = 0; i < N; i++) {
      await maker.request(limit(`m${i}`, "sell", 410_000, 1));
      await taker.request(limit(`t${i}`, "buy", 410_000, 1));
      if (i === N / 2) {
        late = await TestClient.connect(base, "late");
        clients.push(late);
        late.send({ op: "subscribe", channels: ["trades:TCS"] });
      }
    }
    const tradeIds = (c: TestClient) => c.messages.filter((m) => m.type === "trade").map((m) => (m.trade as { id: number }).id);
    for (const w of watchers) await w.waitFor(() => tradeIds(w).length >= N, 5_000);
    await new Promise((r) => setTimeout(r, 200));
    const expected = tradeIds(watchers[0]!);
    expect(expected).toHaveLength(N);
    expect(new Set(expected).size).toBe(N);
    for (const w of watchers) expect(tradeIds(w)).toEqual(expected);
    for (const w of watchers) expect(w.messages.some((m) => m.type === "book" && m.symbol === "TCS")).toBe(true);

    // The late subscriber: its snapshot plus what it was sent after cover every trade once.
    const snapshot = (late!.messages.find((m) => m.type === "trades")!.trades as { id: number }[]).map((t) => t.id);
    const seen = [...snapshot, ...tradeIds(late!)];
    expect(seen).toEqual(expected);
  });

  it("keeps a connection's executions ahead of its ack, and its commands in order, for 200 orders each followed by its cancel", async () => {
    // 400 requests: above the default burst of 200.
    await start({ rateLimit: { burst: 1_000, perSecond: 1_000 } });
    const c = await clientOn(0, "pairs");
    // Each cancel right behind its order: it must not reach the engine first.
    for (let i = 0; i < 200; i++) {
      c.send({ ...limit(`o${i}`, "buy", 400_000, 1), reqId: `o${i}` });
      c.send({ op: "cancel", reqId: `c${i}`, symbol: "TCS", clientOrderId: `o${i}` });
    }
    await c.waitFor((m) => m.type === "ack" && m.reqId === "c199", 10_000);
    for (let i = 0; i < 200; i++) {
      const at = (match: (m: (typeof c.messages)[number]) => boolean) => c.messages.findIndex(match);
      const rested = at((m) => m.type === "execution" && m.event === "rested" && m.clientOrderId === `o${i}`);
      const ack = at((m) => m.type === "ack" && m.reqId === `o${i}`);
      const cancelled = at((m) => m.type === "execution" && m.event === "cancelled" && m.clientOrderId === `o${i}`);
      const cancelAck = at((m) => m.type === "ack" && m.reqId === `c${i}`);
      expect(rested).toBeGreaterThanOrEqual(0);
      expect(rested).toBeLessThan(ack);
      expect(cancelled).toBeLessThan(cancelAck);
    }
    expect(c.messages.filter((m) => m.type === "reject")).toEqual([]);
  });

  it("checks tokens through a front-end, and holds messages sent before the check", async () => {
    await start();
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws?token=nope`);
    expect(await new Promise((resolve) => socket.addEventListener("close", (e) => resolve(e.code)))).toBe(4001);

    const { token } = (await (
      await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "eager" }) })
    ).json()) as { token: string };
    // Sent the moment each socket opens, before the core has answered the front-end's token check:
    // the order is answered by the core, the ping and the bad frame by the front-end itself.
    const eager = async (n: number) => {
      const socket = new WebSocket(`${base.replace("http", "ws")}/ws?token=${token}`);
      const types: string[] = [];
      const acked = new Promise<void>((resolve) =>
        socket.addEventListener("message", (e) => {
          const m = JSON.parse(String(e.data)) as { type: string };
          types.push(m.type);
          if (m.type === "ack") resolve();
        }),
      );
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ op: "ping", reqId: n }));
        socket.send("not json");
        socket.send(JSON.stringify({ ...limit(`e${n}`, "buy", 400_000, 1), reqId: `e${n}` }));
      });
      await acked;
      socket.close();
      return types;
    };
    for (const types of await Promise.all(Array.from({ length: 10 }, (_, n) => eager(n)))) {
      // As in one process: welcome first, then the replies in the order the messages were sent.
      expect(types[0]).toBe("welcome");
      expect(types.filter((t) => t === "pong" || t === "error" || t === "ack")).toEqual(["pong", "error", "ack"]);
    }
  });

  it("stops the core's plain-English parse when the browser gives up through a front-end", async () => {
    const signals: AbortSignal[] = [];
    // A model that answers only when told to stop.
    const slowModel = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init!.signal!;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }) as typeof fetch;
    await start({ parseOrder: { warmUp: false, fetch: slowModel, timeoutMs: 20_000 } });
    const { token } = await createSession("talker");
    const parse = (signal: AbortSignal) =>
      fetch(`${base}/api/parse-order`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: "sell 3 tcs if it falls to 4000" }),
        signal,
      });
    const first = new AbortController();
    const request = parse(first.signal);
    await expect.poll(() => signals.length).toBe(1);
    first.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    // The model call in the core was stopped, long before its 20 s cut-off...
    await expect.poll(() => signals[0]!.aborted).toBe(true);
    // ...and the trader's one model slot was freed: the next request reaches the model too.
    const second = new AbortController();
    void parse(second.signal).catch(() => {});
    await expect.poll(() => signals.length).toBe(2);
    second.abort();
    await expect.poll(() => signals[1]!.aborted).toBe(true);
  });

  it("accepts sessions created through any front-end on every front-end", async () => {
    await start();
    const sessions = [];
    for (let i = 0; i < 2 * FRONTENDS; i++) sessions.push(await createSession("anywhere"));
    for (const [i, s] of sessions.entries()) await clientOn(i % FRONTENDS, "", s);
    const health = (await (await fetch(`${base}/api/health`)).json()) as { traders: number; connections: number };
    expect(health).toMatchObject({ traders: 2 * FRONTENDS, connections: 2 * FRONTENDS });
  });

  it("survives a front-end crashing: its clients reconnect, the others keep trading", async () => {
    await start();
    const victim = await clientOn(0, "victim");
    const other = await clientOn(1, "other");
    expect(await victim.request(limit("v1", "buy", 400_000, 1))).toMatchObject({ type: "ack" });
    const closed = new Promise((resolve) => victim.socket.addEventListener("close", resolve));
    process.kill(gateway.frontendPids()[0]!);
    await closed;
    expect(await other.request(limit("o1", "buy", 400_000, 1))).toMatchObject({ type: "ack" });
    // Same token, any front-end (the crashed one is restarted): the resting order is still there.
    const back = await TestClient.attach(base, victim.token, victim.traderId);
    clients.push(back);
    expect(await back.request({ op: "cancel", symbol: "TCS", clientOrderId: "v1" })).toMatchObject({ type: "ack" });
    expect(await back.waitFor((m) => m.type === "execution" && m.event === "cancelled" && m.clientOrderId === "v1")).toMatchObject({ remaining: 1 });
  });

  it("leaves no front-end process running after close", async () => {
    await start();
    await clientOn(1, "bye");
    const pids = gateway.frontendPids();
    expect(pids).toHaveLength(FRONTENDS);
    await gateway.close();
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    expect(alive).toEqual([]);
    // afterEach closes again: harmless.
  });
});
