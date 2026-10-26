import type { MarketInstrument } from "./types.ts";

// Matching what people call an instrument ("tata consultancy", "infosis",
// "btc") to its symbol. Aliases are derived from the instrument list itself,
// so a new listing needs no code change; callers can add more.

/** Words that do not identify a company on their own. */
const GENERIC = new Set(["industries", "industry", "services", "service", "limited", "ltd", "corp", "corporation", "inc", "company", "co", "the", "of", "and"]);

export interface Alias {
  words: string[];
  symbol: string;
  /**
   * The first words of a longer name ("tata", "hdfc", "reliance", "bitcoin",
   * "tata consultancy"). Other companies start the same way ("tata motors",
   * "hdfc life", "reliance power", "bitcoin cash"), so the rules refuse a
   * short name followed by a word they cannot place.
   */
  short?: boolean;
}

export const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "");

/**
 * Every name an instrument answers to, as word lists:
 * - the symbol ("tcs", "hdfcbank");
 * - the full name, and the name without generic words ("tata consultancy");
 * - for a pair named "Bitcoin / Tether", the first part ("bitcoin");
 * - for a symbol ending in its currency (BTCUSDT), the base ("btc");
 * - a distinctive first word of the name ("tata", "reliance"), if no other instrument shares it;
 * - the caller's aliases.
 */
export function buildAliases(instruments: readonly MarketInstrument[]): Alias[] {
  // Who a first word belongs to: a stock and its futures and options are one
  // company, so TCS's eleven derivative series must not make "tata" ambiguous.
  const firstWords = new Map<string, Set<string>>();
  for (const i of instruments) {
    const first = words(i.name)[0];
    if (first !== undefined) firstWords.set(first, (firstWords.get(first) ?? new Set()).add(i.underlying ?? i.symbol));
  }
  const aliases: Alias[] = [];
  for (const i of instruments) {
    const names = new Set<string>([i.symbol, i.name, ...(i.aliases ?? [])]);
    const main = i.name.split("/")[0]!;
    names.add(main);
    names.add(words(main).filter((w) => !GENERIC.has(w)).join(" "));
    const currency = i.currency.toUpperCase();
    if (i.symbol.endsWith(currency) && i.symbol.length > currency.length) names.add(i.symbol.slice(0, -currency.length));
    // Short names belong to the stock itself, never to one of its contracts.
    const spot = (i.kind ?? "spot") === "spot";
    const first = words(main)[0];
    if (spot && first !== undefined && first.length >= 4 && firstWords.get(first)?.size === 1) names.add(first);
    // "HDFC Bank" is usually just "hdfc": a name's leading acronym.
    if (spot && first !== undefined && /^[A-Z]{3,}$/.test(main.trim().split(/\s+/)[0]!)) names.add(first);
    const full = words(i.name);
    for (const name of names) {
      const w = words(name);
      if (w.length === 0) continue;
      const short = w.length < full.length && w.every((x, k) => full[k] === x);
      aliases.push(short ? { words: w, symbol: i.symbol, short } : { words: w, symbol: i.symbol });
    }
  }
  // Longest names first, so "hdfc bank" wins over "hdfc".
  return aliases.sort((a, b) => b.words.length - a.words.length);
}

/** Optimal string alignment distance: edits, counting a swapped pair of letters as one ("relaince"). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** How many typos a word of this length may have and still match: none for short words, where one edit is another word. */
const allowedTypos = (word: string) => (word.length >= 7 ? 2 : word.length >= 4 ? 1 : 0);

export interface InstrumentMatch {
  symbol: string;
  /** Words of the input it covered. */
  used: number;
  exact: boolean;
  /** Matched by a short name (Alias.short). */
  short: boolean;
}

/**
 * The instrument named at the start of `tokens`, if any. Exact names are
 * preferred to typo matches of the same length; a typo that is equally close
 * to two different instruments matches neither, because guessing between
 * companies is not something to do silently. A typo match that covers more
 * words wins: "tata consultency" is Tata Consultancy misspelt, not "tata"
 * followed by a word that might name another Tata company.
 */
export function matchInstrument(tokens: readonly string[], aliases: readonly Alias[]): InstrumentMatch | null {
  const exact = aliases.find((alias) => alias.words.length <= tokens.length && alias.words.every((w, k) => tokens[k] === w));
  const typo = typoMatch(tokens, aliases);
  if (typo !== null && (exact === undefined || typo.used > exact.words.length)) return typo;
  return exact === undefined ? null : { symbol: exact.symbol, used: exact.words.length, exact: true, short: exact.short === true };
}

function typoMatch(tokens: readonly string[], aliases: readonly Alias[]): InstrumentMatch | null {
  let best: { symbol: string; used: number; distance: number; short: boolean } | null = null;
  let tied = false;
  for (const alias of aliases) {
    const n = alias.words.length;
    if (n > tokens.length) continue;
    let distance = 0;
    let ok = true;
    for (let k = 0; k < n && ok; k++) {
      const typed = tokens[k]!;
      const e = editDistance(typed, alias.words[k]!);
      if (e > allowedTypos(alias.words[k]!) || (e > 0 && !/^[a-z]+$/.test(typed))) ok = false;
      distance += e;
    }
    if (!ok || distance === 0) continue;
    if (best === null || n > best.used || (n === best.used && distance < best.distance)) {
      best = { symbol: alias.symbol, used: n, distance, short: alias.short === true };
      tied = false;
    } else if (n === best.used && distance === best.distance && alias.symbol !== best.symbol) {
      tied = true;
    }
  }
  return best !== null && !tied ? { symbol: best.symbol, used: best.used, exact: false, short: best.short } : null;
}
