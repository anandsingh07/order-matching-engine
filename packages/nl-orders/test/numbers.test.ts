import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cleanDecimal, numberToDecimal, shiftDecimal, toExactUnits } from "../src/index.ts";
import { misgroupedNumbers, normaliseNumbers, readNumberWords, stripGrouping } from "../src/numbers.ts";

describe("exact decimals", () => {
  it("strips thousands separators, Indian grouping included", () => {
    expect(cleanDecimal("4,100.50")).toBe("4100.50");
    expect(cleanDecimal("1,00,000")).toBe("100000");
    expect(cleanDecimal("0.05")).toBe("0.05");
    for (const bad of ["", "-5", "1e5", "4.1k", "1.2.3", ".", "rs 10"]) expect(cleanDecimal(bad)).toBeNull();
  });

  it("removes only commas that group thousands: a decimal comma is no number at all", () => {
    for (const [grouped, plain] of [["4,100", "4100"], ["1,000,000", "1000000"], ["1,00,000", "100000"], ["12,34,567.5", "1234567.5"], ["99,999.99", "99999.99"]]) {
      expect(cleanDecimal(grouped!)).toBe(plain);
    }
    // These used to lose their comma: "0,05 btc" was 5 BTC, "4100,50" a price of 410050.
    for (const bad of ["0,05", "0,5", "2,5", "4100,50", "0,500", "1,0000", "10,0"]) expect(cleanDecimal(bad), bad).toBeNull();
    expect(misgroupedNumbers("sell 0,05 btc at 81,000 or 4100,50")).toEqual(["0,05", "4100,50"]);
    expect(stripGrouping("sell 0,05 btc at 81,000")).toBe("sell 0,05 btc at 81000");
  });

  it("never reads a misgrouped comma as a grouped number", () => {
    // Every digits-and-commas string: either its commas group thousands (and removing them is the number), or it is refused.
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^\d{1,4}$/), { minLength: 2, maxLength: 4 }), (groups) => {
        const text = groups.join(",");
        const western = /^[1-9]\d{0,2}$/.test(groups[0]!) && groups.slice(1).every((g) => g.length === 3);
        const indian = /^[1-9]\d?$/.test(groups[0]!) && groups.at(-1)!.length === 3 && groups.slice(1, -1).every((g) => g.length === 2);
        expect(cleanDecimal(text)).toBe(western || indian ? groups.join("") : null);
      }),
    );
  });

  it("multiplies by powers of ten without floating point", () => {
    expect(shiftDecimal("4.1", 3)).toBe("4100");
    expect(shiftDecimal("1.25", 5)).toBe("125000");
    expect(shiftDecimal("0.005", 3)).toBe("5");
    expect(shiftDecimal("0.0005", 3)).toBe("0.5");
    expect(shiftDecimal("2", 0)).toBe("2");
  });

  it("shiftDecimal agrees with integer arithmetic", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 7 }), (n, decimals, shift) => {
        // n / 10^decimals, written out, then shifted: must equal n * 10^shift / 10^decimals.
        const s = n.toString().padStart(decimals + 1, "0");
        const text = decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
        const shifted = shiftDecimal(text, shift);
        // Read the result back as m / 10^e and compare the two fractions by cross-multiplying.
        const [whole, fraction = ""] = shifted.split(".");
        const m = BigInt(whole! + fraction);
        const e = BigInt(fraction.length);
        expect(m * 10n ** BigInt(decimals)).toBe(n * 10n ** BigInt(shift) * 10n ** e);
        // And it is written canonically: no leading zeros, no trailing fractional zeros.
        expect(shifted).toMatch(/^(0|[1-9]\d*)(\.\d*[1-9])?$/);
      }),
    );
  });

  it("converts to integer units exactly, and refuses to drop digits", () => {
    expect(toExactUnits("4100.50", 100)).toEqual({ value: 410050 });
    expect(toExactUnits("0.05", 100_000)).toEqual({ value: 5000 });
    expect(toExactUnits("10.000", 1)).toEqual({ value: 10 });
    expect(toExactUnits("2.5", 1)).toEqual({ error: "must be a whole number" });
    expect(toExactUnits("0.000001", 100_000)).toEqual({ error: "can have at most 5 decimal places" });
    expect(toExactUnits("0", 100)).toEqual({ error: "must be more than zero" });
    expect(toExactUnits("-5", 1)).toEqual({ error: "is not a plain number" });
    expect(toExactUnits("99999999999999999999", 100)).toEqual({ error: "is too large" });
  });

  it("round-trips every price a 2-decimal instrument can show", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 ** 12 }), (ticks) => {
        expect(toExactUnits((ticks / 100).toFixed(2), 100)).toEqual({ value: ticks });
      }),
    );
  });

  it("reads the model's JSON numbers as the text they round-trip to", () => {
    expect(numberToDecimal(4100.5)).toBe("4100.5");
    expect(numberToDecimal(0.05)).toBe("0.05");
    expect(numberToDecimal(10)).toBe("10");
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e-7, 1e21, "10", null]) expect(numberToDecimal(bad)).toBeNull();
  });
});

describe("numbers in the text a model reads", () => {
  it("are written out plainly, exactly", () => {
    expect(normaliseNumbers("buy 0.25 bitcoin at 79,950")).toBe("buy 0.25 bitcoin at 79950");
    expect(normaliseNumbers("Buy 100 TCS for 4,090 each")).toBe("Buy 100 TCS for 4090 each");
    expect(normaliseNumbers("buy 2k infy at 4.1K")).toBe("buy 2000 infy at 4100");
    expect(normaliseNumbers("1.5 lakh shares, ₹1,00,000, 2 cr")).toBe("150000 shares, ₹100000, 20000000");
    // Words that merely start like a multiplier are left alone.
    expect(normaliseNumbers("sell 5 crude and 3 kites")).toBe("sell 5 crude and 3 kites");
    // A decimal comma is shown as written, not as 005.
    expect(normaliseNumbers("sell 0,05 btc")).toBe("sell 0,05 btc");
  });
});

describe("number words", () => {
  it.each([
    [["ten"], 10, 1],
    [["twenty", "five", "shares"], 25, 2],
    [["a", "hundred"], 100, 2],
    [["two", "thousand", "five", "hundred"], 2500, 4],
    [["a", "dozen"], 12, 2],
    [["das"], 10, 1],
    [["paanch", "sau"], 500, 2],
  ] as const)("%j is %d", (words, value, used) => {
    expect(readNumberWords(words)).toEqual({ value, used });
  });

  it("is not fooled by an article or a verb", () => {
    expect(readNumberWords(["a", "few"])).toBeNull();
    expect(readNumberWords(["do"])).toBeNull(); // "bech do" is "sell", not "sell two"
  });
});
