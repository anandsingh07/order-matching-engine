import type { CurrencyBalance } from "@ome/client";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOURNAMENTS, EquityStats, rank, toBase, Tournaments, type TournamentOptions } from "../src/index.js";

// The tournament rules on their own, against a fake set of accounts: equity
// is whatever the test says it is, so every number below can be checked by hand.

interface FakeAccount {
  balances: CurrencyBalance[];
  unlimited: boolean;
  flat: boolean;
}

const balance = (currency: string, equity: number): CurrencyBalance => ({ currency, cash: equity, equity, exposure: 0, buyingPower: equity });

function setup(options: Partial<TournamentOptions> = {}) {
  const accounts = new Map<string, FakeAccount>();
  const resets: string[] = [];
  const notices: [string, string, string][] = [];
  const tournaments = new Tournaments(
    { ...DEFAULT_TOURNAMENTS, fx: { INR: 1, USDT: 90 }, startingCash: { INR: 1_000_000, USDT: 10_000 }, ...options },
    {
      balances: (id) => accounts.get(id)?.balances,
      isUnlimited: (id) => accounts.get(id)?.unlimited === true,
      isFlat: (id) => accounts.get(id)?.flat === true,
      reset: (id, cash) => {
        const account = accounts.get(id);
        if (account === undefined || !account.flat) return false;
        account.balances = Object.entries(cash).map(([c, v]) => balance(c, v));
        resets.push(id);
        return true;
      },
      name: (id) => `name-${id}`,
      notice: (id, level, text) => notices.push([id, level, text]),
    },
  );
  const trader = (id: string, extra: Partial<FakeAccount> = {}) =>
    accounts.set(id, { balances: [balance("INR", 5)], unlimited: false, flat: true, ...extra });
  /** Sets a trader's equity per currency. */
  const equity = (id: string, inr: number, usdt = 10_000) => {
    accounts.get(id)!.balances = [balance("INR", inr), balance("USDT", usdt)];
  };
  return { tournaments, trader, equity, resets, accounts, notices };
}

describe("FX conversion", () => {
  it("converts every currency's equity to the base currency at the configured rate", () => {
    expect(toBase([balance("INR", 1_000_000), balance("USDT", 10_000)], { INR: 1, USDT: 90 })).toBe(1_900_000);
    expect(toBase([balance("USDT", -100)], { INR: 1, USDT: 88 })).toBe(-8_800);
  });

  it("refuses a currency without a rate instead of counting it as zero", () => {
    expect(() => toBase([balance("EUR", 1)], { INR: 1 })).toThrow("no FX rate for EUR");
  });

  it("states a tournament's starting cash in the base currency", () => {
    const { tournaments } = setup();
    const created = tournaments.create({ name: "Cup", start: 1_000, end: 2_000 }, 0);
    expect(created).toMatchObject({ tournament: { startingEquity: 1_000_000 + 10_000 * 90, startingCash: { INR: 1_000_000, USDT: 10_000 } } });
    expect(tournaments.leaderboard("t1", 0)).toMatchObject({ baseCurrency: "INR", fx: { INR: 1, USDT: 90 } });
  });
});

describe("drawdown and Sharpe", () => {
  it("measures the largest fall from a running peak, as a share of that peak", () => {
    const stats = new EquityStats(100);
    for (const e of [110, 99, 120, 90, 130]) stats.add(e);
    // Peaks 110 then 120: the falls are 10% (110 -> 99) and 25% (120 -> 90).
    expect(stats.maxDrawdownPct).toBeCloseTo(25, 10);
    expect(stats.returnPct).toBeCloseTo(30, 10);
  });

  it("counts a loss from the starting equity as a drawdown, and none for a rising equity", () => {
    const losing = new EquityStats(100);
    losing.add(95);
    losing.add(97);
    expect(losing.maxDrawdownPct).toBeCloseTo(5, 10);
    const rising = new EquityStats(100);
    for (const e of [101, 102, 103]) rising.add(e);
    expect(rising.maxDrawdownPct).toBe(0);
  });

  it("computes the Sharpe ratio from the 1-second returns", () => {
    const stats = new EquityStats(100);
    const equities = [101, 100, 102, 103];
    for (const e of equities) stats.add(e);
    const returns = [101 / 100 - 1, 100 / 101 - 1, 102 / 100 - 1, 103 / 102 - 1];
    const mean = returns.reduce((a, b) => a + b) / returns.length;
    const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1));
    expect(stats.sharpe).toBeCloseTo((mean / sd) * Math.sqrt(returns.length), 10);
  });

  it("has no Sharpe ratio for an equity that never moved", () => {
    const stats = new EquityStats(100);
    for (let i = 0; i < 10; i++) stats.add(100);
    expect(stats.sharpe).toBeNull();
    expect(stats.maxDrawdownPct).toBe(0);
  });
});

