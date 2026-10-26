import type { Execution, Instrument } from "@ome/client";
import { describe, expect, it } from "vitest";
import { Accounts, DEFAULT_RISK, marginRate } from "../src/index.js";

const TCS: Instrument = { symbol: "TCS", name: "TCS", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 400_000 };
const BTC: Instrument = { symbol: "BTCUSDT", name: "BTC", currency: "USDT", priceScale: 100, quantityScale: 100_000, tickSize: 1, lotSize: 1, referencePrice: 8_000_000 };
const instruments = new Map([TCS, BTC].map((i) => [i.symbol, i]));

function setup(marks: Record<string, number> = {}) {
  const prices = { TCS: 400_000, BTCUSDT: 8_000_000, ...marks };
  const accounts = new Accounts(instruments, (s) => prices[s as keyof typeof prices], DEFAULT_RISK);
  accounts.open("u1", false);
  const exec = (symbol: string, id: string, e: Execution) => accounts.onExecution("u1", id, symbol, e);
  return { accounts, prices, exec };
}

describe("Accounts", () => {
  it("starts with paper cash per currency and full buying power", () => {
    const { accounts } = setup();
    expect(accounts.snapshot("u1")).toMatchObject({
      unlimited: false,
      balances: [
        { currency: "INR", cash: 1_000_000, equity: 1_000_000, exposure: 0, buyingPower: 1_000_000 },
        { currency: "USDT", cash: 100_000, equity: 100_000, exposure: 0, buyingPower: 100_000 },
      ],
      positions: [],
    });
  });

  it("tracks cash, positions and P&L from fills, marked to market", () => {
    const { accounts, prices, exec } = setup();
    exec("TCS", "a", { event: "fill", side: "buy", price: 400_000, quantity: 100, liquidity: "taker" }); // Rs 4,00,000
    prices.TCS = 410_000; // +Rs 100 a share
    const snapshot = accounts.snapshot("u1")!;
    expect(snapshot.balances[0]).toMatchObject({ cash: 600_000, equity: 1_010_000, exposure: 410_000 });
    expect(snapshot.positions).toEqual([{ symbol: "TCS", quantity: 100, averagePrice: 400_000, realized: 0, unrealized: 10_000, markPrice: 410_000 }]);
    exec("TCS", "b", { event: "fill", side: "sell", price: 410_000, quantity: 40, liquidity: "maker" });
    expect(accounts.snapshot("u1")!.positions[0]).toMatchObject({ quantity: 60, realized: 4_000, unrealized: 6_000 });
  });

  // Prices are in paise: 400_000 is Rs 4,000 a share.

  it("counts resting orders as exposure until they fill or are cancelled", () => {
    const { accounts, exec } = setup();
    exec("TCS", "r", { event: "rested", side: "buy", price: 400_000, quantity: 50, visible: 50 }); // Rs 2L
    expect(accounts.snapshot("u1")!.balances[0]).toMatchObject({ exposure: 200_000, buyingPower: 800_000 });
    exec("TCS", "r", { event: "fill", side: "buy", price: 400_000, quantity: 20, liquidity: "maker" });
    exec("TCS", "r", { event: "cancelled", remaining: 30, reason: "user" });
    // Only the 20 filled shares remain as exposure.
    expect(accounts.snapshot("u1")!.balances[0]).toMatchObject({ cash: 920_000, exposure: 80_000 });
  });

  it("refuses orders beyond buying power or the fat-finger limit, but always lets a position be reduced", () => {
    const { accounts, exec } = setup();
    expect(accounts.checkOrder("u1", TCS, "buy", 130, 400_000)).toBe("order_too_large"); // Rs 5.2L > Rs 5L
    expect(accounts.checkOrder("u1", TCS, "buy", 120, 400_000)).toBeNull();
    exec("TCS", "a", { event: "fill", side: "buy", price: 400_000, quantity: 120, liquidity: "taker" });
    exec("TCS", "b", { event: "fill", side: "buy", price: 400_000, quantity: 120, liquidity: "taker" }); // Rs 9.6L exposure
    expect(accounts.checkOrder("u1", TCS, "buy", 20, 400_000)).toBe("insufficient_buying_power"); // would be Rs 10.4L
    expect(accounts.checkOrder("u1", TCS, "sell", 240, 400_000)).toBe("order_too_large"); // the fat-finger cap always applies
    expect(accounts.checkOrder("u1", TCS, "sell", 100, 400_000)).toBeNull(); // reducing
    // USDT is a separate pot: a full INR account can still trade BTC.
    expect(accounts.checkOrder("u1", BTC, "buy", 50_000, 8_000_000)).toBeNull(); // 0.5 BTC = $40k
  });

  it("checks only the increase when an order is amended", () => {
    const { accounts, exec } = setup();
    exec("TCS", "r", { event: "rested", side: "buy", price: 400_000, quantity: 100, visible: 100 }); // Rs 4L
    expect(accounts.checkAmend("u1", TCS, "r", undefined, 50)).toBeNull(); // smaller
    expect(accounts.checkAmend("u1", TCS, "r", undefined, 125)).toBeNull(); // Rs 5L: within limits
    expect(accounts.checkAmend("u1", TCS, "r", undefined, 130)).toBe("order_too_large");
  });

  it("counts orders sent but not yet answered, so a burst cannot outrun its own checks", () => {
    const { accounts, exec } = setup();
    // Three orders of Rs 4L each pipelined on one connection: no execution report has come back for any of them yet.
    expect(accounts.checkOrder("u1", TCS, "buy", 100, 400_000)).toBeNull();
    expect(accounts.reserve("u1", "a", "TCS", "buy", 400_000, 100)).toBe(true);
    expect(accounts.checkOrder("u1", TCS, "buy", 100, 400_000)).toBeNull();
    accounts.reserve("u1", "b", "TCS", "buy", 400_000, 100);
    expect(accounts.checkOrder("u1", TCS, "buy", 100, 400_000)).toBe("insufficient_buying_power"); // Rs 12L
    // "a" fills in full, "b" rests: once answered, each is counted from its reports alone.
    exec("TCS", "a", { event: "fill", side: "buy", price: 400_000, quantity: 100, liquidity: "taker" });
    accounts.release("u1", "a");
    exec("TCS", "b", { event: "rested", side: "buy", price: 400_000, quantity: 100, visible: 100 });
    accounts.release("u1", "b");
    expect(accounts.snapshot("u1")!.balances[0]).toMatchObject({ cash: 600_000, exposure: 800_000 });
    // A reservation for an order the exchange refused leaves nothing behind.
    accounts.reserve("u1", "c", "TCS", "sell", 400_000, 10);
    accounts.release("u1", "c");
    expect(accounts.snapshot("u1")!.balances[0]).toMatchObject({ exposure: 800_000 });
    accounts.open("bot", true);
    expect(accounts.reserve("bot", "x", "TCS", "buy", 400_000, 1)).toBe(false); // unlimited: nothing to track
  });

  it("skips checks for unlimited accounts", () => {
    const { accounts } = setup();
    accounts.open("bot", true);
    expect(accounts.checkOrder("bot", TCS, "buy", 1_000_000, 400_000)).toBeNull();
    expect(accounts.snapshot("bot")!.unlimited).toBe(true);
  });

  it("never liquidates a fully paid long, even after a big fall", () => {
    const { accounts, prices, exec } = setup();
    exec("TCS", "a", { event: "fill", side: "buy", price: 400_000, quantity: 200, liquidity: "taker" }); // Rs 8L long, Rs 2L cash
    prices.TCS = 300_000; // -25%: equity 2L + 6L = 8L, exposure 6L
    expect(accounts.breaches()).toEqual([]);
  });

  it("liquidates a losing short once exposure passes 1.5x equity", () => {
    const { accounts, prices, exec } = setup();
    exec("TCS", "s", { event: "fill", side: "sell", price: 400_000, quantity: 240, liquidity: "taker" }); // short Rs 9.6L
    exec("TCS", "r", { event: "rested", side: "sell", price: 420_000, quantity: 10, visible: 10 }); // Rs 42k more
    prices.TCS = 480_000; // +20%: equity 19.6L - 11.52L = 8.08L, exposure 11.52L + 0.42L < 1.5 x 8.08L
    expect(accounts.breaches()).toEqual([]);
    prices.TCS = 560_000; // +40%: equity 6.16L, exposure 13.44L + 0.42L > 1.5 x 6.16L
    expect(accounts.breaches()).toEqual([
      { traderId: "u1", cancel: [{ symbol: "TCS", clientOrderId: "r" }], close: [{ symbol: "TCS", side: "buy", quantity: 240 }] },
    ]);
  });
});

