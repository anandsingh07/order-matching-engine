import { shiftDecimal, toExactUnits } from "./numbers.ts";
import { parseWithRules, tokenize, type Role } from "./rules.ts";
import type { MarketInstrument, OrderFields, Problem } from "./types.ts";

// The model reads; the text has to back what it read. Every number in its
// answer must be one the user wrote, and every number the user wrote must be
// in its answer, each used once and, where a word says what it is ("at 4100",
// "stop 4000"), in that field. Its side and its instrument must be ones the
// text names, and a cancel needs a cancel word. Its order type and time in
// force come from the text's own words (wordsDecide). Each check comes from a
// failure seen in the evaluation:
// - qwen2.5:1.5b read "please buy ten shares of tata consultancy at 4100
//   rupees" as a market order (the first live check): the price was dropped,
//   and the answer was otherwise valid.
// - It read "buy 10 apple shares" as 10 RELIANCE, "buy 10" as 10 BTCUSDT,
//   "infy 20 becho" (sell) as a buy, and "10 infy at 1850" as a buy.
//
// - Both read "buy 10 tcs or infy at market" as 10 TCS, gave cancels sides
//   the text never said, and dropped the limit of "stop 4000 limit 3990".
//   So a number the text labels ("limit 3990") fills a field the reading left
//   empty, and a fully read cancel takes its side and instrument from the text.
//
// - A review then found what all of that let through, because every number
//   and name in it is the user's: "don't buy 10 tcs at 4100" (a negation),
//   "buy 10 tata motors at 900" (read as TCS), a cancel answered with no
//   side or instrument (every open order), and a condition ("if it falls to
//   4000") read as a limit that fills at once. The rules now refuse the first
//   two outright, and the checks below the last two.
//
// The rule parser supplies what the text contains: its tokenizer reads "ten",
// "4.1k", "Rs 4,100.50" and "1.5 lakh" as the numbers they mean, and its
// vocabulary and typo-tolerant name matching see "becho" and "infosis". The
// price of that: a word or a nickname only the model knows ("RIL" for
// Reliance) is refused, unless the caller lists it in an instrument's aliases.

const PLAIN = /^\d+(\.\d+)?$/;

/** "4100.50" and "4100.5" are the same number. */
const canonical = (decimal: string) => shiftDecimal(decimal, 0);

const numbersIn = (text: string) => tokenize(text).flatMap((t) => (t.number === undefined ? [] : [canonical(t.number)]));

/** Removes one occurrence of each of `taken` from `pool`; returns those that were not there. */
function take(pool: string[], taken: readonly string[]): string[] {
  const missing: string[] = [];
  for (const n of taken) {
    const k = pool.indexOf(n);
    if (k >= 0) pool.splice(k, 1);
    else missing.push(n);
  }
  return missing;
}

export interface CheckedReading {
  /** The reading to validate: the model's, with its order type and time in force taken from the text's own words. */
  fields: OrderFields;
  /** Anything the text does not back. Any problem makes the request unclear. */
  problems: Problem[];
}

/**
 * Checks a model's reading of `text`. An answer of "unclear" needs no check.
 * A cancel uses no numbers, so a cancel read from text with a quantity or
 * price in it ("buy 10 btc and cancel my tcs orders") is a problem too.
 */
