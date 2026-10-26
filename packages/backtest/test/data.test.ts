import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTo } from "@ome/bots";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggTradesCsv,
  BTCUSDT,
  downloadAggTrades,
  downloadKlines,
  klinesCsv,
  loadMarketData,
  parseKlines,
  parseTrades,
  trimDecimal,
  type AggTrade,
  type Kline,
} from "../src/index.js";
import { FIXTURE, FIXTURE_KLINES } from "./helpers.js";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const temp = (name: string, text: string) => {
  dir ??= mkdtempSync(join(tmpdir(), "backtest-"));
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

// Two real trades from the fixture, in the REST API's format: its first trade
// (buyer-initiated) and its first seller-initiated one, 12 trades later.
const REST: AggTrade[] = [
  { a: 4096399798, p: "81466.01000000", q: "0.07821000", f: 6786974125, l: 6786974155, T: 1792765800336, m: false, M: true },
  { a: 4096399810, p: "81469.33000000", q: "0.00012000", f: 6786974183, l: 6786974183, T: 1792765800580, m: true, M: true },
];
const PARSED = [
  { time: 1792765800336, price: 8_146_601, quantity: 7_821, takerSide: "buy" },
  { time: 1792765800580, price: 8_146_933, quantity: 12, takerSide: "sell" },
];

describe("reading trades", () => {
  it("reads the fixture's aggTrades CSV exactly", () => {
    const head = readFileSync(FIXTURE, "utf8").split("\n").slice(0, 14).join("\n");
    const trades = parseTrades(head, BTCUSDT);
    expect([trades[0], trades[12]]).toEqual(PARSED);
  });

  it("reads every accepted format into the same trades", () => {
    // Binance's bulk dump: no header, True/False, microsecond timestamps (spot data since 2025).
    const dump = "4096399798,81466.01000000,0.07821000,6786974125,6786974155,1792765800336000,False,True\n4096399810,81469.33000000,0.00012000,6786974183,6786974183,1792765800580512,True,True\n";
    expect(parseTrades(dump, BTCUSDT)).toEqual(PARSED);
    expect(parseTrades(aggTradesCsv(REST), BTCUSDT)).toEqual(PARSED);
    expect(parseTrades(JSON.stringify(REST), BTCUSDT)).toEqual(PARSED);
    expect(parseTrades(REST.map((r) => JSON.stringify(r)).join("\n"), BTCUSDT)).toEqual(PARSED);
    // Messages from the live trade stream, one per line.
    const stream = REST.map((r) => JSON.stringify({ e: "trade", E: r.T, s: "BTCUSDT", t: r.f, p: r.p, q: r.q, T: r.T, m: r.m, M: true })).join("\n");
    expect(parseTrades(stream, BTCUSDT)).toEqual(PARSED);
  });

  it("reads a session recorded by the bots (pnpm bots -- --binance --record=...)", () => {
    const path = temp("btc.jsonl", "");
    const record = recordTo(path);
    for (const r of REST) record({ price: r.p, quantity: r.q, buyerIsMaker: r.m, time: r.T });
    const data = loadMarketData(path, BTCUSDT);
    expect(data).toEqual({ kind: "trades", symbol: "BTCUSDT", trades: PARSED, warmup: [] });
  });

  it("fails loudly on bad data instead of skipping it", () => {
    expect(() => parseTrades(aggTradesCsv([REST[1]!, REST[0]!].map((r, i) => ({ ...r, T: r.T - i }))), BTCUSDT)).toThrow(/earlier than the one before/);
    expect(() => parseTrades("agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n1,abc,1,1,1,5,true\n", BTCUSDT, "x.csv")).toThrow('x.csv:2: bad price "abc"');
    expect(() => parseTrades("1,81466.01,0.1\n", BTCUSDT, "short.csv")).toThrow("short.csv:1: expected at least");
    // A value finer than the instrument's grid would be truncated, quietly changing it: it fails instead.
    const row = (price: string, quantity: string) => `1,${price},${quantity},1,1,1792765800336,false,true\n`;
    expect(() => parseTrades(row("81466.019", "0.1"), BTCUSDT, "fine.csv")).toThrow('fine.csv:1: price "81466.019" is finer than the instrument\'s 0.01 grid');
    expect(() => parseTrades(row("81466.01", "0.123456"), BTCUSDT, "fine.csv")).toThrow('fine.csv:1: quantity "0.123456" is finer');
    expect(() => parseKlines("open_time,open,high,low,close,volume\n0,1,1,1,1,0.0000001\n", BTCUSDT, "k.csv")).toThrow('k.csv:2: volume "0.0000001" is finer');
    // Binance pads its decimals with zeros; those are exact.
    expect(parseTrades(row("81466.01000000", "0.12345000"), BTCUSDT)[0]).toMatchObject({ price: 8_146_601, quantity: 12_345 });
  });

  it("trims trailing zeros without changing the value", () => {
    expect(["80806.70000000", "81000.00000000", "0.00123000", "5", "10"].map(trimDecimal)).toEqual(["80806.7", "81000", "0.00123", "5", "10"]);
  });
});

describe("reading klines", () => {
  const KLINE: Kline = [1792751400000, "81730.00000000", "81730.00000000", "81700.00000000", "81711.66000000", "2.71875000", 1792751459999, "222186.9", 1680, "1.2", "98000.1", "0"];
  const BAR = { time: 1792751400000, open: 8_173_000, high: 8_173_000, low: 8_170_000, close: 8_171_166, volume: 271_875 };

  it("reads services/ai/volatility's CSV and Binance's 12-column dump", () => {
    expect(parseKlines(klinesCsv([KLINE]), BTCUSDT)).toEqual([BAR]);
    expect(parseKlines(`${KLINE.join(",")}\n`, BTCUSDT)).toEqual([BAR]);
    expect(parseKlines(readFileSync(FIXTURE_KLINES, "utf8"), BTCUSDT)[0]).toEqual(BAR);
  });

  it("loads a klines file as bar data, and uses only warm-up bars that closed before the start", () => {
    const bars = loadMarketData(FIXTURE_KLINES, BTCUSDT);
    expect(bars.kind).toBe("bars");
    const trades = temp("t.csv", aggTradesCsv(REST));
    const data = loadMarketData(trades, BTCUSDT, { warmup: FIXTURE_KLINES });
    // The klines run to 15:00, but the trades start at 14:30:00.336: only bars closed by then count.
    expect(data.warmup).toHaveLength(240);
    expect(data.warmup.every((b) => b.time + 60_000 <= REST[0]!.T)).toBe(true);
  });
});

/** A fake Binance REST API over `trades` and `klines`, recording each request. */
function fakeBinance(trades: AggTrade[], klines: Kline[] = [], hooks: { status?: (n: number) => number; headers?: (n: number) => Record<string, string> } = {}) {
  const urls: string[] = [];
  const fetchFake = (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const n = urls.length;
    const status = hooks.status?.(n) ?? 200;
    const q = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
    const limit = q("limit") ?? 500;
    let body: unknown = [];
    if (url.pathname.endsWith("/aggTrades")) {
      const fromId = q("fromId");
      const startTime = q("startTime");
      const endTime = q("endTime");
      body = (fromId !== undefined ? trades.filter((tr) => tr.a >= fromId) : trades.filter((tr) => tr.T >= startTime! && tr.T <= endTime!)).slice(0, limit);
    } else if (url.pathname.endsWith("/klines")) {
      body = klines.filter((k) => k[0] >= q("startTime")! && k[0] <= q("endTime")!).slice(0, limit);
    }
    return new Response(status === 200 ? JSON.stringify(body) : "slow down", { status, headers: hooks.headers?.(n) ?? {} });
  }) as typeof fetch;
  return { fetch: fetchFake, urls };
}