// Derivatives on TCS, 10 shares a contract, with the default 10% margin rate (no forecast).
const TCS_F: Instrument = { ...TCS, symbol: "TCS-F", name: "TCS future", kind: "future", underlying: "TCS", expiry: 1, multiplier: 10 };
const option = (symbol: string, right: "call" | "put", strike: number): Instrument => ({
  ...TCS,
  symbol,
  name: symbol,
  kind: "option",
  underlying: "TCS",
  expiry: 1,
  strike,
  right,
  multiplier: 10,
});
const TCS_C4000 = option("TCS-C4000", "call", 400_000);
const TCS_P3900 = option("TCS-P3900", "put", 390_000);
const TCS_P3500 = option("TCS-P3500", "put", 350_000);
const TCS_C4400 = option("TCS-C4400", "call", 440_000);

function derivativesSetup(risk: Partial<typeof DEFAULT_RISK> = {}) {
  const all = new Map([TCS, TCS_F, TCS_C4000, TCS_P3900, TCS_P3500, TCS_C4400].map((i) => [i.symbol, i]));
  // Option marks are given directly here; the gateway marks options at their model value.
  const prices: Record<string, number> = { TCS: 400_000, "TCS-F": 400_000, "TCS-C4000": 15_000, "TCS-P3900": 2_000, "TCS-P3500": 100, "TCS-C4400": 300 };
  const accounts = new Accounts(all, (s) => prices[s]!, { ...DEFAULT_RISK, ...risk });
  for (const id of ["alice", "bob"]) accounts.open(id, false);
  const fill = (trader: string, symbol: string, side: "buy" | "sell", price: number, quantity: number) =>
    accounts.onExecution(trader, `${trader}-${symbol}-${side}-${price}`, symbol, { event: "fill", side, price, quantity, liquidity: "taker" });
  const inr = (trader: string) => accounts.snapshot(trader)!.balances.find((b) => b.currency === "INR")!;
  return { accounts, prices, fill, inr };
}

