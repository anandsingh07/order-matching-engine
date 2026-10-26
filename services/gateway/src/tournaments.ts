import type { CurrencyBalance, Leaderboard, LeaderboardEntry, Tournament, TournamentStatus } from "@ome/client";

/**
 * Trading tournaments and their leaderboards.
 *
 * What joining does: the trader's own account is reset to the tournament's
 * starting cash, exactly as a fresh account would start, and the results are
 * measured from that point. That is only fair (and only honest) for a flat
 * account, so joining is refused while the trader holds a position or any
 * order: dropping them would create or destroy value out of nothing. One
 * account cannot be measured against two baselines, so a trader is in at
 * most one unfinished tournament at a time.
 *
 * - A trader in a tournament may still sign up for one that starts when (or
 *   after) theirs ends, such as the next rolling tournament: the entry is
 *   queued, and made at the end of the current one, right after its final
 *   sample, if the account is flat at that moment (otherwise it lapses, and
 *   the trader is told). Without this, repeat players could only ever join
 *   the next one late, after closing the positions they held at the bell.
 * - Joining an upcoming tournament resets the account at once and then
 *   freezes it until the start (new orders and amends are refused), so every
 *   early entrant starts on the bell with the same cash and no positions.
 * - Joining a live tournament is allowed: the late entrant starts with the
 *   same cash, but has less time.
 * - Unlimited accounts (bots acting as market makers) can never enter: they
 *   skip buying-power checks, so their "returns" are not comparable.
 *
 * Metrics, per entrant, from equity sampled once a second:
 * - equity: every currency's equity (cash plus positions marked to market,
 *   futures and options included) converted to the base currency at fixed,
 *   configured FX rates;
 * - return: equity against the starting equity;
 * - max drawdown: the largest fall from a running peak, as a share of the peak;
 * - trades: fills while the tournament is live;
 * - Sharpe: mean / standard deviation of the 1-second returns, times the
 *   square root of their count (over the tournament, not annualised).
 *
 * When a tournament ends, one last sample is taken and the standings are
 * frozen: nothing that happens to the accounts afterwards changes them.
 */

export interface TournamentOptions {
  /** Equity is reported in this currency. */
  baseCurrency: string;
  /** Units of the base currency per unit of each currency. Fixed rates: tournament returns should not move with a live FX quote. */
  fx: Record<string, number>;
  /** Default starting cash for a tournament created without one, and for rolling tournaments. */
  startingCash: Record<string, number>;
  /** How often equity is sampled for drawdown and Sharpe. */
  sampleIntervalMs: number;
  /** How often leaderboard subscribers get fresh standings. */
  pushIntervalMs: number;
  /** Back-to-back tournaments of this length, on multiples of it (UTC), when set. */
  rollingMs?: number;
  /** Finished tournaments kept (oldest dropped first), so a long-running gateway does not grow without bound. */
  keepFinished: number;
}

// An assumed rate for the simulation, not a live quote: configure it with USDT_INR.
export const DEFAULT_FX: Record<string, number> = { INR: 1, USDT: 88 };

export const DEFAULT_TOURNAMENTS: Omit<TournamentOptions, "startingCash"> = {
  baseCurrency: "INR",
  fx: DEFAULT_FX,
  sampleIntervalMs: 1_000,
  pushIntervalMs: 2_000,
  keepFinished: 50,
};

/** What the tournaments need from the gateway's accounts. */
export interface TournamentHost {
  /** The trader's balances (equity per currency), or undefined for an unknown trader. */
  balances(traderId: string): CurrencyBalance[] | undefined;
  isUnlimited(traderId: string): boolean;
  isFlat(traderId: string): boolean;
  /** Resets a flat account to `cash`; false if it could not. */
  reset(traderId: string, cash: Record<string, number>): boolean;
  name(traderId: string): string;
  /** Tells the trader something happened without them asking (a queued entry made or lapsed). */
  notice(traderId: string, level: "info" | "warning", text: string): void;
}

