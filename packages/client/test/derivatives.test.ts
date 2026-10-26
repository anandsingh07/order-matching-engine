import { describe, expect, it } from "vitest";
import { contractMultiplier, contractName, formatStrike, instrumentKind, type Instrument } from "../src/index.js";

const TCS: Instrument = { symbol: "TCS", name: "TCS", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 410_000 };
const series = { ...TCS, underlying: "TCS", expiry: 1, multiplier: 10 };

describe("derivative instruments", () => {
  it("treats instruments without a kind as spot, one unit per contract", () => {
    expect(instrumentKind(TCS)).toBe("spot");
    expect(contractMultiplier(TCS)).toBe(1);
    expect(contractName(TCS)).toBe("TCS");
  });

  it("names futures and options for people", () => {
    expect(contractName({ ...series, symbol: "TCS-25OCT1030-F", kind: "future" })).toBe("TCS future");
    expect(contractName({ ...series, symbol: "TCS-25OCT1030-4100C", kind: "option", right: "call", strike: 410_000 })).toBe("TCS 4100 call");
    expect(contractMultiplier(series)).toBe(10);
  });

  it("writes strikes without trailing decimal zeros, and never drops whole-number zeros", () => {
    expect(formatStrike({ priceScale: 100, strike: 410_000 })).toBe("4100");
    expect(formatStrike({ priceScale: 100, strike: 181_250 })).toBe("1812.5");
    expect(formatStrike({ priceScale: 100, strike: 181_255 })).toBe("1812.55");
    expect(formatStrike({ priceScale: 1, strike: 4_100 })).toBe("4100");
  });
});