describe("Accounts: futures", () => {
  it("costs nothing to enter, holds margin on the notional, and marks variation P&L to the future's price", () => {
    const { accounts, prices, fill, inr } = derivativesSetup();
    fill("alice", "TCS-F", "buy", 400_000, 5); // 5 contracts x 10 shares x Rs 4,000 = Rs 2L notional
    expect(inr("alice")).toMatchObject({ cash: 1_000_000, equity: 1_000_000, margin: 20_000, exposure: 20_000, buyingPower: 980_000 });

    prices["TCS-F"] = 410_000; // +Rs 100 a share: +Rs 5,000 on 50 shares
    expect(inr("alice")).toMatchObject({ cash: 1_000_000, equity: 1_005_000, margin: 20_500 });
    fill("alice", "TCS-F", "sell", 410_000, 2); // realises 2 x 10 x Rs 100
    expect(inr("alice")).toMatchObject({ cash: 1_002_000, equity: 1_005_000, margin: 12_300 });
    expect(accounts.snapshot("alice")!.positions).toEqual([
      { symbol: "TCS-F", quantity: 3, averagePrice: 400_000, realized: 2_000, unrealized: 3_000, markPrice: 410_000 },
    ]);
  });

  it("moves only the P&L each closing fill realises into cash, not the running total", () => {
    const { accounts, fill, inr } = derivativesSetup();
    fill("alice", "TCS-F", "buy", 400_000, 5);
    fill("alice", "TCS-F", "sell", 410_000, 2); // +2 x 10 x Rs 100 = Rs 2,000
    expect(inr("alice").cash).toBe(1_002_000);
    fill("alice", "TCS-F", "sell", 405_000, 2); // +2 x 10 x Rs 50 = Rs 1,000; Rs 3,000 realised in all
    expect(inr("alice").cash).toBe(1_003_000);
    fill("alice", "TCS-F", "sell", 390_000, 3); // closes the last one (-Rs 1,000) and opens a short of 2 at Rs 3,900
    expect(inr("alice").cash).toBe(1_002_000);
    expect(accounts.snapshot("alice")!.positions).toEqual([
      { symbol: "TCS-F", quantity: -2, averagePrice: 390_000, realized: 2_000, unrealized: -2_000, markPrice: 400_000 },
    ]);
  });

  it("checks futures orders against margin, not notional", () => {
    const { accounts, fill } = derivativesSetup({ startingCash: { INR: 50_000 } });
    // Rs 50,000 could not buy two contracts outright (Rs 40,000 each), but margins twelve of them.
    expect(accounts.checkOrder("alice", TCS_F, "buy", 12, 400_000)).toBeNull(); // margin Rs 48,000
    expect(accounts.checkOrder("alice", TCS_F, "buy", 13, 400_000)).toBe("order_too_large"); // Rs 5.2L notional > Rs 5L
    fill("alice", "TCS-F", "buy", 400_000, 10); // margin Rs 40,000
    expect(accounts.checkOrder("alice", TCS_F, "buy", 2, 400_000)).toBeNull(); // Rs 48,000
    expect(accounts.checkOrder("alice", TCS_F, "buy", 3, 400_000)).toBe("insufficient_buying_power"); // Rs 52,000
    expect(accounts.checkOrder("alice", TCS_F, "sell", 10, 400_000)).toBeNull(); // reducing
    // A resting order holds margin too.
    accounts.onExecution("alice", "r", "TCS-F", { event: "rested", side: "buy", price: 400_000, quantity: 2, visible: 2 });
    expect(accounts.checkOrder("alice", TCS_F, "buy", 1, 400_000)).toBe("insufficient_buying_power"); // 40k + 8k + 4k
  });

  it("liquidates a losing future at the maintenance level: equity below two thirds of the margin", () => {
    // Long 10 at Rs 4,000 with Rs 50,000. At price p: equity = 50,000 + 100 (p - 4,000), margin = 10% x 100p.
    // Breach when 10p > 1.5 x equity, i.e. p < Rs 3,750.
    const { accounts, prices, fill } = derivativesSetup({ startingCash: { INR: 50_000 } });
    fill("alice", "TCS-F", "buy", 400_000, 10);
    prices["TCS-F"] = 376_000; // equity 26,000, margin 37,600 < 39,000
    expect(accounts.breaches()).toEqual([]);
    prices["TCS-F"] = 374_000; // equity 24,000, margin 37,400 > 36,000
    expect(accounts.breaches()).toEqual([{ traderId: "alice", cancel: [], close: [{ symbol: "TCS-F", side: "sell", quantity: 10 }] }]);
  });

  it("scales the margin rate with the forecast, within its floor", () => {
    expect(marginRate(null)).toBeCloseTo(0.1, 15); // before a forecast: 10%
    expect(marginRate(1.5)).toBeCloseTo(0.09, 15); // 6 x 1.5%
    expect(marginRate(3)).toBeCloseTo(0.18, 15); // a volatile market needs twice the margin
    expect(marginRate(0.2)).toBeCloseTo(0.05, 15); // a calm one never goes below 5%
  });
});