/** Why a join was refused. */
export type JoinError =
  | "unknown_tournament"
  | "tournament_finished"
  | "unknown_trader"
  | "unlimited_account"
  | "already_joined"
  | "in_another_tournament"
  | "not_flat";

export const JOIN_ERRORS: Record<JoinError, string> = {
  unknown_tournament: "There is no such tournament.",
  tournament_finished: "This tournament has finished.",
  unknown_trader: "Unknown session.",
  unlimited_account: "Unlimited (market-maker) accounts cannot enter tournaments.",
  already_joined: "You have already joined this tournament.",
  in_another_tournament: "You are in another tournament that has not finished, and this one starts before it ends.",
  not_flat: "Joining resets your account, so close your positions and cancel your orders first.",
};

/** Converts per-currency equity to the base currency. A currency without a rate is an error, never silently zero. */
export function toBase(balances: readonly Pick<CurrencyBalance, "currency" | "equity">[], fx: Record<string, number>): number {
  let total = 0;
  for (const { currency, equity } of balances) {
    const rate = fx[currency];
    if (rate === undefined) throw new Error(`no FX rate for ${currency}`);
    total += equity * rate;
  }
  return total;
}

/** Cash per currency, converted to the base currency. */
export function cashToBase(cash: Record<string, number>, fx: Record<string, number>): number {
  return toBase(Object.entries(cash).map(([currency, equity]) => ({ currency, equity })), fx);
}

/**
 * Running drawdown and return statistics over equity samples, in constant
 * memory (Welford's algorithm for the variance), since a long tournament
 * sampled every second would otherwise keep every sample.
 */
export class EquityStats {
  private peak: number;
  private worst = 0;
  private lastEquity: number;
  private n = 0;
  private mean = 0;
  private m2 = 0;

  constructor(readonly start: number) {
    this.peak = start;
    this.lastEquity = start;
  }

  add(equity: number): void {
    // A return from a non-positive equity means nothing (the account is wiped out); skip it.
    if (this.lastEquity > 0) {
      const r = equity / this.lastEquity - 1;
      this.n++;
      const delta = r - this.mean;
      this.mean += delta / this.n;
      this.m2 += delta * (r - this.mean);
    }
    this.lastEquity = equity;
    if (equity > this.peak) this.peak = equity;
    else if (this.peak > 0) this.worst = Math.max(this.worst, (this.peak - equity) / this.peak);
  }

  get last(): number {
    return this.lastEquity;
  }

  get returnPct(): number {
    return (this.lastEquity / this.start - 1) * 100;
  }

  get maxDrawdownPct(): number {
    return this.worst * 100;
  }

  /** Null until there are two returns with any variation: an equity that never moved has no Sharpe ratio. */
  get sharpe(): number | null {
    if (this.n < 2) return null;
    const sd = Math.sqrt(this.m2 / (this.n - 1));
    // Below this the "variation" is floating-point noise, and dividing by it would print nonsense.
    if (sd < 1e-12) return null;
    return (this.mean / sd) * Math.sqrt(this.n);
  }
}

/** Returns are compared on a grid this fine (in percentage points), so float noise cannot decide a rank. */
const RETURN_GRID = 1e-6;

/**
 * Ranks entries: the higher return first; then the smaller max drawdown
 * (the same result with less risk); then whoever joined first; then the
 * trader id, so the order is total and the same on every call.
 *
 * Returns are rounded to the grid before comparing, not compared "within a
 * tolerance": a tolerance is not transitive (a ~ b and b ~ c while a and c
 * differ), and a sort with such a comparator gives a different order for a
 * different input order. Two returns on the same grid point tie, however
 * close to the edge of it they are.
 */
