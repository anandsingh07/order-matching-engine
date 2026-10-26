import type { Tournament } from "@ome/client";
import { describe, expect, it } from "vitest";
import { formatReturn, formatSharpe, joinState, orderTournaments, pickTournament, tournamentTiming } from "./leaderboard";

const NOW = Date.UTC(2026, 9, 25, 10, 0);
const MIN = 60_000;

const tournament = (id: string, status: Tournament["status"], start: number, end: number): Tournament => ({
  id,
  name: id,
  start,
  end,
  startingCash: { INR: 1_000_000 },
  startingEquity: 1_000_000,
  status,
  participants: 0,
  rolling: false,
});

const LIST = [
  tournament("old", "finished", NOW - 60 * MIN, NOW - 30 * MIN),
  tournament("soon", "upcoming", NOW + 5 * MIN, NOW + 20 * MIN),
  tournament("recent", "finished", NOW - 20 * MIN, NOW - 10 * MIN),
  tournament("long", "live", NOW - 5 * MIN, NOW + 60 * MIN),
  tournament("later", "upcoming", NOW + 30 * MIN, NOW + 40 * MIN),
  tournament("short", "live", NOW - 1 * MIN, NOW + 4 * MIN),
];

describe("tournament list", () => {
  it("puts live tournaments first (ending soonest), then upcoming (starting soonest), then finished (most recent)", () => {
    expect(orderTournaments(LIST).map((t) => t.id)).toEqual(["short", "long", "soon", "later", "recent", "old"]);
  });

  it("shows the chosen tournament while it exists, and otherwise the most relevant one", () => {
    expect(pickTournament(LIST, "old")?.id).toBe("old");
    expect(pickTournament(LIST, "gone")?.id).toBe("short");
    expect(pickTournament(LIST, null)?.id).toBe("short");
    expect(pickTournament(LIST.filter((t) => t.status === "finished"), null)?.id).toBe("recent");
    expect(pickTournament([], null)).toBeNull();
  });

  it("counts down to the start or the end", () => {
    expect(tournamentTiming(tournament("a", "upcoming", NOW + 65_000, NOW + 10 * MIN), NOW)).toBe("Starts in 1:05");
    expect(tournamentTiming(tournament("a", "live", NOW - MIN, NOW + 62 * MIN), NOW)).toBe("Ends in 1:02:00");
    expect(tournamentTiming(tournament("a", "finished", NOW - 2 * MIN, NOW - MIN), NOW)).toBe("Finished");
    // The gateway decides when the status changes; until it says so, the page waits rather than counting below zero.
    expect(tournamentTiming(tournament("a", "live", NOW - 2 * MIN, NOW - 1), NOW)).toBe("Finishing…");
  });
});

describe("leaderboard formatting", () => {
  it("signs returns, and shows a rounding to zero as no change", () => {
    expect(formatReturn(1)).toBe("+1.00%");
    expect(formatReturn(-0.5263)).toBe("-0.53%");
    expect(formatReturn(-0.001)).toBe("0.00%");
    expect(formatReturn(0)).toBe("0.00%");
  });

  it("shows a missing Sharpe ratio as a dash", () => {
    expect(formatSharpe(null)).toBe("—");
    expect(formatSharpe(1.23456)).toBe("1.23");
  });
});

describe("joining", () => {
  const live = { status: "live" as const };
  const me = { traderId: "u1", unlimited: false };

  it("offers the join button only to a signed-in standard trader who is not already in", () => {
    expect(joinState(live, [], me)).toEqual({ kind: "can_join" });
    expect(joinState(live, [{ traderId: "u1" }], me)).toEqual({ kind: "joined" });
    expect(joinState(live, [], null)).toEqual({ kind: "sign_in" });
    expect(joinState(live, [], { traderId: "bot", unlimited: true })).toMatchObject({ kind: "not_eligible" });
    expect(joinState({ status: "finished" }, [], me)).toEqual({ kind: "closed" });
    expect(joinState({ status: "upcoming" }, [{ traderId: "u2" }], me)).toEqual({ kind: "can_join" });
  });

  it("says a trader is queued when they signed up from a tournament that has not ended yet", () => {
    const upcoming = { status: "upcoming" as const };
    expect(joinState(upcoming, [], me, ["u1"])).toEqual({ kind: "queued" });
    expect(joinState(upcoming, [], me, ["u2"])).toEqual({ kind: "can_join" });
    // Once the entry is made the trader is ranked, and that is what counts.
    expect(joinState(live, [{ traderId: "u1" }], me, ["u1"])).toEqual({ kind: "joined" });
  });
});
