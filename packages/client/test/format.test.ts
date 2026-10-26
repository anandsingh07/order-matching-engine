import { describe, expect, it } from "vitest";
import { formatPrice, formatQuantity, toUnits } from "../src/index.js";

describe("decimal conversion", () => {
  it("parses decimal strings to exact integer units", () => {
    expect(toUnits("80605.82", 100)).toBe(8060582);
    expect(toUnits("80605.82000000", 100)).toBe(8060582);
    expect(toUnits("0.00012000", 100_000)).toBe(12);
    expect(toUnits("0.1", 100)).toBe(10);
    expect(toUnits("7", 100)).toBe(700);
    expect(toUnits("7.", 100)).toBe(700);
    expect(toUnits("0.019", 100)).toBe(1); // truncated, never rounded up
    // 0.1 + 0.2 style float errors cannot happen: no float maths is involved.
    expect(toUnits("1234567.89", 100)).toBe(123456789);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "-1", "1e5", "abc", "1.2.3", " . "]) expect(toUnits(bad, 100)).toBeNull();
  });

  it("formats integer units for display", () => {
    expect(formatPrice({ priceScale: 100 }, 290050)).toBe("2900.50");
    expect(formatQuantity({ quantityScale: 1 }, 42)).toBe("42");
    expect(formatQuantity({ quantityScale: 100_000 }, 12)).toBe("0.00012");
  });
});