describe("Accounts: options", () => {
  it("makes the buyer pay the premium, fully paid, and the writer receive it and post margin", () => {
    const { prices, fill, inr } = derivativesSetup();
    // 4 calls at Rs 150 = Rs 6,000 of premium.
    fill("alice", "TCS-C4000", "buy", 15_000, 4);
    fill("bob", "TCS-C4000", "sell", 15_000, 4);
    expect(inr("alice")).toMatchObject({ cash: 994_000, equity: 1_000_000, margin: 6_000, buyingPower: 994_000 });
    // Writing margin per share: max(10% x 4000 - out-of-the-money 0, 5% x 4000) = Rs 400; x 40 shares.
    expect(inr("bob")).toMatchObject({ cash: 1_006_000, equity: 1_000_000, margin: 16_000, buyingPower: 984_000 });

    prices.TCS = 420_000;
    prices["TCS-C4000"] = 25_000;
    // The writer now owes Rs 250 a share (equity 10.06L - 10,000) and posts Rs 420 a share.
    expect(inr("bob")).toMatchObject({ equity: 996_000, margin: 16_800, buyingPower: 979_200 });
    expect(inr("alice")).toMatchObject({ equity: 1_004_000, margin: 10_000 });
  });

  it("gives out-of-the-money puts a smaller margin, but never below the minimum", () => {
    const { fill, inr } = derivativesSetup();
    // 3900 put with TCS at 4000: max(400 - 100, 5% x 3900 = 195) = Rs 300 a share, x 20 shares.
    fill("bob", "TCS-P3900", "sell", 2_000, 2);
    expect(inr("bob").margin).toBe(6_000);
    // 3500 put: max(400 - 500, 5% x 3500 = 175) = Rs 175 a share.
    fill("alice", "TCS-P3500", "sell", 100, 2);
    expect(inr("alice").margin).toBe(3_500);
  });

  it("floors an out-of-the-money call's margin on the underlying, not the strike", () => {
    const { fill, inr } = derivativesSetup();
    // 4400 call with TCS at 4000: max(400 - 400, 5% x 4000 = 200) = Rs 200 a share, x 30 shares
    // (5% of the strike would be Rs 220).
    fill("bob", "TCS-C4400", "sell", 300, 3);
    expect(inr("bob").margin).toBe(6_000);
  });

  it("checks writing options against the writing margin", () => {
    const { accounts } = derivativesSetup({ startingCash: { INR: 20_000 } });
    expect(accounts.checkOrder("alice", TCS_C4000, "sell", 5, 15_000)).toBeNull(); // Rs 400 x 50 = Rs 20,000 of margin
    expect(accounts.checkOrder("alice", TCS_C4000, "sell", 6, 15_000)).toBe("insufficient_buying_power");
    expect(accounts.checkOrder("alice", TCS_C4000, "buy", 13, 15_000)).toBeNull(); // Rs 19,500 of premium
    expect(accounts.checkOrder("alice", TCS_C4000, "buy", 14, 15_000)).toBe("insufficient_buying_power");
  });

  it("treats an order as closing only the part of a position that other orders are not already closing", () => {
    const { accounts, fill, inr } = derivativesSetup({ startingCash: { INR: 20_000 } });
    fill("alice", "TCS-C4000", "buy", 15_000, 1); // Rs 1,500 of premium; equity stays Rs 20,000
    expect(accounts.checkOrder("alice", TCS_C4000, "sell", 30, 15_000)).toBe("insufficient_buying_power"); // a short of 29
    // Thirty one-contract sells instead: only the first closes the long. Each later one opens a short and
    // needs Rs 4,000 of writing margin, on top of the Rs 1,500 the long holds and Rs 4,000 for each resting sell.
    let accepted = 0;
    for (let i = 0; i < 30 && accounts.checkOrder("alice", TCS_C4000, "sell", 1, 15_000) === null; i++, accepted++) {
      accounts.onExecution("alice", `s${i}`, "TCS-C4000", { event: "rested", side: "sell", price: 15_000, quantity: 1, visible: 1 });
    }
    expect(accepted).toBe(4); // Rs 1,500 + 4 x Rs 4,000 = Rs 17,500; a fifth would need Rs 21,500
    for (let i = 0; i < accepted; i++) {
      accounts.onExecution("alice", `s${i}`, "TCS-C4000", { event: "fill", side: "sell", price: 15_000, quantity: 1, liquidity: "maker" });
    }
    // Short 3, margined: Rs 12,000 against equity of Rs 20,000.
    expect(accounts.snapshot("alice")!.positions[0]).toMatchObject({ symbol: "TCS-C4000", quantity: -3 });
    expect(inr("alice")).toMatchObject({ equity: 20_000, margin: 12_000 });
    expect(accounts.breaches()).toEqual([]);
  });

  it("lets an amend grow a closing order up to the position, and no further without buying power", () => {
    const { accounts, fill, inr } = derivativesSetup({ startingCash: { INR: 7_500 } });
    fill("alice", "TCS-C4000", "buy", 15_000, 5); // all Rs 7,500 in premium: no buying power left
    accounts.onExecution("alice", "close", "TCS-C4000", { event: "rested", side: "sell", price: 15_000, quantity: 2, visible: 2 });
    expect(inr("alice").buyingPower).toBe(0);
    expect(accounts.checkAmend("alice", TCS_C4000, "close", undefined, 5)).toBeNull(); // still only closing
    expect(accounts.checkAmend("alice", TCS_C4000, "close", undefined, 6)).toBe("insufficient_buying_power"); // one short more
  });
});

