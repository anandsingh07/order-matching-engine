import { existsSync, readFileSync } from "node:fs";
import { toUnits, type Instrument } from "@ome/client";
import type { MarketData, MarketTrade, MinuteBar } from "./types.js";

// Real market data for the backtester, and a downloader for it.
//
// Trades come from Binance's aggregated-trade endpoint (public, no key). An
// aggregated trade is one taker order's fills at one price, which is the unit
// of taker flow the backtest needs. Accepted files:
//   - aggTrades CSV in the column order of Binance's bulk dumps
//     (data.binance.vision), with or without a header; the downloader writes it
//   - JSON Lines as `pnpm bots -- --record` writes it ({price, quantity, buyerIsMaker, time}),
//     or raw aggTrade / trade-stream objects, one per line
//   - a JSON array of aggTrades, as the REST API returns it
//   - 1-minute klines CSV: services/ai/volatility/data.py's format, or a bulk dump
// Prices stay exact: decimal strings become integer ticks with toUnits, never
// through floating point.

export const MINUTE_MS = 60_000;

/** The exchange's BTC/USDT instrument (services/gateway/src/instruments.ts): cents, and 0.00001 BTC lots, as on Binance. */
export const BTCUSDT: Instrument = {
  symbol: "BTCUSDT",
  name: "Bitcoin / Tether",
  currency: "USDT",
  priceScale: 100,
  quantityScale: 100_000,
  tickSize: 1,
  lotSize: 1,
  referencePrice: 8_000_000,
};

export const BINANCE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

/** Binance's REST aggregated trade. */
export interface AggTrade {
  a: number;
  p: string;
  q: string;
  f: number;
  l: number;
  T: number;
  m: boolean;
  M: boolean;
}

/** One kline as the REST API returns it: open time, open, high, low, close, volume, close time, quote volume, trades, ... */
export type Kline = [number, string, string, string, string, string, number, string, number, ...unknown[]];

// Bulk dumps switched spot timestamps to microseconds in 2025. No millisecond
// timestamp is anywhere near 1e14 (the year 5138), so the two cannot be confused.
const toMs = (t: number) => (t > 1e14 ? Math.floor(t / 1000) : t);

/**
 * Exact integer units of a decimal string. toUnits drops digits past the
 * scale, which would quietly change a price, so a value finer than the
 * instrument's grid fails instead. Trailing zeros are fine: Binance pads its
 * decimals to eight places.
 */
function exactUnits(text: string, scale: number, what: string, where: string): number | null {
  const fraction = /\.(\d*)$/.exec(text.trim())?.[1] ?? "";
  if (/[1-9]/.test(fraction.slice(Math.round(Math.log10(scale))))) throw new Error(`${where}: ${what} "${text}" is finer than the instrument's ${1 / scale} grid`);
  return toUnits(text, scale);
}

function units(text: string, scale: number, what: string, where: string): number {
  const value = exactUnits(text, scale, what, where);
  if (value === null || value <= 0) throw new Error(`${where}: bad ${what} "${text}"`);
  return value;
}

function trade(price: string, quantity: string, buyerIsMaker: boolean, time: number, instrument: Instrument, where: string): MarketTrade {
  return {
    time: toMs(time),
    price: units(price, instrument.priceScale, "price", where),
    quantity: units(quantity, instrument.quantityScale, "quantity", where),
    // The buyer resting means a seller crossed the spread.
    takerSide: buyerIsMaker ? "sell" : "buy",
  };
}

const bool = (text: string) => text.trim().toLowerCase() === "true";

/** One trade from any of the JSON shapes: a recorded RawTrade, a REST aggTrade or a stream message. */
function tradeFromObject(o: Record<string, unknown>, instrument: Instrument, where: string): MarketTrade {
  if (typeof o.price === "string" && typeof o.quantity === "string" && typeof o.buyerIsMaker === "boolean" && typeof o.time === "number") {
    return trade(o.price, o.quantity, o.buyerIsMaker, o.time, instrument, where);
  }
  if (typeof o.p === "string" && typeof o.q === "string" && typeof o.m === "boolean" && typeof o.T === "number") {
    return trade(o.p, o.q, o.m, o.T, instrument, where);
  }
  throw new Error(`${where}: not a trade: ${JSON.stringify(o).slice(0, 120)}`);
}

