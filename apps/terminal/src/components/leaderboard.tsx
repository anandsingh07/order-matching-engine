"use client";

import { TradingClient, type Leaderboard as Board, type Tournament } from "@ome/client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { formatAmount, formatTime } from "@/lib/format";
import { formatReturn, formatSharpe, joinState, orderTournaments, pickTournament, tournamentTiming } from "@/lib/leaderboard";
import { useTerminal } from "@/lib/store";
import { useNow } from "./countdown";

// Trading tournaments and their live standings (GET /api/tournaments, the
// "leaderboard:<id>" WebSocket channel). The trading session, when there is
// one, is the terminal's own: this page is reached by client-side navigation,
// so the store and its WebSocket carry over.

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8080";

function useTournaments(version: number): { tournaments: Tournament[] | null; error: string | null } {
  const [tournaments, setTournaments] = useState<Tournament[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await TradingClient.tournaments(GATEWAY_URL);
        if (cancelled) return;
        setTournaments(list);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error && e.message.endsWith("404")
            ? "Tournaments are not enabled on this gateway (it was started with TOURNAMENTS=0)."
            : `Cannot reach the gateway at ${GATEWAY_URL}. Start it with pnpm gateway.`,
        );
      }
    };
    void load();
    // Statuses and entrant counts change slowly; the standings themselves come every 2 seconds below.
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [version]);
  return { tournaments, error };
}

/**
 * The standings for one tournament: pushed over the trading WebSocket when
 * there is a session, otherwise polled over REST at the same 2-second pace.
 */
function useBoard(id: string | null, client: TradingClient | null, version: number): Board | null {
  const [board, setBoard] = useState<Board | null>(null);
  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await TradingClient.leaderboard(GATEWAY_URL, id);
        if (!cancelled) setBoard(next);
      } catch {
        // The tournament list reports an unreachable gateway.
      }
    };
    void load();
    if (client !== null) {
      const channel = `leaderboard:${id}`;
      const off = client.on("leaderboard", (m) => {
        if (m.tournament.id === id) setBoard(m);
      });
      client.subscribe([channel]);
      return () => {
        cancelled = true;
        off();
        client.unsubscribe([channel]);
      };
    }
    const timer = setInterval(() => void load(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, client, version]);
  // A board left over from the previous selection is not shown while the new one loads.
  return board !== null && board.tournament.id === id ? board : null;
}

function StatusBadge({ status }: { status: Tournament["status"] }) {
  const style = { live: "bg-lime", upcoming: "bg-cyan", finished: "bg-raised" }[status];
  return <span className={`rounded border-2 border-ink px-1.5 text-[10px] font-bold text-ink ${style}`}>{status.toUpperCase()}</span>;
}

const cashText = (cash: Record<string, number>) =>
  Object.entries(cash)
    .map(([currency, amount]) => `${formatAmount(amount)} ${currency}`)
    .join(" + ");