describe("Accounts: settlement", () => {
  it("cash-settles futures and options at the settlement price and closes the positions", () => {
    const { accounts, fill, inr } = derivativesSetup();
    fill("alice", "TCS-F", "buy", 400_000, 3);
    fill("bob", "TCS-F", "sell", 400_000, 3);
    fill("alice", "TCS-C4000", "buy", 15_000, 4);
    fill("bob", "TCS-C4000", "sell", 15_000, 4);
    fill("alice", "TCS-P3900", "buy", 2_000, 1);
    fill("bob", "TCS-P3900", "sell", 2_000, 1);
    accounts.onExecution("alice", "left", "TCS-C4000", { event: "rested", side: "buy", price: 10_000, quantity: 1, visible: 1 });

    // Settled at Rs 4,123.40.
    expect(accounts.settle("TCS-F", 412_340)).toEqual([
      { traderId: "alice", quantity: 3, amount: 3_702 }, // 3 x 10 x Rs 123.40
      { traderId: "bob", quantity: -3, amount: -3_702 },
    ]);
    expect(accounts.settle("TCS-C4000", 412_340)).toEqual([
      { traderId: "alice", quantity: 4, amount: 4_936 }, // intrinsic Rs 123.40 x 40
      { traderId: "bob", quantity: -4, amount: -4_936 },
    ]);
    expect(accounts.settle("TCS-P3900", 412_340)).toEqual([
      { traderId: "alice", quantity: 1, amount: 0 }, // expires worthless
      { traderId: "bob", quantity: -1, amount: 0 },
    ]);
    // Alice paid Rs 6,000 + Rs 200 of premium and received Rs 3,702 + Rs 4,936; Bob the opposite.
    expect(inr("alice")).toMatchObject({ cash: 1_002_438, equity: 1_002_438, margin: 0, exposure: 0 });
    expect(inr("bob")).toMatchObject({ cash: 997_562, equity: 997_562, margin: 0 });
    expect(accounts.snapshot("alice")!.positions).toEqual([]);
    expect(accounts.settle("TCS-F", 412_340)).toEqual([]); // nothing left
  });
});