export function rank(entries: readonly Omit<LeaderboardEntry, "rank">[]): LeaderboardEntry[] {
  const grid = (pct: number) => Math.round(pct / RETURN_GRID);
  return [...entries]
    .sort(
      (a, b) =>
        grid(b.returnPct) - grid(a.returnPct) ||
        a.maxDrawdownPct - b.maxDrawdownPct ||
        a.joinedAt - b.joinedAt ||
        (a.traderId < b.traderId ? -1 : a.traderId > b.traderId ? 1 : 0),
    )
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

interface Participant {
  traderId: string;
  joinedAt: number;
  stats: EquityStats;
  trades: number;
}

interface State {
  id: string;
  name: string;
  start: number;
  end: number;
  startingCash: Record<string, number>;
  startingEquity: number;
  status: TournamentStatus;
  rolling: boolean;
  participants: Map<string, Participant>;
  /** Traders still in an earlier tournament, by when they signed up: they enter when it ends. */
  queued: Map<string, number>;
  /** When equity was last sampled. */
  asOf: number;
  /** Set once finished: the final standings, never changed again. */
  frozen: LeaderboardEntry[] | null;
}

export interface NewTournament {
  name: string;
  start: number;
  end: number;
  startingCash?: Record<string, number>;
}

export class Tournaments {
  private readonly tournaments = new Map<string, State>();
  /** The unfinished tournament each trader is in. */
  private readonly entered = new Map<string, State>();
  /** The tournament each trader is queued for, entered when their current one ends. */
  private readonly queued = new Map<string, State>();
  private nextId = 1;
  /** Nothing changes status before this time, so `advance` on every event batch is one comparison. */
  private nextDue = -Infinity;

  constructor(
    readonly options: TournamentOptions,
    private readonly host: TournamentHost,
  ) {
    for (const currency of Object.keys(options.startingCash)) {
      if (options.fx[currency] === undefined) throw new Error(`no FX rate for ${currency}`);
    }
    // Checked here because a bad length (0, NaN, negative) would otherwise surface only in advance(), which runs
    // while the gateway routes engine events: every order and fill, not just tournaments, would stop.
    const ms = options.rollingMs;
    if (ms !== undefined && !(Number.isInteger(ms) && ms >= 1_000)) {
      throw new Error(`tournaments: the rolling length must be a whole number of milliseconds, at least a second (got ${ms})`);
    }
  }

  /** Why a tournament cannot be created, or null. */
  private invalid(spec: NewTournament, now: number): string | null {
    if (spec.name.trim() === "") return "name is required";
    if (!(spec.end > spec.start)) return "end must be after start";
    if (spec.end <= now) return "end must be in the future";
    const cash = spec.startingCash ?? this.options.startingCash;
    const entries = Object.entries(cash);
    if (entries.length === 0) return "startingCash needs at least one currency";
    for (const [currency, amount] of entries) {
      if (this.options.fx[currency] === undefined) return `no FX rate for ${currency}`;
      if (!(amount >= 0) || !Number.isFinite(amount)) return `startingCash.${currency} must be a non-negative number`;
    }
    if (!(cashToBase(cash, this.options.fx) > 0)) return "startingCash must be worth more than nothing";
    return null;
  }

  create(spec: NewTournament, now: number): { tournament: Tournament } | { error: string } {
    this.advance(now);
    const problem = this.invalid(spec, now);
    if (problem !== null) return { error: problem };
    const state = this.add(spec, false, now);
    return { tournament: this.view(state) };
  }

  private add(spec: NewTournament, rolling: boolean, now: number): State {
    const startingCash = { ...(spec.startingCash ?? this.options.startingCash) };
    const state: State = {
      id: `t${this.nextId++}`,
      name: spec.name.trim(),
      start: spec.start,
      end: spec.end,
      startingCash,
      startingEquity: cashToBase(startingCash, this.options.fx),
      status: "upcoming",
      rolling,
      participants: new Map(),
      queued: new Map(),
      asOf: now,
      frozen: null,
    };
    this.tournaments.set(state.id, state);
    this.nextDue = -Infinity;
    this.advance(now);
    return state;
  }

  /** Every tournament kept, by start time (then id). */
  list(now: number): Tournament[] {
    this.advance(now);
    return [...this.tournaments.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id, "en", { numeric: true })).map((s) => this.view(s));
  }

  get(id: string, now: number): Tournament | undefined {
    this.advance(now);
    const state = this.tournaments.get(id);
    return state === undefined ? undefined : this.view(state);
  }

  /**
   * Enters the trader, or (while they are in a tournament that ends by the
   * time this one starts) queues the entry for that end: `queued` says which.
   */
  join(id: string, traderId: string, now: number): { tournament: Tournament; queued: boolean } | { error: JoinError } {
    this.advance(now);
    const state = this.tournaments.get(id);
    if (state === undefined) return { error: "unknown_tournament" };
    if (state.status === "finished") return { error: "tournament_finished" };
    if (this.host.balances(traderId) === undefined) return { error: "unknown_trader" };
    if (this.host.isUnlimited(traderId)) return { error: "unlimited_account" };
    const current = this.entered.get(traderId);
    if (current === state || state.queued.has(traderId)) return { error: "already_joined" };
    if (current !== undefined) {
      // The account is busy until `current` ends; a tournament that starts by then can take it from there.
      if (state.start < current.end || this.queued.has(traderId)) return { error: "in_another_tournament" };
      state.queued.set(traderId, now);
      this.queued.set(traderId, state);
      return { tournament: this.view(state), queued: true };
    }
    if (!this.enter(state, traderId, now)) return { error: "not_flat" };
    return { tournament: this.view(state), queued: false };
  }

  /** Resets a flat account and enters it; false (and nothing changed) if the account is not flat. */
  private enter(state: State, traderId: string, joinedAt: number): boolean {
    if (!this.host.isFlat(traderId) || !this.host.reset(traderId, state.startingCash)) return false;
    state.participants.set(traderId, { traderId, joinedAt, stats: new EquityStats(state.startingEquity), trades: 0 });
    this.entered.set(traderId, state);
    return true;
  }

  /** Whether the trader is entered in a tournament that has not started: their account waits for the bell. */
  locked(traderId: string, now: number): boolean {
    this.advance(now);
    return this.entered.get(traderId)?.status === "upcoming";
  }

  /** Counts a fill for the trader, if they are in a live tournament. */
  onFill(traderId: string, now: number): void {
    this.advance(now);
    const state = this.entered.get(traderId);
    if (state?.status !== "live") return;
    const participant = state.participants.get(traderId);
    if (participant !== undefined) participant.trades++;
  }

  /** Samples every live entrant's equity. Called once a second. */
  sample(now: number): void {
    this.advance(now);
    for (const state of this.tournaments.values()) if (state.status === "live") this.sampleAll(state, now);
  }

  leaderboard(id: string, now: number): Leaderboard | undefined {
    this.advance(now);
    const state = this.tournaments.get(id);
    if (state === undefined) return undefined;
    return {
      tournament: this.view(state),
      baseCurrency: this.options.baseCurrency,
      fx: { ...this.options.fx },
      // Before the start every entrant simply holds the starting cash.
      asOf: state.status === "upcoming" ? now : state.asOf,
      entries: state.frozen ?? this.standings(state),
      queued: [...state.queued.keys()],
    };
  }

  /**
   * Moves tournaments through upcoming -> live -> finished as the clock
   * passes their start and end, and keeps the rolling schedule filled.
   * Called before anything reads or changes a tournament (and before the
   * gateway applies each batch of engine events), so a result is frozen
   * before any trade after the end can reach it.
   */
  advance(now: number): void {
    if (now < this.nextDue) return;
    this.roll(now);
    let due = Infinity;
    for (const state of this.tournaments.values()) {
      if (state.status === "upcoming" && now >= state.start) {
        // Entrants were frozen flat until now, and their statistics already start from the
        // starting equity: sampling here would only add a zero return that no trading earned.
        state.status = "live";
        state.asOf = now;
      }
      if (state.status === "live" && now >= state.end) this.finish(state, now);
      if (state.status === "upcoming") due = Math.min(due, state.start);
      else if (state.status === "live") due = Math.min(due, state.end);
    }
    if (this.options.rollingMs !== undefined) due = Math.min(due, (Math.floor(now / this.options.rollingMs) + 1) * this.options.rollingMs);
    this.prune();
    this.nextDue = due;
  }

  private finish(state: State, now: number): void {
    // The last sample is part of the result: a drawdown in the final second counts.
    this.sampleAll(state, now);
    state.frozen = this.standings(state);
    state.status = "finished";
    for (const traderId of state.participants.keys()) {
      if (this.entered.get(traderId) !== state) continue;
      this.entered.delete(traderId);
      // After the final sample, so the reset cannot reach this tournament's result.
      const next = this.queued.get(traderId);
      if (next !== undefined) this.enterQueued(next, traderId);
    }
  }

  /** Makes a queued entry now that the trader's previous tournament is over, or lets it lapse. */
  private enterQueued(state: State, traderId: string): void {
    const since = state.queued.get(traderId)!;
    state.queued.delete(traderId);
    this.queued.delete(traderId);
    // The one queued for may have come and gone in the same clock jump.
    if (state.status === "finished") return;
    // Signing up is when they joined: the joined-first tie-break rewards it.
    if (this.enter(state, traderId, since)) {
      this.host.notice(traderId, "info", `${state.name}: your account was reset to the starting cash, and you are in.`);
    } else {
      this.host.notice(
        traderId,
        "warning",
        `${state.name}: your entry lapsed, because your account still had a position or an order when your last tournament ended. Join again once it is flat.`,
      );
    }
  }

  /** Keeps the current and the next rolling slot listed, so there is always one to join before it starts. */
  private roll(now: number): void {
    const ms = this.options.rollingMs;
    if (ms === undefined) return;
    const slot = Math.floor(now / ms) * ms;
    for (const start of [slot, slot + ms]) {
      const listed = [...this.tournaments.values()].some((s) => s.rolling && s.start === start);
      if (!listed) this.addRolling(start, start + ms, now);
    }
  }

  private addRolling(start: number, end: number, now: number): void {
    const time = (ms: number) => new Date(ms).toISOString().slice(11, this.options.rollingMs! % 60_000 === 0 ? 16 : 19);
    const state: State = {
      id: `t${this.nextId++}`,
      name: `Rolling ${time(start)}–${time(end)} UTC`,
      start,
      end,
      startingCash: { ...this.options.startingCash },
      startingEquity: cashToBase(this.options.startingCash, this.options.fx),
      status: "upcoming",
      rolling: true,
      participants: new Map(),
      queued: new Map(),
      asOf: now,
      frozen: null,
    };
    this.tournaments.set(state.id, state);
  }

  private prune(): void {
    const finished = [...this.tournaments.values()].filter((s) => s.status === "finished").sort((a, b) => a.end - b.end);
    for (const state of finished.slice(0, Math.max(0, finished.length - this.options.keepFinished))) this.tournaments.delete(state.id);
  }

  private sampleAll(state: State, now: number): void {
    for (const p of state.participants.values()) {
      const balances = this.host.balances(p.traderId);
      if (balances === undefined) continue;
      // The gateway checks every currency has a rate up front; should one still be missing, this
      // runs while engine events are routed, so it must skip the sample rather than throw.
      let equity: number;
      try {
        equity = toBase(balances, this.options.fx);
      } catch {
        continue;
      }
      p.stats.add(equity);
    }
    state.asOf = now;
  }

  private standings(state: State): LeaderboardEntry[] {
    return rank(
      [...state.participants.values()].map((p) => ({
        traderId: p.traderId,
        name: this.host.name(p.traderId),
        joinedAt: p.joinedAt,
        equity: p.stats.last,
        returnPct: p.stats.returnPct,
        maxDrawdownPct: p.stats.maxDrawdownPct,
        trades: p.trades,
        sharpe: p.stats.sharpe,
      })),
    );
  }

  private view(state: State): Tournament {
    return {
      id: state.id,
      name: state.name,
      start: state.start,
      end: state.end,
      startingCash: { ...state.startingCash },
      startingEquity: state.startingEquity,
      status: state.status,
      participants: state.participants.size,
      rolling: state.rolling,
    };
  }
}
