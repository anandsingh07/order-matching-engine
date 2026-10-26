import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AvlTree } from "../src/index.js";

describe("AvlTree", () => {
  it("behaves like a sorted set and stays balanced", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 200 })), { maxLength: 500 }), (ops) => {
        const tree = new AvlTree<number>((a, b) => a - b);
        const model = new Set<number>();
        for (const [insert, key] of ops) {
          if (insert) {
            tree.set(key, key);
            model.add(key);
          } else {
            expect(tree.delete(key)).toBe(model.delete(key));
          }
        }
        const sorted = [...model].sort((a, b) => a - b);
        expect([...tree.values()]).toEqual(sorted);
        expect(tree.size).toBe(model.size);
        expect(tree.min()).toBe(sorted[0]);
        for (const key of sorted) expect(tree.get(key)).toBe(key);
        // AVL height is at most ~1.44 * log2(n + 2).
        expect(tree.height).toBeLessThanOrEqual(Math.ceil(1.45 * Math.log2(model.size + 2)));
      }),
    );
  });

  it("orders by the comparator, so min() is the highest key for a descending tree", () => {
    const tree = new AvlTree<string>((a, b) => b - a);
    for (const key of [100, 105, 98, 103]) tree.set(key, `p${key}`);
    expect(tree.min()).toBe("p105");
    expect([...tree.values()]).toEqual(["p105", "p103", "p100", "p98"]);
  });
});