export default function Leaderboard() {
  const { client, trader, account, connected } = useTerminal(
    useShallow((s) => ({ client: s.client, trader: s.trader, account: s.account, connected: s.status === "connected" })),
  );
  const session = connected ? client : null;
  // Bumped after joining, so the list and the standings reload at once.
  const [version, setVersion] = useState(0);
  const { tournaments, error } = useTournaments(version);
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = tournaments === null ? null : pickTournament(tournaments, chosen);
  const board = useBoard(selected?.id ?? null, session, version);
  const now = useNow();
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // The pushed board carries the freshest status; the list is polled more slowly.
  const tournament = board?.tournament ?? selected;
  const me = session !== null && trader !== null ? { traderId: trader.id, unlimited: account?.unlimited ?? false } : null;
  const state = tournament === null ? null : joinState(tournament, board?.entries ?? [], me, board?.queued ?? []);

  async function join() {
    if (session === null || tournament === null) return;
    setJoining(true);
    setJoinError(null);
    try {
      const result = await session.joinTournament(tournament.id);
      if (result.ok) setVersion((v) => v + 1);
      else setJoinError(result.message);
    } catch {
      // fetch rejects when the gateway is down, and the JSON parse fails on a proxy's HTML error page:
      // either way the button must come back, with a reason.
      setJoinError(`Cannot reach the gateway at ${GATEWAY_URL}. Try again in a moment.`);
    } finally {
      setJoining(false);
    }
  }

  function choose(id: string) {
    setChosen(id);
    setJoinError(null);
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl">Tournaments</h1>
          <p className="mt-1 text-xs text-muted">Everyone starts with the same cash; the best return wins. Bots and market makers never rank.</p>
        </div>
        <Link href="/" className="btn rounded bg-panel px-3 py-1.5 text-xs text-ink">
          Back to the terminal
        </Link>
      </header>

      {error !== null && (
        <p role="alert" className="rounded-md border-2 border-ink bg-sell-soft p-3 text-sm">
          {error}
        </p>
      )}

      {tournaments !== null && tournaments.length === 0 && (
        <p className="brutal rounded-md bg-panel p-4 text-sm text-muted">
          No tournaments yet. Start the gateway with <code className="num text-text">TOURNAMENT_MS=900000</code> for back-to-back
          15-minute tournaments, or create one with the admin key (<code className="num text-text">POST /api/tournaments</code>).
        </p>
      )}

      {tournaments !== null && tournaments.length > 0 && (
        <nav aria-label="Tournaments" className="flex gap-3 overflow-x-auto pr-1 pb-2">
          {orderTournaments(tournaments).map((t) => {
            const active = t.id === selected?.id;
            return (
              <button
                key={t.id}
                onClick={() => choose(t.id)}
                aria-pressed={active}
                className={`btn shrink-0 rounded-md px-3 py-2 text-left text-xs font-normal ${active ? "bg-accent" : "bg-panel hover:bg-raised"}`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold">{t.name}</span>
                  <StatusBadge status={t.status} />
                </span>
                <span className="num mt-1 block text-text">
                  {tournamentTiming(t, now)} · {t.participants} {t.participants === 1 ? "trader" : "traders"}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {tournament !== null && state !== null && (
        <section aria-label={tournament.name} className="space-y-3">
          <div className="brutal flex flex-wrap items-start justify-between gap-3 rounded-md bg-panel p-3">
            <div className="space-y-1 text-xs">
              <h2 className="flex items-center gap-2 text-lg">
                {tournament.name} <StatusBadge status={tournament.status} />
              </h2>
              <p className="num text-muted">
                {new Date(tournament.start).toLocaleString("en-GB", { hour12: false })} – {formatTime(tournament.end)} ·{" "}
                {tournamentTiming(tournament, now)}
              </p>
              <p className="text-muted">
                Starting cash <span className="num text-text">{cashText(tournament.startingCash)}</span>
                {board !== null && (
                  <>
                    {" "}
                    = <span className="num text-text">{formatAmount(tournament.startingEquity)} {board.baseCurrency}</span> at{" "}
                    <span className="num">
                      {Object.entries(board.fx)
                        .filter(([c]) => c !== board.baseCurrency)
                        .map(([c, rate]) => `${rate} ${board.baseCurrency}/${c}`)
                        .join(", ")}
                    </span>{" "}
                    (fixed rates)
                  </>
                )}
              </p>
            </div>
            <div className="max-w-sm text-right text-xs">
              {state.kind === "can_join" && (
                <>
                  <button
                    onClick={() => void join()}
                    disabled={joining}
                    className="btn rounded-md bg-accent px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                  >
                    {joining ? "Joining…" : "Join tournament"}
                  </button>
                  <p className="mt-1 text-muted">
                    Joining resets your account to the starting cash.
                    {tournament.status === "upcoming" &&
                      " Your account then waits, flat, until the start. If you are in a tournament that ends by then, you are signed up and enter at its end."}
                  </p>
                </>
              )}
              {state.kind === "joined" && (
                <p className="rounded-md border-2 border-ink bg-buy-soft px-3 py-1.5 text-sm">
                  You&apos;re in.{" "}
                  {tournament.status === "upcoming" ? "Trading opens for you at the start." : <Link href="/" className="underline">Trade in the terminal</Link>}
                </p>
              )}
              {state.kind === "queued" && (
                <p className="rounded-md border-2 border-ink bg-accent/40 px-3 py-1.5 text-left text-sm">
                  You&apos;re signed up. You enter when your current tournament ends, if your account is flat then: close your
                  positions and cancel your orders before the end, or the entry lapses.
                </p>
              )}
              {state.kind === "sign_in" && (
                <p className="text-muted">
                  <Link href="/" className="font-semibold text-text underline">
                    Sign in on the terminal
                  </Link>{" "}
                  to join, then come back here.
                </p>
              )}
              {state.kind === "not_eligible" && <p className="text-muted">{state.reason}</p>}
              {joinError !== null && (
                <p role="alert" className="mt-2 rounded-md border-2 border-ink bg-sell-soft p-2 text-left">
                  {joinError}
                </p>
              )}
            </div>
          </div>

          <section aria-label="Standings" className="brutal rounded-md bg-panel">
            <h2 className="flex items-baseline justify-between border-b-2 border-line px-3 py-2 text-sm">
              <span>{tournament.status === "finished" ? "Final standings" : "Standings"}</span>
              {board !== null && (
                <span className="num text-[11px] text-muted">
                  {tournament.status === "finished" ? "frozen at" : "as of"} {formatTime(board.asOf)}
                </span>
              )}
            </h2>
            {board === null ? (
              <p className="px-3 pb-3 text-sm text-muted">Loading…</p>
            ) : board.entries.length === 0 ? (
              <p className="px-3 pb-3 text-sm text-muted">Nobody has joined yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[11px] text-muted">
                    <tr>
                      {["#", "Trader", "Return", `Equity (${board.baseCurrency})`, "Max drawdown", "Sharpe", "Trades"].map((h, i) => (
                        <th key={h} className={`px-3 py-1.5 font-normal ${i < 2 ? "text-left" : "text-right"}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {board.entries.map((e) => {
                      const mine = e.traderId === me?.traderId;
                      return (
                        <tr key={e.traderId} aria-current={mine ? "true" : undefined} className={`border-t border-line/15 ${mine ? "bg-accent/40" : ""}`}>
                          <td className="num px-3 py-1.5">{e.rank}</td>
                          <td className="px-3 py-1.5">
                            {e.name} <span className="num text-muted">({e.traderId})</span>
                            {mine && <span className="ml-1.5 rounded border border-ink bg-accent px-1 text-[10px] font-bold text-ink">YOU</span>}
                          </td>
                          <td className={`num px-3 py-1.5 text-right ${e.returnPct > 0 ? "text-buy" : e.returnPct < 0 ? "text-sell" : ""}`}>
                            {formatReturn(e.returnPct)}
                          </td>
                          <td className="num px-3 py-1.5 text-right">{formatAmount(e.equity)}</td>
                          <td className="num px-3 py-1.5 text-right">{e.maxDrawdownPct.toFixed(2)}%</td>
                          <td className="num px-3 py-1.5 text-right">{formatSharpe(e.sharpe)}</td>
                          <td className="num px-3 py-1.5 text-right">{e.trades}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-[11px] text-muted">
            Equity is cash plus every position at its mark (futures and options included), with every currency converted at the fixed
            rates above, sampled every second. Ranked by return, then the smaller max drawdown, then who joined first. Sharpe is the mean
            over the standard deviation of the 1-second returns, times the square root of their count (over the tournament, not
            annualised). Results freeze when the tournament ends.
          </p>
        </section>
      )}
    </main>
  );
}
