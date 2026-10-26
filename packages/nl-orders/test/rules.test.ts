import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAliases, editDistance, matchInstrument, parseWithRules, tokenize, type MarketInstrument, type OrderFields } from "../src/index.ts";

const instruments = JSON.parse(readFileSync(new URL("./fixtures/instruments.json", import.meta.url), "utf8")) as MarketInstrument[];
const parse = (text: string) => parseWithRules(text, instruments);
const order = (f: Partial<OrderFields>) => ({
  intent: "order", side: null, symbol: null, orderType: null, quantity: null, price: null, stopPrice: null, timeInForce: null, displayQuantity: null, ...f,
});

describe("tokenizer", () => {
  it("turns written numbers into exact decimals", () => {
    const numbers = (text: string) => tokenize(text).filter((t) => t.number !== undefined).map((t) => t.number);
    expect(numbers("Rs 4,100.50")).toEqual(["4100.50"]);
    expect(numbers("₹1,00,000")).toEqual(["100000"]);
    expect(numbers("4.1k")).toEqual(["4100"]);
    expect(numbers("1.5 lakh")).toEqual(["150000"]);
    expect(numbers("twenty five")).toEqual(["25"]);
    expect(numbers("Rs.4100/-")).toEqual(["4100"]);
    expect(numbers(".5 btc")).toEqual(["0.5"]);
    expect(numbers("10tcs@4100.")).toEqual(["10", "4100"]);
    expect(numbers("2 dozen infy")).toEqual(["24"]);
    expect(numbers("two dozen")).toEqual(["24"]);
  });
});