const isNumeric = (field: string | undefined) => field !== undefined && /^\s*-?\d+(\.\d*)?\s*$/.test(field);

/** A CSV cell, or an error that says where the row is short. */
function cell(row: readonly string[], index: number, where: string): string {
  const value = row[index];
  if (value === undefined) throw new Error(`${where}: expected at least ${index + 1} columns, found ${row.length}`);
  return value.trim();
}

function csvRows(text: string): { header: string[] | null; rows: string[][]; firstLine: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const first = lines[0]?.split(",") ?? [];
  const header = first.length > 0 && !isNumeric(first[0]) ? first.map((h) => h.trim().toLowerCase()) : null;
  return { header, rows: lines.slice(header === null ? 0 : 1).map((l) => l.split(",")), firstLine: header === null ? 1 : 2 };
}

/** Parses trades from text in any accepted format (see the top of this file). */
export function parseTrades(text: string, instrument: Instrument, source = "trades"): MarketTrade[] {
  const start = text.trimStart();
  let trades: MarketTrade[];
  if (start.startsWith("[")) {
    const array = JSON.parse(start) as Record<string, unknown>[];
    trades = array.map((o, i) => tradeFromObject(o, instrument, `${source}[${i}]`));
  } else if (start.startsWith("{")) {
    trades = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.trim() !== "") trades.push(tradeFromObject(JSON.parse(line) as Record<string, unknown>, instrument, `${source}:${i + 1}`));
    });
  } else {
    const { header, rows, firstLine } = csvRows(text);
    if (header !== null && header.includes("open_time")) throw new Error(`${source}: this is a klines file; load it with parseKlines`);
    // The bulk dump's column order: id, price, quantity, first id, last id, time, buyer is maker, best match.
    const col = (name: string, fallback: number) => (header === null ? fallback : header.indexOf(name));
    const [p, q, t, m] = [col("price", 1), col("quantity", 2), col("transact_time", 5), col("is_buyer_maker", 6)];
    if ([p, q, t, m].some((c) => c < 0)) throw new Error(`${source}: expected aggTrades columns price, quantity, transact_time, is_buyer_maker`);
    trades = rows.map((r, i) => {
      const where = `${source}:${i + firstLine}`;
      return trade(cell(r, p, where), cell(r, q, where), bool(cell(r, m, where)), Number(cell(r, t, where)), instrument, where);
    });
  }
  for (let i = 1; i < trades.length; i++) {
    if (trades[i]!.time < trades[i - 1]!.time) throw new Error(`${source}: trade ${i + 1} is earlier than the one before it`);
  }
  return trades;
}

/** Parses 1-minute klines: services/ai/volatility/data.py's CSV (with a header) or a 12-column bulk dump. */
export function parseKlines(text: string, instrument: Instrument, source = "klines"): MinuteBar[] {
  const { header, rows, firstLine } = csvRows(text);
  const col = (name: string, fallback: number) => (header === null ? fallback : header.indexOf(name));
  const cols = [col("open_time", 0), col("open", 1), col("high", 2), col("low", 3), col("close", 4), col("volume", 5)];
  if (cols.some((c) => c < 0)) throw new Error(`${source}: expected klines columns open_time, open, high, low, close, volume`);
  const [t, o, h, l, c, v] = cols as [number, number, number, number, number, number];
  const bars = rows.map((r, i) => {
    const where = `${source}:${i + firstLine}`;
    const price = (k: number) => units(cell(r, k, where), instrument.priceScale, "price", where);
    return {
      time: toMs(Number(cell(r, t, where))),
      open: price(o),
      high: price(h),
      low: price(l),
      close: price(c),
      volume: exactUnits(cell(r, v, where), instrument.quantityScale, "volume", where) ?? 0,
    };
  });
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.time <= bars[i - 1]!.time) throw new Error(`${source}: bar ${i + 1} is not after the one before it`);
  }
  return bars;
}

/**
 * The complete 1-minute bars of a tape: every minute from the first trade's
 * to the one before `until` (default: the last trade's minute, which may be
 * incomplete and is left out). A minute without trades is a flat bar at the
 * last price, as the backtest engine and @ome/volatility's MinuteBars make it.
 */