describe("ranking", () => {
  const entry = (traderId: string, returnPct: number, maxDrawdownPct = 0, joinedAt = 0) => ({
    traderId,
    name: traderId,
    joinedAt,
    equity: 0,
    returnPct,
    maxDrawdownPct,
    trades: 0,
    sharpe: null,
  });

  it("ranks by return, highest first", () => {
    expect(rank([entry("a", -1), entry("b", 3), entry("c", 0.5)]).map((e) => [e.traderId, e.rank])).toEqual([
      ["b", 1],
      ["c", 2],
      ["a", 3],
    ]);
  });

  it("breaks ties by smaller drawdown, then earlier join, then trader id, whatever the input order", () => {
    const tied = [entry("u9", 2, 1, 50), entry("u3", 2, 1, 50), entry("u5", 2, 1, 10), entry("u7", 2, 0.5, 99)];
    const expected = ["u7", "u5", "u3", "u9"];
    expect(rank(tied).map((e) => e.traderId)).toEqual(expected);
    expect(rank([...tied].reverse()).map((e) => e.traderId)).toEqual(expected);
    expect(rank(tied).map((e) => e.rank)).toEqual([1, 2, 3, 4]);
  });

  it("treats returns that differ only by floating-point noise as equal", () => {
    // 0.1 + 0.2 !== 0.3: without a tolerance the "higher" return would win on a rounding error.
    // Here "a" is higher only by that error, so it must lose on the drawdown tie-break.
    expect(rank([entry("a", 0.1 + 0.2, 0.2), entry("b", 0.3, 0.1)]).map((e) => e.traderId)).toEqual(["b", "a"]);
  });

  it("gives the same order for every input order, even for chains of near-equal returns", () => {
    // A "within a tolerance" comparison is not transitive: here a ~ b and b ~ c within 1e-6 pp, but not a ~ c,
    // and sorting with it gave three different rankings for the six input orders.
    const chain = [entry("a", 1.2e-6, 0.3), entry("b", 0.6e-6, 0.2), entry("c", 0, 0.1)];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const rankings = new Set(orders.map((o) => rank(o.map((i) => chain[i]!)).map((e) => e.traderId).join()));
    expect([...rankings]).toHaveLength(1);

    // Property: random fields of near-ties, each ranked under 20 shuffles. (fast-check is not a dependency
    // of this package, so a seeded generator stands in for it: every run checks the same 500 cases.)
    let seed = 20261025;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
    for (let trial = 0; trial < 500; trial++) {
      const n = 2 + Math.floor(random() * 7);
      const field = Array.from({ length: n }, (_, i) =>
        entry(`u${i}`, pick([0, 0.4e-6, 0.6e-6, 0.9e-6, 1.2e-6, 1.6e-6, 2.1e-6, -0.5e-6, 0.25]), pick([0, 0.5, 1, 2.5]), pick([0, 10, 20])),
      );
      const ranked = rank(field);
      const expected = ranked.map((e) => e.traderId);
      for (let k = 0; k < 20; k++) {
        const shuffled = [...field];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        expect(rank(shuffled).map((e) => e.traderId)).toEqual(expected);
      }
      // And a return more than one grid step (1e-6 pp) higher is never ranked below.
      for (let i = 1; i < ranked.length; i++) expect(ranked[i]!.returnPct).toBeLessThan(ranked[i - 1]!.returnPct + 1e-6);
    }
  });
});

