// Exact decimal handling. People write "Rs 4,100.50", "4.1k", "ten" or
// "1.5 lakh"; the exchange wants integer ticks. Everything here works on
// decimal strings, so "0.1 + 0.2" style errors cannot creep in between what was
// typed and what is sent.

const PLAIN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Digits with thousands separators, Western ("4,100", "1,000,000") or Indian
 * ("1,00,000", "12,34,567"), never starting with 0. Anything else with a comma
 * between digits is not read at all: deleting every comma made "0,05 btc"
 * (a decimal comma) 5 BTC and "4100,50" a price of 410050, proposed with
 * full confidence and agreed with by the text check, since it read the text
 * the same way.
 */
const GROUPED = /^(?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d?(?:,\d{2})*,\d{3})$/;
/** A run of digits and commas, not part of a longer number ("1.5,000"). */
const COMMA_RUN = /(^|[^\d.,])(\d+(?:,\d+)+)/g;

/** Removes the commas of every correctly grouped number; leaves any other comma between digits where it is. */
export function stripGrouping(text: string): string {
  return text.replace(COMMA_RUN, (all, before: string, run: string) => (GROUPED.test(run) ? before + run.replace(/,/g, "") : all));
}

/** The numbers whose commas are not thousands separators ("0,05", "2,5", "4100,50"): no one reading of them is safe. */
export function misgroupedNumbers(text: string): string[] {
  return [...text.matchAll(COMMA_RUN)].map((m) => m[2]!).filter((run) => !GROUPED.test(run));
}

/** "4,100.50" -> "4100.50"; "1,00,000" (Indian grouping) -> "100000". Null if it is not a plain positive decimal, or its commas are not thousands separators. */
export function cleanDecimal(text: string): string | null {
  const s = stripGrouping(text.trim());
  return PLAIN.test(s) ? s : null;
}

/** Multiplies a decimal string by 10^places exactly: shiftDecimal("4.1", 3) === "4100". */
export function shiftDecimal(decimal: string, places: number): string {
  const match = PLAIN.exec(decimal);
  if (match === null) throw new Error(`not a plain decimal: ${decimal}`);
  const digits = match[1]! + (match[2] ?? "");
  const point = match[1]!.length + places;
  const padded = point > digits.length ? digits.padEnd(point, "0") : digits;
  const whole = padded.slice(0, point).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(point).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * A JSON number from the model to a decimal string. String(n) gives the
 * shortest text that round-trips, which is what the model wrote (4100.5 ->
 * "4100.5"). Negative, non-finite and exponent forms are refused: no real
 * order is written as 1e-7.
 */
export function numberToDecimal(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const s = String(n);
  return PLAIN.test(s) ? s : null;
}

/**
 * Decimal string to integer units at a scale (100 for paise, 100_000 for
 * BTC's five decimals), refusing to drop digits: "2.5" shares is an error,
 * never silently 2. Trailing zeros beyond the scale are fine.
 */
export function toExactUnits(decimal: string, scale: number): { value: number } | { error: string } {
  const match = PLAIN.exec(decimal);
  if (match === null) return { error: "is not a plain number" };
  const places = Math.round(Math.log10(scale));
  const fraction = match[2] ?? "";
  if (/[1-9]/.test(fraction.slice(places))) {
    return { error: places === 0 ? "must be a whole number" : `can have at most ${places} decimal places` };
  }
  const value = Number(match[1]! + fraction.slice(0, places).padEnd(places, "0"));
  if (!Number.isSafeInteger(value)) return { error: "is too large" };
  if (value <= 0) return { error: "must be more than zero" };
  return { value };
}

/** Multipliers people put after a number. "lakh" and "crore" are Indian English (10^5, 10^7). */
export const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 3,
  thousand: 3,
  hazaar: 3,
  hazar: 3,
  lakh: 5,
  lakhs: 5,
  lac: 5,
  lacs: 5,
  crore: 7,
  crores: 7,
  cr: 7,
  mn: 6,
  million: 6,
};

/**
 * Rewrites the numbers in a request into plain decimals before a model reads
 * it: "79,950" -> "79950", "4.1k" -> "4100", "1.5 lakh" -> "150000". Small
 * models misread these (a comma as a decimal point, "2k" as 2); doing it
 * exactly here costs nothing and leaves the model only the words. A comma
 * that is not a thousands separator ("0,05") is left for the model to see as
 * written; the rules refuse any reading of it anyway.
 */
export function normaliseNumbers(text: string): string {
  return stripGrouping(text)
    .replace(/(\d+(?:\.\d+)?)\s*(k|lakhs?|lacs?|crores?|cr)\b/gi, (_, n: string, unit: string) => shiftDecimal(n, MULTIPLIERS[unit.toLowerCase()]!));
}

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12,
  // A little Hindi, as typed in Hinglish chat. "do" (two) is left out on
  // purpose: it is far more often the verb in "bech do".
  ek: 1, teen: 3, char: 4, paanch: 5, panch: 5, das: 10, bees: 20, pachas: 50, pachaas: 50,
};

const SCALES: Readonly<Record<string, number>> = { hundred: 100, sau: 100, thousand: 1000, hazaar: 1000, hazar: 1000 };

export const isNumberWord = (word: string) => word in UNITS || word in SCALES;

/**
 * Reads number words from the start of `words`: ["twenty", "five"] -> 25,
 * ["two", "hundred"] -> 200, ["a", "dozen"] -> 12. Returns the value and how
 * many words it used, or null if the first word is not a number word.
 */
export function readNumberWords(words: readonly string[]): { value: number; used: number } | null {
  let total = 0;
  let current = 0;
  let used = 0;
  let any = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    // "a hundred", "a dozen": "a" only counts when a number word follows it.
    if (w === "a" && !any && i + 1 < words.length && isNumberWord(words[i + 1]!)) {
      current = 1;
      used = i + 1;
      continue;
    }
    const unit = UNITS[w];
    const scale = SCALES[w];
    if (unit !== undefined) {
      if (w === "dozen") current = (current || 1) * 12;
      else current += unit;
    } else if (scale !== undefined) {
      current = (current || 1) * scale;
      if (scale >= 1000) {
        total += current;
        current = 0;
      }
    } else break;
    any = true;
    used = i + 1;
  }
  return any ? { value: total + current, used } : null;
}
