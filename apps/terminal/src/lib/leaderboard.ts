import type { LeaderboardEntry, Tournament } from "@ome/client";
import { formatCountdown } from "./derivatives";

/**
 * The tournaments in the order people look for them: running now (ending
 * soonest first), then upcoming (starting soonest first), then finished
 * (most recent first).
 */
export function orderTournaments(tournaments: readonly Tournament[]): Tournament[] {
  const group = { live: 0, upcoming: 1, finished: 2 } as const;
  const key = (t: Tournament) => (t.status === "live" ? t.end : t.status === "upcoming" ? t.start : -t.end);
  return [...tournaments].sort((a, b) => group[a.status] - group[b.status] || key(a) - key(b) || a.id.localeCompare(b.id));
}

/** The tournament to show: the one asked for if it still exists, otherwise the first in `orderTournaments`. */
export function pickTournament(tournaments: readonly Tournament[], preferred: string | null): Tournament | null {
  return tournaments.find((t) => t.id === preferred) ?? orderTournaments(tournaments)[0] ?? null;
}

/** "Starts in 4:05", "Ends in 1:02:00", "Finished". */
export function tournamentTiming(tournament: Pick<Tournament, "status" | "start" | "end">, now: number): string {
  if (tournament.status === "finished") return "Finished";
  // The status comes from the gateway's clock; a countdown that has run out simply waits for it.
  if (tournament.status === "upcoming") return tournament.start > now ? `Starts in ${formatCountdown(tournament.start - now)}` : "Starting…";
  return tournament.end > now ? `Ends in ${formatCountdown(tournament.end - now)}` : "Finishing…";
}

/** "+1.00%", "-0.53%", "0.00%": always signed, so gains and losses read at a glance. */
export function formatReturn(pct: number): string {
  // -0.001 rounds to "-0.00"; show it as no change.
  const fixed = pct.toFixed(2);
  if (Number(fixed) === 0) return "0.00%";
  return `${pct > 0 ? "+" : ""}${fixed}%`;
}

export function formatSharpe(sharpe: number | null): string {
  return sharpe === null ? "—" : sharpe.toFixed(2);
}

export type JoinState =
  | { kind: "can_join" }
  | { kind: "joined" }
  /** Signed up while in a tournament that ends by this one's start: the entry is made at that end. */
  | { kind: "queued" }
  | { kind: "closed" }
  | { kind: "sign_in" }
  | { kind: "not_eligible"; reason: string };

/**
 * Whether this viewer can join, as far as the page can tell before asking:
 * the gateway still checks everything (a trader who holds a position, or is
 * in another tournament, finds out when they try).
 */
export function joinState(
  tournament: Pick<Tournament, "status">,
  entries: readonly Pick<LeaderboardEntry, "traderId">[],
  me: { traderId: string; unlimited: boolean } | null,
  queued: readonly string[] = [],
): JoinState {
  if (tournament.status === "finished") return { kind: "closed" };
  if (me === null) return { kind: "sign_in" };
  if (entries.some((e) => e.traderId === me.traderId)) return { kind: "joined" };
  if (queued.includes(me.traderId)) return { kind: "queued" };
  if (me.unlimited) return { kind: "not_eligible", reason: "Market-maker accounts cannot enter tournaments." };
  return { kind: "can_join" };
}