describe("joining", () => {
  it("resets a flat account to the starting cash and enters it", () => {
    const { tournaments, trader, resets, accounts } = setup();
    tournaments.create({ name: "Cup", start: 1_000, end: 2_000 }, 0);
    trader("u1");
    expect(tournaments.join("t1", "u1", 10)).toMatchObject({ tournament: { id: "t1", participants: 1, status: "upcoming" } });
    expect(resets).toEqual(["u1"]);
    expect(accounts.get("u1")!.balances.map((b) => [b.currency, b.equity])).toEqual([
      ["INR", 1_000_000],
      ["USDT", 10_000],
    ]);
    expect(tournaments.leaderboard("t1", 10)!.entries).toEqual([
      { rank: 1, traderId: "u1", name: "name-u1", joinedAt: 10, equity: 1_900_000, returnPct: 0, maxDrawdownPct: 0, trades: 0, sharpe: null },
    ]);
  });

  it("refuses unlimited accounts, accounts that are not flat, unknown traders and tournaments, and joining twice", () => {
    const { tournaments, trader, resets } = setup();
    tournaments.create({ name: "Cup", start: 1_000, end: 2_000 }, 0);
    trader("bot", { unlimited: true });
    trader("holder", { flat: false });
    trader("u1");
    expect(tournaments.join("t1", "bot", 0)).toEqual({ error: "unlimited_account" });
    expect(tournaments.join("t1", "holder", 0)).toEqual({ error: "not_flat" });
    expect(tournaments.join("t1", "ghost", 0)).toEqual({ error: "unknown_trader" });
    expect(tournaments.join("t9", "u1", 0)).toEqual({ error: "unknown_tournament" });
    expect(tournaments.join("t1", "u1", 0)).toHaveProperty("tournament");
    expect(tournaments.join("t1", "u1", 0)).toEqual({ error: "already_joined" });
    // Only the one accepted join touched an account.
    expect(resets).toEqual(["u1"]);
  });

  it("allows one unfinished tournament at a time, and another once it has finished", () => {
    const { tournaments, trader } = setup();
    tournaments.create({ name: "A", start: 0, end: 1_000 }, 0);
    tournaments.create({ name: "B", start: 500, end: 5_000 }, 0);
    trader("u1");
    expect(tournaments.join("t1", "u1", 0)).toHaveProperty("tournament");
    expect(tournaments.join("t2", "u1", 100)).toEqual({ error: "in_another_tournament" });
    expect(tournaments.join("t1", "u2", 1_000)).toEqual({ error: "tournament_finished" });
    expect(tournaments.join("t2", "u1", 1_000)).toHaveProperty("tournament");
  });

  it("freezes an early entrant's account until the start, and lets a late entrant in", () => {
    const { tournaments, trader } = setup();
    tournaments.create({ name: "Cup", start: 1_000, end: 2_000 }, 0);
    trader("early");
    trader("late");
    tournaments.join("t1", "early", 0);
    expect(tournaments.locked("early", 999)).toBe(true);
    expect(tournaments.locked("early", 1_000)).toBe(false);
    expect(tournaments.get("t1", 1_000)!.status).toBe("live");
    expect(tournaments.join("t1", "late", 1_500)).toMatchObject({ tournament: { status: "live", participants: 2 } });
    expect(tournaments.locked("late", 1_500)).toBe(false);
  });

  it("refuses a rolling length that is not a whole number of milliseconds of at least a second", () => {
    // TOURNAMENT_MS=0 or a typo would otherwise break advance(), which the gateway runs on every engine event.
    for (const rollingMs of [0, -60_000, Number.NaN, Number("15m"), 999, 1_500.5, Infinity]) {
      expect(() => setup({ rollingMs })).toThrow("the rolling length must be a whole number of milliseconds, at least a second");
    }
    expect(() => setup({ rollingMs: 1_000 })).not.toThrow();
  });

  it("validates new tournaments", () => {
    const { tournaments } = setup();
    expect(tournaments.create({ name: "x", start: 10, end: 10 }, 0)).toEqual({ error: "end must be after start" });
    expect(tournaments.create({ name: "x", start: 0, end: 5 }, 10)).toEqual({ error: "end must be in the future" });
    expect(tournaments.create({ name: "x", start: 0, end: 50, startingCash: { EUR: 10 } }, 10)).toEqual({ error: "no FX rate for EUR" });
    expect(tournaments.create({ name: "x", start: 0, end: 50, startingCash: { INR: 0 } }, 10)).toEqual({ error: "startingCash must be worth more than nothing" });
    expect(tournaments.create({ name: " ", start: 0, end: 50 }, 10)).toEqual({ error: "name is required" });
  });
});

