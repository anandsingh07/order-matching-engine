import { describe, expect, it } from "vitest";
import { flaggedInOrder, watchKey, type Watched } from "./surveillance";

const watched = (traderId: string, symbol: string, time: number, flagged = true): Watched => ({ traderId, symbol, time, assessment: { flagged } });
const keys = (list: Watched[]) => list.map(watchKey);

describe("flagged traders order", () => {
  it("keeps cards in place while the gateway reorders them by suspicion", () => {
    const since = new Map<string, number>();
    // First poll: everyone flagged in the same scan, so ties break by trader and symbol.
    const first = flaggedInOrder([watched("u9", "TCS", 1_000), watched("u3", "INFY", 1_000), watched("u3", "HDFCBANK", 1_000)], [], since);
    expect(keys(first)).toEqual(["u3|HDFCBANK", "u3|INFY", "u9|TCS"]);
    // Next poll: the gateway's suspicion order changed, and a new trader was caught.
    const second = flaggedInOrder(
      [watched("u5", "TCS", 3_000), watched("u3", "INFY", 3_000), watched("u9", "TCS", 3_000), watched("u3", "HDFCBANK", 3_000)],
      [],
      since,
    );
    expect(keys(second)).toEqual(["u3|HDFCBANK", "u3|INFY", "u9|TCS", "u5|TCS"]);
  });

  it("lists only flagged traders, and one flagged again keeps its place", () => {
    const since = new Map<string, number>();
    flaggedInOrder([watched("u1", "TCS", 1_000), watched("u2", "TCS", 2_000)], [], since);
    expect(keys(flaggedInOrder([watched("u1", "TCS", 3_000, false), watched("u2", "TCS", 3_000)], [], since))).toEqual(["u2|TCS"]);
    expect(keys(flaggedInOrder([watched("u2", "TCS", 5_000), watched("u1", "TCS", 5_000)], [], since))).toEqual(["u1|TCS", "u2|TCS"]);
  });

  it("dates traders already flagged when the page opens by their oldest alert", () => {
    const log = [watched("u2", "TCS", 4_000), watched("u1", "TCS", 4_000), watched("u2", "TCS", 2_000), watched("u1", "INFY", 1_000)];
    const order = flaggedInOrder([watched("u1", "TCS", 5_000), watched("u2", "TCS", 5_000)], log, new Map());
    expect(keys(order)).toEqual(["u2|TCS", "u1|TCS"]);
  });
});