export function checkReading(text: string, reading: OrderFields, instruments: readonly MarketInstrument[]): CheckedReading {
  if (reading.intent === "unclear") return { fields: reading, problems: [] };
  const problems: Problem[] = [];
  const rules = parseWithRules(text, instruments);
  const { named } = rules;
  // What makes the text unclear to the rules whatever its unknown words mean
  // (two prices, both sides, two instruments or times in force, a minus
  // sign, "at market" with a limit price, "don't", a vague quantity) makes
  // any reading of it unclear too. Without this, the repairs below made a
  // wrong order: qwen2.5:1.5b read "buy 10 infy at market, limit 1850" as a
  // limit order with no price (unclear on its own), and the stated "limit
  // 1850" then filled it in, hiding the "at market". The checks this returns
  // for are not repeated below.
  const blocking = reading.intent === "order" ? rules.blocking : rules.conflicts;
  if (blocking.length > 0) return { fields: reading, problems: blocking.map((message) => ({ field: "text", message })) };
  // A cancel needs a cancel word too, or any text the model cannot place
  // (an injection attempt, say) could come back as "cancel all your orders".
  if (reading.intent === "cancel" && !named.cancel) problems.push({ field: "intent", message: "nothing in the text says cancel" });
  const fields = { ...reading, ...wordsDecide(reading, named) };
  if (fields.intent === "cancel" && rules.understood) {
    // Both models gave cancels a side the text never says ("cancel my TCS
    // order" as sell orders). When the rules read every word, the side and
    // instrument are simply theirs. Not otherwise: an unknown word may be the
    // instrument or the side ("RIL", "asks"), and dropping the model's would
    // widen the cancel.
    fields.side = rules.fields.side;
    fields.symbol = rules.fields.symbol;
  } else if (fields.intent === "cancel") {
    // The other way to get a cancel wrong: leaving out what the text names.
    // For a cancel, null means every instrument or both sides, so a model
    // that answered {} for "delete my hdfc bank bids" proposed cancelling
    // every open order. Wider than the text is allowed only where it says
    // "all" or "every".
    if (named.symbols.length > 0 && fields.symbol === null) problems.push({ field: "symbol", message: `the text names ${named.symbols.join(", ")}, but the reading cancels every instrument` });
    else if (fields.symbol === null && !named.all) problems.push({ field: "symbol", message: "the reading cancels every instrument, but the text does not say all" });
    if (named.sides.length > 0 && fields.side === null) problems.push({ field: "side", message: `the text says ${named.sides.join(", ")}, but the reading cancels both sides` });
    else if (fields.side === null && !named.all) problems.push({ field: "side", message: "the reading cancels both buy and sell orders, but the text does not say all" });
  }
  // A stock and its futures and options are one company.
  const companyOf = (symbol: string) => instruments.find((i) => i.symbol === symbol)?.underlying ?? symbol;
  const companies = new Set(named.symbols.map(companyOf));
  // Fill in what the text labels only when the rules read every word. With
  // an unknown word, a field the model left empty may be its way of saying
  // the text is not that order: it left the quantity and the price of "don't
  // buy 10 tcs at 4100" empty, and filling them in made the order.
  if (fields.intent === "order" && rules.understood) fillStated(fields, named.roles, numbersIn(text));
  if (fields.side !== null && !named.sides.includes(fields.side)) problems.push({ field: "side", message: `nothing in the text says ${fields.side}` });
  // An unlisted symbol is left to validation, which says so. A future or
  // option counts as named when its stock is, or when it is named itself.
  const instrument = instruments.find((i) => i.symbol === fields.symbol);
  if (instrument !== undefined && !companies.has(companyOf(instrument.symbol))) {
    problems.push({ field: "symbol", message: `nothing in the text names ${instrument.symbol}` });
  }

  const written = numbersIn(text);
  const used = [fields.quantity, fields.price, fields.stopPrice, fields.displayQuantity].filter((v): v is string => v !== null && PLAIN.test(v)).map(canonical);
  // Values that are not plain numbers are left to validation, which names them.
  const invented = take(written, used);
  // A number in the instrument's own name ("4100" in "TCS 4100 call") is accounted for by the symbol.
  if (instrument !== undefined) take(written, numbersIn(`${instrument.symbol} ${instrument.name}`));

  for (const n of invented) problems.push({ field: "model", message: `the reading has ${n}, which is not in the text` });
  for (const n of written) problems.push({ field: "model", message: `the text says ${n}, but the reading leaves it out` });

  // Using every number once is not enough: a reading can swap them. "sell 40
  // tcs stop 4000 limit 3990" read with the two prices exchanged is a valid
  // stop-limit, so validation would pass it. Where a word says what a number
  // is ("at", "limit", "stop", "show", "shares", or the instrument right after
  // it), the reading has to put it there.
  const valueOf = (role: Role) => {
    const v = fields[FIELD[role]];
    return v !== null && PLAIN.test(v) ? canonical(v) : null;
  };
  for (const role of ROLES) {
    for (const n of named.roles[role].map(canonical)) {
      // A number the reading left out is reported above already.
      if (valueOf(role) === n || written.includes(n)) continue;
      const placed = ROLES.find((other) => other !== role && valueOf(other) === n);
      if (placed !== undefined) problems.push({ field: FIELD[role], message: `the text gives ${n} as the ${LABEL[role]}, but the reading has it as the ${LABEL[placed]}` });
    }
  }

  // "sell 3 tcs if it falls to 4000" waits for 4000, and no cue word says
  // which field it belongs in. A stop there is checked by validation (it
  // must not trigger at once). A limit at 4000 is right only if it, too,
  // waits: a buy below the market or a sell above it ("buy if it drops to
  // 4000"). A sell limit at 4000 with the market at 4100 fills now, the
  // opposite of what was asked, and passed every other check.
  for (const n of named.triggers.map(canonical)) {
    for (const role of ["quantity", "display"] as const) {
      if (valueOf(role) === n) problems.push({ field: FIELD[role], message: `the text waits for the price to reach ${n}, but the reading has it as the ${LABEL[role]}` });
    }
    if (valueOf("price") !== n || fields.stopPrice !== null || instrument === undefined || fields.side === null) continue;
    const limit = toExactUnits(n, instrument.priceScale);
    const market = instrument.lastPrice ?? instrument.referencePrice;
    if ("value" in limit && market > 0 && (fields.side === "buy" ? limit.value >= market : limit.value <= market)) {
      problems.push({ field: "price", message: `the text waits for the price to reach ${n}, but a ${fields.side} limit at ${n} fills at once; that would be a stop order` });
    }
  }
  return { fields, problems };
}