export function tapeBars(trades: readonly MarketTrade[], until?: number): MinuteBar[] {
  const first = trades[0];
  if (first === undefined) return [];
  const end = Math.floor((until ?? trades.at(-1)!.time) / MINUTE_MS) * MINUTE_MS;
  const bars: MinuteBar[] = [];
  let bar: MinuteBar = { time: Math.floor(first.time / MINUTE_MS) * MINUTE_MS, open: first.price, high: first.price, low: first.price, close: first.price, volume: 0 };
  let traded = false;
  for (const t of trades) {
    if (t.time >= end) break;
    while (t.time >= bar.time + MINUTE_MS) {
      bars.push(bar);
      bar = { time: bar.time + MINUTE_MS, open: bar.close, high: bar.close, low: bar.close, close: bar.close, volume: 0 };
      traded = false;
    }
    if (!traded) Object.assign(bar, { open: t.price, high: t.price, low: t.price, close: t.price });
    traded = true;
    bar.high = Math.max(bar.high, t.price);
    bar.low = Math.min(bar.low, t.price);
    bar.close = t.price;
    bar.volume += t.quantity;
  }
  while (bar.time + MINUTE_MS <= end) {
    bars.push(bar);
    bar = { time: bar.time + MINUTE_MS, open: bar.close, high: bar.close, low: bar.close, close: bar.close, volume: 0 };
  }
  return bars;
}

const isKlines = (text: string) => {
  const { header, rows } = csvRows(text.slice(0, 4096));
  return header !== null ? header.includes("open_time") : (rows[0]?.length ?? 0) >= 12;
};

/** The klines file the downloader writes next to a trades file: `x.aggtrades.csv` -> `x.klines.csv`. */
export function siblingKlines(path: string): string | null {
  const sibling = path.replace(/\.aggtrades\.csv$/i, ".klines.csv");
  return sibling !== path && existsSync(sibling) ? sibling : null;
}

/**
 * Loads a trades or klines file. Bars from `warmup` (a klines file) that
 * closed by the first event become warm-up history; later ones are dropped,
 * so warm-up can never leak the period being tested.
 */
export function loadMarketData(path: string, instrument: Instrument, options: { warmup?: string | null } = {}): MarketData {
  const text = readFileSync(path, "utf8");
  const warmupBars = options.warmup == null ? [] : parseKlines(readFileSync(options.warmup, "utf8"), instrument, options.warmup);
  const before = (start: number) => warmupBars.filter((b) => b.time + MINUTE_MS <= start);
  if (isKlines(text)) {
    const bars = parseKlines(text, instrument, path);
    return { kind: "bars", symbol: instrument.symbol, bars, warmup: before(bars[0]?.time ?? 0) };
  }
  const trades = parseTrades(text, instrument, path);
  return { kind: "trades", symbol: instrument.symbol, trades, warmup: before(trades[0]?.time ?? 0) };
}

// ---- the downloader ----