describe("Accounts: starting again (tournament entry)", () => {
  it("is flat only with no position, no resting order, no pending stop and nothing in flight", () => {
    const { accounts, exec } = setup();
    expect(accounts.isFlat("u1")).toBe(true);
    exec("TCS", "r", { event: "rested", side: "buy", price: 390_000, quantity: 1, visible: 1 });
    expect(accounts.isFlat("u1")).toBe(false);
    exec("TCS", "r", { event: "cancelled", remaining: 1, reason: "user" });
    // A stop waiting for its trigger needs no buying power, but it can still trade.
    exec("TCS", "s", { event: "stop_pending", side: "sell", stopPrice: 380_000, quantity: 1 });
    expect(accounts.isFlat("u1")).toBe(false);
    exec("TCS", "s", { event: "cancelled", remaining: 1, reason: "user" });
    expect(accounts.isFlat("u1")).toBe(true);
    expect(accounts.reserve("u1", "q", "TCS", "buy", 400_000, 1)).toBe(true);
    expect(accounts.isFlat("u1")).toBe(false);
    accounts.release("u1", "q");
    // A position closed again is flat, even with realised P&L left on it.
    exec("TCS", "a", { event: "fill", side: "buy", price: 400_000, quantity: 10, liquidity: "taker" });
    expect(accounts.isFlat("u1")).toBe(false);
    exec("TCS", "b", { event: "fill", side: "sell", price: 401_000, quantity: 10, liquidity: "taker" });
    expect(accounts.isFlat("u1")).toBe(true);
    expect(accounts.isFlat("nobody")).toBe(false);
  });

  it("stops tracking a stop once it triggers: from there it is an ordinary order", () => {
    const { accounts, exec } = setup();
    exec("TCS", "s", { event: "stop_pending", side: "buy", stopPrice: 410_000, quantity: 1 });
    exec("TCS", "s", { event: "triggered", lastPrice: 410_000 });
    expect(accounts.isFlat("u1")).toBe(true);
  });

  it("resets a flat account to new cash, clearing realised P&L, and refuses one that is not flat", () => {
    const { accounts, exec } = setup();
    exec("TCS", "a", { event: "fill", side: "buy", price: 400_000, quantity: 10, liquidity: "taker" });
    expect(accounts.reset("u1", { INR: 50_000 })).toBe(false);
    exec("TCS", "b", { event: "fill", side: "sell", price: 410_000, quantity: 10, liquidity: "taker" });
    accounts.markLiquidated("u1");
    expect(accounts.reset("u1", { INR: 50_000 })).toBe(true);
    expect(accounts.snapshot("u1")).toEqual({
      traderId: "u1",
      unlimited: false,
      balances: [{ currency: "INR", cash: 50_000, equity: 50_000, exposure: 0, buyingPower: 50_000, margin: 0 }],
      positions: [],
      liquidated: false,
    });
  });
});
