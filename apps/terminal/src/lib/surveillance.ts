/** One trader on one symbol, as the surveillance report lists them. */
export interface Watched {
  traderId: string;
  symbol: string;
  /** When the assessment was made (current) or the alert raised (log). */
  time: number;
  assessment: { flagged: boolean };
}

/** Surveillance watches each trader per symbol. */
export const watchKey = (a: Pick<Watched, "traderId" | "symbol">) => `${a.traderId}|${a.symbol}`;

/**
 * The flagged traders in a stable order: longest flagged first, ties by
 * trader and symbol. The gateway lists them most suspicious first, and
 * suspicion moves with every scan, so cards in its order swap places on
 * every poll and nobody can follow one.
 *
 * `since` remembers when each was first seen flagged and is updated in place:
 * pass the same map on every poll. A trader seen for the first time is dated
 * by its oldest entry in the alert log (so a page opened mid-session still
 * lists them in the order they were caught), or by the assessment's time.
 * One who drops out of the flagged list and comes back keeps its place.
 */
export function flaggedInOrder<T extends Watched>(current: T[], log: Watched[], since: Map<string, number>): T[] {
  const flagged = current.filter((a) => a.assessment.flagged);
  for (const a of flagged) {
    const key = watchKey(a);
    if (since.has(key)) continue;
    const logged = log.filter((l) => watchKey(l) === key).map((l) => l.time);
    since.set(key, Math.min(a.time, ...logged));
  }
  const at = (a: T) => since.get(watchKey(a))!;
  return flagged.sort((a, b) => at(a) - at(b) || (watchKey(a) < watchKey(b) ? -1 : watchKey(a) > watchKey(b) ? 1 : 0));
}