export interface FetchOptions {
  hosts?: string[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between pages, in ms. */
  pauseMs?: number;
  log?: (line: string) => void;
}

/** Binance's request-weight budget per minute per IP; aggTrades and klines pages cost 2-4 each. */
const WEIGHT_LIMIT = 6_000;
const PAGE = 1_000;

/**
 * GETs one API path, trying each host in turn. Respects the rate limit: on
 * 429 (too many requests) or 418 (banned for ignoring 429s) it waits the
 * Retry-After the server asks for, and when the minute's used weight passes
 * 80% of the budget it waits for the next minute rather than risk a ban.
 */
async function getJson(path: string, o: Required<Omit<FetchOptions, "log">> & Pick<FetchOptions, "log">): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    const host = o.hosts[attempt % o.hosts.length]!;
    let response: Response;
    try {
      response = await o.fetch(`${host}${path}`);
    } catch (error) {
      lastError = error; // network trouble: try the next host
      continue;
    }
    if (response.status === 429 || response.status === 418) {
      const wait = Number(response.headers.get("retry-after") ?? 60) * 1000;
      o.log?.(`binance: HTTP ${response.status}, waiting ${wait / 1000} s as asked`);
      await o.sleep(wait);
      continue;
    }
    if (response.status >= 500) {
      lastError = new Error(`HTTP ${response.status} from ${host}`);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${host}${path}: ${await response.text()}`);
    const used = Number(response.headers.get("x-mbx-used-weight-1m") ?? 0);
    if (used > 0.8 * WEIGHT_LIMIT) {
      const wait = MINUTE_MS - (Date.now() % MINUTE_MS) + 1_000;
      o.log?.(`binance: used weight ${used}/${WEIGHT_LIMIT} this minute, pausing ${Math.round(wait / 1000)} s`);
      await o.sleep(wait);
    }
    return response.json();
  }
  throw new Error(`all Binance hosts failed: ${String(lastError)}`);
}

function withDefaults(options: FetchOptions) {
  return {
    hosts: options.hosts ?? BINANCE_HOSTS,
    fetch: options.fetch ?? fetch,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    pauseMs: options.pauseMs ?? 250,
    log: options.log,
  };
}

/**
 * Every aggregated trade in [start, end), oldest first. The first page is
 * found by time (the API allows at most an hour per time query); after that
 * pages follow by id, and ids must be consecutive, so a gap in the data
 * fails loudly instead of quietly thinning the tape.
 */
export async function downloadAggTrades(symbol: string, start: number, end: number, options: FetchOptions = {}): Promise<AggTrade[]> {
  const o = withDefaults(options);
  const out: AggTrade[] = [];
  let page: AggTrade[] = [];
  // Whether the page in hand can be the last one: a time page only if its
  // hour reaches `end` (a short page from a quiet first hour says nothing
  // about the hours after it), an id page whenever it comes back short.
  let final = false;
  for (let from = start; from < end && page.length === 0; from += 3_600_000) {
    const to = Math.min(from + 3_600_000, end) - 1;
    page = (await getJson(`/api/v3/aggTrades?symbol=${symbol}&startTime=${from}&endTime=${to}&limit=${PAGE}`, o)) as AggTrade[];
    final = to === end - 1;
  }
  for (;;) {
    for (const t of page) {
      if (t.T >= end) return out;
      const previous = out.at(-1);
      if (previous !== undefined && t.a !== previous.a + 1) throw new Error(`gap in aggregated trades: ${previous.a} is followed by ${t.a}`);
      out.push(t);
    }
    const last = out.at(-1);
    if (last === undefined || (page.length < PAGE && final)) return out; // nothing newer exists yet
    o.log?.(`binance: ${out.length} trades, up to ${new Date(last.T).toISOString()}`);
    await o.sleep(o.pauseMs);
    page = (await getJson(`/api/v3/aggTrades?symbol=${symbol}&fromId=${last.a + 1}&limit=${PAGE}`, o)) as AggTrade[];
    final = true;
  }
}

/** Every 1-minute kline that opens in [start, end), oldest first. */
export async function downloadKlines(symbol: string, start: number, end: number, options: FetchOptions = {}): Promise<Kline[]> {
  const o = withDefaults(options);
  const out: Kline[] = [];
  for (let cursor = start; cursor < end; ) {
    const page = (await getJson(`/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${cursor}&endTime=${end - 1}&limit=${PAGE}`, o)) as Kline[];
    const fresh = page.filter((k) => k[0] >= cursor && k[0] < end);
    if (fresh.length === 0) break;
    out.push(...fresh);
    cursor = fresh.at(-1)![0] + MINUTE_MS;
    await o.sleep(o.pauseMs);
  }
  return out;
}

/** "80806.70000000" -> "80806.7": the same exact value, a third of the bytes. */
export function trimDecimal(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** aggTrades as CSV in the bulk dumps' column order, with a header. */
export function aggTradesCsv(trades: readonly AggTrade[]): string {
  const lines = ["agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker,is_best_match"];
  for (const t of trades) lines.push(`${t.a},${trimDecimal(t.p)},${trimDecimal(t.q)},${t.f},${t.l},${t.T},${t.m},${t.M}`);
  return `${lines.join("\n")}\n`;
}

/** Klines as services/ai/volatility/data.py writes them. */
export function klinesCsv(klines: readonly Kline[]): string {
  const lines = ["open_time,open,high,low,close,volume,trades"];
  for (const k of klines) lines.push([k[0], trimDecimal(k[1]), trimDecimal(k[2]), trimDecimal(k[3]), trimDecimal(k[4]), trimDecimal(k[5]), k[8]].join(","));
  return `${lines.join("\n")}\n`;
}