const ROLES: readonly Role[] = ["quantity", "price", "stop", "display"];
const FIELD = { quantity: "quantity", price: "price", stop: "stopPrice", display: "displayQuantity" } as const satisfies Record<Role, keyof OrderFields>;
const LABEL: Record<Role, string> = { quantity: "quantity", price: "limit price", stop: "stop price", display: "display size" };

/**
 * Fills a field the reading left empty with the number the text puts there
 * ("limit 3990", "show 30", "at 4100"), when the text gives exactly one and
 * the reading has not used it elsewhere. Both models dropped the limit of
 * "stop 4000 limit 3990" on the dev set, and qwen2.5:1.5b dropped the price of
 * "buy ten shares of tata consultancy at 4100 rupees" in the first live
 * check. The rules see these numbers reliably, so the model is left to read
 * only what has no such word.
 */
function fillStated(fields: OrderFields, roles: Record<Role, string[]>, written: readonly string[]): void {
  const count = (list: readonly string[], n: string) => list.filter((v) => v === n).length;
  for (const role of ROLES) {
    const stated = roles[role];
    if (stated.length !== 1 || fields[FIELD[role]] !== null) continue;
    const n = canonical(stated[0]!);
    const used = ROLES.map((r) => fields[FIELD[r]]).filter((v): v is string => v !== null && PLAIN.test(v)).map(canonical);
    // "show 10" in "buy 10 tcs at 4100, show 10 at a time" is still free when the quantity used the other 10.
    if (count(written, n) > count(used, n)) fields[FIELD[role]] = stated[0]!;
  }
}

/**
 * The order type and time in force, from the text's own words. Both models
 * wrote a price and then called the order "market" ("buy 0.25 bitcoin at
 * 79,950"; qwen2.5:1.5b did it in 9 of 61 dev orders), and put IOC on orders
 * that never said it. So the model's type stands only where the text has a
 * word for it; otherwise validation infers it from the (checked) prices, as
 * it does for the rules. Time-in-force words are few and unambiguous, so the
 * rules' reading of them is simply used.
 */
function wordsDecide(reading: OrderFields, named: ReturnType<typeof parseWithRules>["named"]): Partial<OrderFields> {
  const t = reading.orderType;
  const backed = t === "market" ? named.market : t === "limit" ? named.limit : t === "stop" || t === "stop_limit" ? named.stop : false;
  const orderType = backed ? t : null;
  let { price, stopPrice } = reading;
  // "stop loss sell 20 hdfc at 1680": with a stop named and one price, that
  // price is the trigger. The rules read it the same way.
  if ((orderType === "stop" || orderType === "stop_limit") && stopPrice === null && price !== null) [stopPrice, price] = [price, null];
  return { orderType, price, stopPrice, timeInForce: named.timesInForce.length === 1 ? named.timesInForce[0]! : null };
}