describe("a tournament's life", () => {
  it("counts trades only while live, ranks by return, and freezes the result at the end", () => {
    const { tournaments, trader, equity } = setup();
    tournaments.create({ name: "Cup", start: 1_000, end: 4_000 }, 0);
    for (const id of ["u1", "u2", "u3"]) {
      trader(id);
      tournaments.join("t1", id, 0);
    }
    tournaments.onFill("u1", 500); // before the start: not counted

    equity("u1", 1_019_000); // +19,000 = +1%
    equity("u2", 990_500); // -9,500 = -0.5%
    tournaments.onFill("u1", 1_000);
    tournaments.onFill("u1", 1_100);
    tournaments.onFill("u2", 1_200);
    tournaments.sample(2_000);
    equity("u1", 1_000_000); // u1 gives back everything: a drawdown of 19,000 / 1,919,000
    tournaments.sample(3_000);
    equity("u1", 1_019_000);
    tournaments.sample(3_500);

    const live = tournaments.leaderboard("t1", 3_500)!;
    expect(live.tournament.status).toBe("live");
    expect(live.asOf).toBe(3_500);
    expect(live.entries.map((e) => [e.rank, e.traderId, e.trades])).toEqual([
      [1, "u1", 2],
      [2, "u3", 0],
      [3, "u2", 1],
    ]);
    const [u1, u3, u2] = live.entries;
    expect(u1!.returnPct).toBeCloseTo(1, 10);
    expect(u1!.maxDrawdownPct).toBeCloseTo((19_000 / 1_919_000) * 100, 10);
    expect(u1!.sharpe).not.toBeNull();
    expect(u3).toMatchObject({ returnPct: 0, maxDrawdownPct: 0, sharpe: null });
    expect(u2!.returnPct).toBeCloseTo(-0.5, 10);
    expect(u2!.maxDrawdownPct).toBeCloseTo(0.5, 10);

    // The end: one last sample, then nothing changes the result.
    equity("u2", 1_100_000);
    const final = tournaments.leaderboard("t1", 4_000)!;
    expect(final.tournament.status).toBe("finished");
    expect(final.asOf).toBe(4_000);
    expect(final.entries.map((e) => e.traderId)).toEqual(["u2", "u1", "u3"]); // u2's last-second rally counted
    const frozen = JSON.stringify(final);
    equity("u1", 2_000_000);
    equity("u2", 1);
    tournaments.onFill("u3", 4_001);
    tournaments.sample(5_000);
    expect(JSON.stringify(tournaments.leaderboard("t1", 6_000))).toBe(frozen);
    // Entrants are free again.
    expect(tournaments.locked("u1", 6_000)).toBe(false);
  });

  it("keeps rolling tournaments back to back on multiples of their length", () => {
    const { tournaments } = setup({ rollingMs: 60_000 });
    const t0 = Date.UTC(2026, 9, 25, 10, 0, 30);
    expect(tournaments.list(t0).map((t) => [t.name, t.status, t.rolling])).toEqual([
      ["Rolling 10:00–10:01 UTC", "live", true],
      ["Rolling 10:01–10:02 UTC", "upcoming", true],
    ]);
    const later = tournaments.list(t0 + 60_000);
    expect(later.map((t) => [t.name, t.status])).toEqual([
      ["Rolling 10:00–10:01 UTC", "finished"],
      ["Rolling 10:01–10:02 UTC", "live"],
      ["Rolling 10:02–10:03 UTC", "upcoming"],
    ]);
  });

  it("lets an entrant sign up for the next rolling tournament and enter it on the bell", () => {
    const { tournaments, trader } = setup({ rollingMs: 60_000 });
    const t0 = Date.UTC(2026, 9, 25, 10, 0, 30);
    trader("u1");
    expect(tournaments.join("t1", "u1", t0)).toMatchObject({ queued: false, tournament: { status: "live" } });
    expect(tournaments.join("t2", "u1", t0 + 1_000)).toMatchObject({ queued: true, tournament: { status: "upcoming" } });
    const next = tournaments.leaderboard("t2", t0 + 30_000)!;
    expect(next.tournament).toMatchObject({ status: "live", participants: 1 });
    expect(next.entries).toMatchObject([{ traderId: "u1", joinedAt: t0 + 1_000, returnPct: 0 }]);
  });

  it("keeps only the most recent finished tournaments", () => {
    const { tournaments } = setup({ keepFinished: 2 });
    for (let i = 0; i < 4; i++) tournaments.create({ name: `T${i}`, start: i * 10, end: i * 10 + 10 }, 0);
    expect(tournaments.list(1_000).map((t) => t.name)).toEqual(["T2", "T3"]);
  });
});