const T0 = 1_792_765_800_000;
const HOUR = 3_600_000;
const synthetic = (n: number, time = (i: number) => T0 + i * 100): AggTrade[] =>
  Array.from({ length: n }, (_, i) => ({ a: 1_000 + i, p: "81000.5", q: "0.001", f: 5_000 + i, l: 5_000 + i, T: time(i), m: i % 2 === 0, M: true }));

describe("downloading from Binance", () => {
  const sleeps: number[] = [];
  const options = (f: typeof fetch) => ({ fetch: f, sleep: async (ms: number) => void sleeps.push(ms), hosts: ["https://a.test", "https://b.test"] });
  afterEach(() => void sleeps.splice(0));

  it("pages by time, then by id, and stops at the end of the window", async () => {
    const api = fakeBinance(synthetic(2_500));
    const got = await downloadAggTrades("BTCUSDT", T0, T0 + 2_200 * 100, options(api.fetch));
    expect(got).toHaveLength(2_200);
    expect(got.at(-1)!.a).toBe(1_000 + 2_199);
    expect(api.urls).toEqual([
      `https://a.test/api/v3/aggTrades?symbol=BTCUSDT&startTime=${T0}&endTime=${T0 + 220_000 - 1}&limit=1000`,
      "https://a.test/api/v3/aggTrades?symbol=BTCUSDT&fromId=2000&limit=1000",
      "https://a.test/api/v3/aggTrades?symbol=BTCUSDT&fromId=3000&limit=1000",
    ]);
    expect(sleeps).toEqual([250, 250]); // a pause between pages
  });

  it("keeps paging past a quiet first hour: a short time page is not the end", async () => {
    // 500 trades in the first hour, then 3,000 over the next two.
    const trades = synthetic(3_500, (i) => (i < 500 ? T0 + i * 7_000 : T0 + HOUR + (i - 500) * 2_400));
    const api = fakeBinance(trades);
    const got = await downloadAggTrades("XYZUSDT", T0, T0 + 3 * HOUR, options(api.fetch));
    expect(got).toEqual(trades);
    expect(api.urls).toEqual([
      `https://a.test/api/v3/aggTrades?symbol=XYZUSDT&startTime=${T0}&endTime=${T0 + HOUR - 1}&limit=1000`,
      "https://a.test/api/v3/aggTrades?symbol=XYZUSDT&fromId=1500&limit=1000",
      "https://a.test/api/v3/aggTrades?symbol=XYZUSDT&fromId=2500&limit=1000",
      "https://a.test/api/v3/aggTrades?symbol=XYZUSDT&fromId=3500&limit=1000",
      "https://a.test/api/v3/aggTrades?symbol=XYZUSDT&fromId=4500&limit=1000", // empty: nothing newer exists
    ]);
  });

  it("refuses a tape with a gap in it", async () => {
    const trades = synthetic(1_500).filter((tr) => tr.a !== 1_700);
    await expect(downloadAggTrades("BTCUSDT", T0, T0 + 150_000, options(fakeBinance(trades).fetch))).rejects.toThrow("gap in aggregated trades: 1699 is followed by 1701");
  });

  it("waits as long as Binance asks after a 429, and backs off near the weight limit", async () => {
    const api = fakeBinance(synthetic(10), [], {
      status: (n) => (n === 1 ? 429 : 200),
      headers: (n): Record<string, string> => (n === 1 ? { "retry-after": "3" } : { "x-mbx-used-weight-1m": "5000" }),
    });
    const got = await downloadAggTrades("BTCUSDT", T0, T0 + 1_000, options(api.fetch));
    expect(got).toHaveLength(10);
    expect(sleeps[0]).toBe(3_000);
    expect(sleeps[1]).toBeGreaterThan(1_000); // 5,000 of 6,000 used: wait for the next minute
  });

  it("falls back to the next host when one cannot be reached", async () => {
    const api = fakeBinance(synthetic(5));
    const flaky = (async (input: string | URL) => {
      if (String(input).startsWith("https://a.test")) throw new TypeError("fetch failed");
      return api.fetch(input);
    }) as typeof fetch;
    expect(await downloadAggTrades("BTCUSDT", T0, T0 + 500, options(flaky))).toHaveLength(5);
  });

  it("pages klines by open time", async () => {
    const klines: Kline[] = Array.from({ length: 2_500 }, (_, i) => [T0 + i * 60_000, "1", "1", "1", "1", "1", T0 + i * 60_000 + 59_999, "1", 1]);
    const api = fakeBinance([], klines);
    const got = await downloadKlines("BTCUSDT", T0, T0 + 2_100 * 60_000, options(api.fetch));
    expect(got).toHaveLength(2_100);
    expect(api.urls).toHaveLength(3);
  });
});