describe("instrument names", () => {
  const aliases = buildAliases(instruments);
  const match = (text: string) => matchInstrument(text.split(" "), aliases)?.symbol ?? null;

  it("knows symbols, names, short names and crypto bases", () => {
    expect(match("tcs")).toBe("TCS");
    expect(match("tata consultancy services")).toBe("TCS");
    expect(match("tata consultancy")).toBe("TCS");
    expect(match("hdfc bank")).toBe("HDFCBANK");
    expect(match("hdfc")).toBe("HDFCBANK");
    expect(match("btc")).toBe("BTCUSDT");
    expect(match("bitcoin")).toBe("BTCUSDT");
    expect(match("infosys")).toBe("INFY");
  });

  it("forgives small typos in longer names, but not in short ones", () => {
    expect(match("relaince")).toBe("RELIANCE"); // swapped letters count as one edit
    expect(match("infosis")).toBe("INFY");
    expect(match("hdfcbnk")).toBe("HDFCBANK");
    expect(match("tsc")).toBeNull(); // three letters: one edit away is a different ticker
    expect(match("apple")).toBeNull();
  });

  it("keeps a stock's short names when its futures and options are listed too", () => {
    // As the gateway lists them: one future and calls and puts per expiry, named after the stock.
    const tcs = instruments.find((i) => i.symbol === "TCS")!;
    const series: MarketInstrument[] = ["F", "4100C", "4100P"].map((code) => ({
      ...tcs, symbol: `TCS-25OCT1030-${code}`, name: `Tata Consultancy Services ${code === "F" ? "future" : code.endsWith("C") ? "4100 call" : "4100 put"}, expires 10:30 UTC`,
      kind: code === "F" ? "future" : "option", underlying: "TCS",
    }));
    const hdfc = instruments.find((i) => i.symbol === "HDFCBANK")!;
    series.push({ ...hdfc, symbol: "HDFCBANK-25OCT1030-F", name: "HDFC Bank future, expires 10:30 UTC", kind: "future", underlying: "HDFCBANK" });
    const withSeries = buildAliases([...instruments, ...series]);
    const matchIn = (text: string) => matchInstrument(text.split(" "), withSeries)?.symbol ?? null;
    expect(matchIn("tata")).toBe("TCS");
    expect(matchIn("tata consultancy")).toBe("TCS");
    expect(matchIn("hdfc")).toBe("HDFCBANK");
    expect(withSeries.filter((a) => a.words.join(" ") === "tata").map((a) => a.symbol)).toEqual(["TCS"]);
  });

  it("refuses a typo that is equally close to two instruments", () => {
    const two: MarketInstrument[] = [
      { ...instruments[0]!, symbol: "ABCDE", name: "Abcde" },
      { ...instruments[0]!, symbol: "ABCDF", name: "Abcdf" },
    ];
    expect(matchInstrument(["abcdx"], buildAliases(two))).toBeNull();
    expect(matchInstrument(["abcde"], buildAliases(two))?.symbol).toBe("ABCDE");
  });

  it("measures edits as optimal string alignment", () => {
    expect(editDistance("reliance", "relaince")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });
});

describe("rule-based parser", () => {
  it.each([
    ["buy 10 tata consultancy at 4100", { side: "buy", symbol: "TCS", orderType: "limit", quantity: "10", price: "4100" }],
    ["sell 0.05 btc at market", { side: "sell", symbol: "BTCUSDT", orderType: "market", quantity: "0.05" }],
    ["short 20 TCS at Rs 4,105.50", { side: "sell", symbol: "TCS", orderType: "limit", quantity: "20", price: "4105.50" }],
    ["sell 40 tcs stop 4000 limit 3990", { side: "sell", symbol: "TCS", orderType: "stop_limit", quantity: "40", price: "3990", stopPrice: "4000" }],
    ["sell 40 tcs stop at 4000", { side: "sell", symbol: "TCS", orderType: "stop", quantity: "40", stopPrice: "4000" }],
    ["buy 50 INFY at 1850 IOC", { side: "buy", symbol: "INFY", orderType: "limit", quantity: "50", price: "1850", timeInForce: "IOC" }],
    ["Buy 300 TCS at 4095 iceberg show 30 at a time", { side: "buy", symbol: "TCS", orderType: "limit", quantity: "300", price: "4095", displayQuantity: "30" }],
    ["show 10 shares at a time, buy 100 tcs at 4100", { side: "buy", symbol: "TCS", orderType: "limit", quantity: "100", price: "4100", displayQuantity: "10" }],
    ["TCS ke 10 share kharido 4100 pe", { side: "buy", symbol: "TCS", orderType: "limit", quantity: "10", price: "4100" }],
    ["infy 20 becho market pe", { side: "sell", symbol: "INFY", orderType: "market", quantity: "20" }],
    ["buy 100 shares of TCS for 4,090 each", { side: "buy", symbol: "TCS", orderType: "limit", quantity: "100", price: "4090" }],
    ["a stop loss order to sell 20 hdfc at 1680", { side: "sell", symbol: "HDFCBANK", orderType: "stop", quantity: "20", stopPrice: "1680" }],
    ["buy 1.5 lakh infy", { side: "buy", symbol: "INFY", quantity: "150000" }],
  ] as const)("%s", (text, fields) => {
    const r = parse(text);
    expect(r.understood).toBe(true);
    expect(r.fields).toMatchObject(order(fields));
  });

  it("reads cancels, with the side and symbol only when named", () => {
    expect(parse("cancel all my orders").fields).toMatchObject({ intent: "cancel", symbol: null, side: null });
    expect(parse("pull my bid on reliance").fields).toMatchObject({ intent: "cancel", symbol: "RELIANCE", side: "buy" });
    expect(parse("TCS wala order cancel karo").fields).toMatchObject({ intent: "cancel", symbol: "TCS", side: null });
  });

  it("knows when a request is vague, even though it read every word", () => {
    // "buy 10 tcs and 10 tcs" may be two orders: a number repeated in one role is not one consistent value.
    for (const text of ["buy some reliance", "sell half of my HDFC position", "buy ₹50,000 worth of infosys", "buy 10 TCS and sell 5 INFY", "buy 10 infy at market, limit 1850", "buy -5 tcs", "buy 10 tcs and 10 tcs", "buy 10 tcs at 4100 and 10 tcs at 4100"]) {
      const r = parse(text);
      expect(r.understood, text).toBe(true);
      expect(r.fields.intent, text).toBe("unclear");
      expect(r.fields.explanation, text).not.toBe("");
    }
  });

  // Each from the review: before the fix, every one of these was a confident
  // proposal (or, in hybrid mode, a model answer the text check passed).
  it.each([
    // A part of the orders is no cancel scope: these were cancels of every TCS (or buy) order.
    ["cancel some of my buy orders", "it cancels only some of them"],
    ["cancel half my tcs order", "it cancels only some of them"],
    // A cancel with an order in it: these were cancels of the wrong scope, the order dropped.
    ["buy tcs at market and cancel my sell orders", "it mixes a cancel with a new order"],
    ["cancel all and buy tcs", "it mixes a cancel with a new order"],
    ["cancel my sell orders, buy infy", "it says both buy and sell"],
    ["cancel 10 orders", "a cancel takes no quantity or price"],
    ["cancel my stop orders", "a cancel covers an instrument or a side, not an order type"],
    // A decimal comma: "0,05 btc" was 5 BTC.
    ["sell 0,05 btc", "\"0,05\" could be read more than one way"],
    ["buy 10 tcs at 4100,50", "\"4100,50\" could be read more than one way"],
    // A listed company's first word, followed by another company's.
    ["buy 10 tata motors at 900", "\"tata motors\" may be another company"],
    ["sell 5 hdfc life at 600", "\"hdfc life\" may be another company"],
    ["buy 1 bitcoin cash at 400", "\"bitcoin cash\" may be another company"],
    // Words that negate, hedge, schedule or repeat.
    ["don't buy 10 tcs at 4100", "it says \"don't\""],
    ["tcs 10 mat becho", "it says \"mat\""],
    // Found while fixing the review: the rules read this as a sell stop at 4000.
    ["stop selling 10 tcs at 4000", "it says \"stop selling\""],
    ["hold off buying 10 tcs at 4100", "it says \"hold off\""],
    ["maybe buy 10 tcs at 4100?", "it says \"maybe\", \"?\""],
    ["sell 10 tcs at 4100 tomorrow", "it says \"tomorrow\""],
    ["buy 1 tcs at 4100 twice", "it says \"twice\""],
    ["buy 10 tcs at 4100 if you think it is good", "it says \"if\" but gives no price to wait for"],
    // Market and limit, with no limit price: this was a market order.
    ["buy 10 tcs at market limit order", "it asks for both a market order and a limit order"],
  ])("refuses %s whatever its unknown words mean", (text, reason) => {
    const r = parse(text);
    expect(r.fields.intent).toBe("unclear");
    expect(r.conflicts.join("; ")).toContain(reason);
    // So hybrid mode answers at once, and any model reading is refused too (ground.ts).
    expect(r.certain).toBe(true);
  });

  it("still reads what sits next to those", () => {
    expect(parse("cancel all my tcs orders").fields).toMatchObject({ intent: "cancel", symbol: "TCS", side: null });
    expect(parse("cancel every sell order").fields).toMatchObject({ intent: "cancel", symbol: null, side: "sell" });
    expect(parse("kill all my btc buy orders").fields).toMatchObject({ intent: "cancel", symbol: "BTCUSDT", side: "buy" });
    expect(parse("sell 10 tcs stop 4000 at market").fields).toMatchObject({ intent: "order", orderType: "stop", stopPrice: "4000" });
    // Trader shorthand for a stop order, unlike "stop selling".
    expect(parse("stop sell 10 tcs at 4000").fields).toMatchObject({ intent: "order", orderType: "stop", stopPrice: "4000" });
    expect(parse("buy 12,000 hdfc bank at 1,699.95").fields).toMatchObject({ intent: "order", quantity: "12000", price: "1699.95" });
    // A typo over two words beats an exact first word: not "tata" and then an unknown word.
    expect(parse("buy 10 tata consultency at 4100").fields).toMatchObject({ intent: "order", symbol: "TCS", price: "4100" });
    expect(parse("buy 5 hdfc bnak at 1700").fields).toMatchObject({ intent: "order", symbol: "HDFCBANK" });
    // A condition word before the name is not taken for another company.
    expect(parse("buy 60 reliance if it goes above 2950").conflicts).toEqual([]);
  });

  it("marks the numbers a condition waits for", () => {
    expect(parse("sell 3 tcs if it falls to 4000").named.triggers).toEqual(["4000"]);
    expect(parse("buy 0.02 btc if price goes above 82000").named.triggers).toEqual(["82000"]);
    expect(parse("sell 2 infy when it drops below 1800").named.triggers).toEqual(["1800"]);
    expect(parse("buy 10 tcs at 4100").named.triggers).toEqual([]);
  });

  it("does not guess: unknown words or an unexplained second number mean not understood", () => {
    for (const text of ["buy tcs 10 4100", "sell 3 tcs if it falls to 4000", "what's the price of TCS?", "hello", "buy 10 tcs at", "buy 10 apple shares"]) {
      const r = parse(text);
      expect(r.understood, text).toBe(false);
      expect(r.fields.intent, text).toBe("unclear");
    }
  });
});