describe("queued entries", () => {
  it("queues an entry for a tournament that starts as the current one ends, and makes it after the final sample", () => {
    const { tournaments, trader, equity, resets, notices } = setup();
    tournaments.create({ name: "A", start: 0, end: 1_000 }, 0);
    tournaments.create({ name: "B", start: 1_000, end: 2_000 }, 0);
    tournaments.create({ name: "C", start: 500, end: 3_000 }, 0);
    trader("u1");
    tournaments.join("t1", "u1", 0);
    // C starts while A is still running: one account cannot be measured against two baselines.
    expect(tournaments.join("t3", "u1", 100)).toEqual({ error: "in_another_tournament" });
    expect(tournaments.join("t2", "u1", 100)).toMatchObject({ queued: true, tournament: { id: "t2", participants: 0 } });
    expect(tournaments.join("t2", "u1", 150)).toEqual({ error: "already_joined" });
    expect(tournaments.leaderboard("t2", 200)).toMatchObject({ entries: [], queued: ["u1"] });
    // Queueing touched nothing: the account is still in A.
    expect(resets).toEqual(["u1"]);

    equity("u1", 1_095_000); // +95,000 on 19,00,000: +5% in A
    const a = tournaments.leaderboard("t1", 1_000)!;
    expect(a.tournament.status).toBe("finished");
    // The final sample of A saw the gain; the reset for B came after it.
    expect(a.entries[0]!.returnPct).toBeCloseTo(5, 10);
    expect(resets).toEqual(["u1", "u1"]);
    const b = tournaments.leaderboard("t2", 1_000)!;
    expect(b.tournament).toMatchObject({ status: "live", participants: 1 });
    expect(b.queued).toEqual([]);
    // Signing up counts as joining, for the joined-first tie-break.
    expect(b.entries).toMatchObject([{ traderId: "u1", joinedAt: 100, equity: 1_900_000, returnPct: 0, trades: 0 }]);
    expect(tournaments.locked("u1", 1_000)).toBe(false);
    expect(notices).toEqual([["u1", "info", "B: your account was reset to the starting cash, and you are in."]]);
    // Equity from here on counts in B only.
    equity("u1", 1_000_000 - 19_000);
    tournaments.sample(1_500);
    expect(tournaments.leaderboard("t2", 1_500)!.entries[0]!.returnPct).toBeCloseTo(-1, 10);
    expect(tournaments.leaderboard("t1", 1_500)!.entries[0]!.returnPct).toBeCloseTo(5, 10);
  });

  it("lets a queued entry lapse if the account is not flat at the end, and holds a flat one until a later start", () => {
    const { tournaments, trader, accounts, notices } = setup();
    tournaments.create({ name: "A", start: 0, end: 1_000 }, 0);
    tournaments.create({ name: "B", start: 1_000, end: 2_000 }, 0);
    tournaments.create({ name: "C", start: 1_500, end: 3_000 }, 0);
    trader("holder");
    trader("waiter");
    tournaments.join("t1", "holder", 0);
    tournaments.join("t1", "waiter", 0);
    expect(tournaments.join("t2", "holder", 10)).toMatchObject({ queued: true });
    expect(tournaments.join("t3", "waiter", 10)).toMatchObject({ queued: true });
    // One queued entry at a time.
    expect(tournaments.join("t2", "waiter", 20)).toEqual({ error: "in_another_tournament" });
    accounts.get("holder")!.flat = false; // still holds a position when A ends

    tournaments.sample(1_000);
    expect(tournaments.leaderboard("t2", 1_000)).toMatchObject({ entries: [], queued: [] });
    expect(notices).toContainEqual(["holder", "warning", expect.stringContaining("B: your entry lapsed")]);
    // Once flat, the holder may still join B late, like anyone.
    accounts.get("holder")!.flat = true;
    expect(tournaments.join("t2", "holder", 1_200)).toMatchObject({ queued: false, tournament: { participants: 1 } });

    // The waiter was reset when A ended, and waits flat for the start of C.
    expect(tournaments.leaderboard("t3", 1_000)!.entries.map((e) => e.traderId)).toEqual(["waiter"]);
    expect(tournaments.locked("waiter", 1_200)).toBe(true);
    expect(tournaments.locked("waiter", 1_500)).toBe(false);
  });
});
