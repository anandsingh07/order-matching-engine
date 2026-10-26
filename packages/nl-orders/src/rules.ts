import type { Side } from "@ome/client";
import { buildAliases, matchInstrument, type Alias } from "./instruments.ts";
import { cleanDecimal, misgroupedNumbers, MULTIPLIERS, readNumberWords, shiftDecimal, stripGrouping } from "./numbers.ts";
import type { MarketInstrument, OrderFields, OrderKind, TimeInForce } from "./types.ts";

// The rule-based parser: a vocabulary and a few rules about which number is
// which. It is the baseline the model has to beat, the fallback when Ollama is
// not running, and the fast path in hybrid mode. It is deliberately
// conservative: a word it does not know means "not understood", never a guess,
// so hybrid mode can hand exactly those requests to the model.

export type Role = "quantity" | "price" | "stop" | "display";

type Entry =
  | { kind: "side"; side: Side }
  | { kind: "cancel" | "market" | "limit_type" | "stop_type" | "stop_limit" | "iceberg" | "vague" | "all" | "notional" | "negative" | "modifier" | "filler" }
  | { kind: "tif"; tif: TimeInForce }
  /** Prefix cue: the next number has this role ("at 4100", "stop 4000"). */
  | { kind: "cue"; role: Role; limit?: boolean }
  /** Postfix: the number just before has this role ("10 shares", "4100 pe"). Before a number, some act as cues ("rs 4100"). */
  | { kind: "post"; role: Role; prefix?: boolean };

const phrase = (text: string, entry: Entry) => ({ words: text.split(" "), entry });

// The plurals ("bids", "offers", "asks", "buys", "sells") name a cancel's
// side. Unknown to the rules, they sent "pull all my bids" to the model, and
// a model answer with no side (both sides) would have cancelled sells too.
const PHRASES = [
  ...["buy", "buying", "purchase", "go long", "long", "get", "get me", "pick up", "acquire", "accumulate", "bid", "bids", "buys", "kharido", "khareedo", "kharid", "kharid lo", "le lo", "lelo", "lena"].map((t) => phrase(t, { kind: "side", side: "buy" })),
  ...["sell", "selling", "short", "go short", "short sell", "dump", "offload", "unload", "get rid of", "offer", "offers", "ask", "asks", "sells", "becho", "bech", "bech do", "bechdo", "bechna"].map((t) => phrase(t, { kind: "side", side: "sell" })),
  ...["cancel", "pull", "withdraw", "kill", "remove", "delete", "hatao", "hata do"].map((t) => phrase(t, { kind: "cancel" })),
  ...["market", "at market", "at the market", "mkt", "at mkt", "market order", "market price", "at market price", "market rate", "market pe", "market par", "market price pe"].map((t) => phrase(t, { kind: "market" })),
  ...["ioc", "immediate or cancel"].map((t) => phrase(t, { kind: "tif", tif: "IOC" })),
  ...["fok", "fill or kill"].map((t) => phrase(t, { kind: "tif", tif: "FOK" })),
  ...["gtc", "good till cancelled", "good till canceled", "good til cancelled", "good til canceled", "good until cancelled", "good until canceled", "good till cancel"].map((t) =>
    phrase(t, { kind: "tif", tif: "GTC" }),
  ),
  ...["at", "@", "price", "at price", "price of", "at a price of"].map((t) => phrase(t, { kind: "cue", role: "price" })),
  ...["limit", "limit price", "limit at", "limit of", "lmt", "limit order at"].map((t) => phrase(t, { kind: "cue", role: "price", limit: true })),
  ...["stop", "stop at", "stop loss", "stop loss at", "stoploss", "stoploss at", "sl", "sl at", "trigger", "trigger at", "trigger price", "stop price", "stop trigger"].map((t) =>
    phrase(t, { kind: "cue", role: "stop" }),
  ),
  ...["stop limit", "stop limit order"].map((t) => phrase(t, { kind: "stop_limit" })),
  ...["limit order", "a limit order"].map((t) => phrase(t, { kind: "limit_type" })),
  ...["stop order", "stop loss order", "sl order", "stop market", "stop market order"].map((t) => phrase(t, { kind: "stop_type" })),
  ...["show", "show only", "display", "disclose", "disclosed quantity", "disclosed qty", "dq", "show just"].map((t) => phrase(t, { kind: "cue", role: "display" })),
  ...["at a time", "at once", "at one time", "visible"].map((t) => phrase(t, { kind: "post", role: "display", prefix: t === "visible" })),
  ...["iceberg", "iceberg order"].map((t) => phrase(t, { kind: "iceberg" })),
  ...["qty", "quantity", "qty of", "quantity of"].map((t) => phrase(t, { kind: "cue", role: "quantity" })),
  ...["shares", "share", "stocks", "stock", "units", "unit", "coins", "coin", "nos"].map((t) => phrase(t, { kind: "post", role: "quantity" })),
  ...["rs", "inr", "rupees", "rupee", "rupaye", "usdt", "usd", "$", "dollars", "dollar", "bucks"].map((t) => phrase(t, { kind: "post", role: "price", prefix: true })),
  ...["pe", "par", "pr", "ke bhav pe", "ke bhav par", "ke rate pe", "ke rate par", "each", "apiece", "a piece", "per share", "a share", "per unit", "per coin"].map((t) =>
    phrase(t, { kind: "post", role: "price" }),
  ),
  // A part ("some", "half") is vague for an order and for a cancel alike;
  // "all" is vague only for an order. Treating them as one list let "cancel
  // half my tcs order" through as a cancel of every TCS order.
  ...["some", "few", "a few", "half", "as many as", "bunch", "kuch", "lots of"].map((t) => phrase(t, { kind: "vague" })),
  ...["all", "everything", "every", "entire", "whole", "saare", "sab"].map((t) => phrase(t, { kind: "all" })),
  ...["worth", "worth of", "amount", "value of"].map((t) => phrase(t, { kind: "notional" })),
  phrase("minus", { kind: "negative" }),
  // Words that negate, hedge, schedule or repeat what the rest says. The
  // model read "don't buy 10 tcs at 4100" and "should i buy 10 tcs at 4100"
  // as the order itself, and every number and name in them is the user's, so
  // nothing else in the text check could object. Any of these makes the text
  // unclear, whoever reads it.
  ...[
    "not", "do not", "does not", "don t", "dont", "doesn t", "won t", "wont", "cannot", "can t", "never", "no", "mat", "nahi", "nahin",
    // "stop selling 10 tcs at 4000" was read as a sell stop at 4000.
    "stop buying", "stop selling", "hold off", "avoid", "skip", "refrain from", "never mind", "nevermind",
    "maybe", "perhaps", "might", "should", "whether", "wonder", "?",
    "tomorrow", "tonight", "later", "kal", "next week", "next month", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "at open", "at the open", "at close", "at the close", "eod", "end of day",
    "twice", "thrice", "again", "times", "daily", "weekly", "every day", "each day", "repeat",
    "unless", "except", "but", "only if",
  ].map((t) => phrase(t, { kind: "modifier" })),
  ...(
    "please pls plz kindly i id want wanna would like to me my of the a an order orders place put in on for now right away quickly asap can you could go ahead and with using type just also then it per " +
    "position holding holdings my order " +
    "ke ka ki ko karo kar do dena de chahiye mujhe mere mera meri liye hai hain bhai yaar ji sir wala wale waala jaldi abhi se"
  )
    .split(" ")
    .map((t) => phrase(t, { kind: "filler" })),
].sort((a, b) => b.words.length - a.words.length);

interface Token {
  word: string;
  /** Exact decimal value, for number tokens. */
  number?: string;
}

/** Lower-cases, splits "10tcs" and "rs4100", drops punctuation, and turns "ten", "4.1k" and "1.5 lakh" into exact numbers. */
/** The first steps of tokenizing, up to the thousands separators: lower case, currencies spaced out, "-5" as "minus 5". */
function prepare(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/₹/g, " rs ")
      // "Rs.4100" is a currency, not "Rs" and ".4100"; ".5 btc" is 0.5.
      .replace(/\b(rs|inr)\.\s*/g, "$1 ")
      .replace(/(^|[^\d])\.(?=\d)/g, "$1 0.")
      .replace(/\$/g, " $ ")
      .replace(/@/g, " @ ")
      .replace(/\/-/g, " ")
      .replace(/(^|[^\w.])-\s*(?=\d)/g, "$1 minus ")
  );
}

export function tokenize(text: string): Token[] {
  // Only thousands separators go: "0,05" is left to become two numbers, and parseWithRules refuses it (misgroupedNumbers).
  const s = stripGrouping(prepare(text))
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/\?/g, " ? ")
    // A dot is part of a number only between digits ("4100.50", not "rs." or a full stop).
    .replace(/\.(?!\d)|(^|[^\d])\./g, "$1 ")
    .replace(/[^a-z0-9.$@?%\s]/g, " ");
  const raw = s.split(/\s+/).filter((w) => w !== "");

  const tokens: Token[] = [];
  for (let i = 0; i < raw.length; ) {
    const word = raw[i]!;
    let number = /^\d/.test(word) ? cleanDecimal(word) : null;
    let used = 1;
    if (number === null) {
      const spelled = readNumberWords(raw.slice(i));
      if (spelled !== null) {
        number = String(spelled.value);
        used = spelled.used;
      }
    }
    if (number === null) {
      tokens.push({ word });
      i += 1;
      continue;
    }
    const multiplier = MULTIPLIERS[raw[i + used] ?? ""];
    if (multiplier !== undefined) {
      number = shiftDecimal(number, multiplier);
      used += 1;
    } else if (raw[i + used] === "dozen" && /^\d+$/.test(number) && Number.isSafeInteger(Number(number) * 12)) {
      // "2 dozen" is 24, not 2 and then "dozen" (12) on its own.
      number = String(Number(number) * 12);
      used += 1;
    }
    tokens.push({ word: raw.slice(i, i + used).join(" "), number });
    i += used;
  }
  return tokens;
}

export interface RuleParse {
  fields: OrderFields;
  /**
   * True when every word was recognised and the numbers had one reading. A
   * request can be understood and still be unclear ("buy some TCS"): the rules
   * know that is vague.
   */
  understood: boolean;
  /**
   * True when the rules' answer should stand: every word was read, or the text
   * is unclear whatever its unknown words mean (two prices, both buy and sell,
   * a vague quantity). Hybrid mode sends only the rest to the model; without
   * this, "sell 10 at 1700 and 10 more at 1710" went to the model, which
   * proposed one of the two orders.
   */
  certain: boolean;
  /**
   * The reasons that make the text unclear whatever its unknown words mean:
   * the conflicts (two prices, both buy and sell, "at market" with a limit
   * price, "don't", a cancel mixed with an order) and, for an order, a vague
   * quantity, "all", or an amount of money. A model's order reading is
   * refused when there are any (ground.ts).
   */
  blocking: string[];
  /**
   * The conflicts alone: what refuses a model's cancel, where "all" is not
   * vague ("cancel all"). A part ("cancel half my tcs order") is a conflict.
   */
  conflicts: string[];
  /**
   * Every side word, instrument name, time in force and order-type word in
   * the text, whatever else it says. A model's reading may only use these
   * (ground.ts): the rules cannot always tell which number is which, but they
   * reliably see "becho", "infosys" or "fill or kill".
   */
  named: {
    sides: Side[];
    symbols: string[];
    timesInForce: TimeInForce[];
    /** "cancel", "pull", "withdraw", "hatao" and the like. */
    cancel: boolean;
    /** The order-type words: "at market", "limit", "stop" (or "sl", "trigger", "stop loss order"). */
    market: boolean;
    limit: boolean;
    stop: boolean;
    /** "all", "every", "everything", "saare": a cancel may cover every instrument or both sides only when it says so. */
    all: boolean;
    /**
     * Numbers whose role the text states: "at 4100" (price), "stop 4000",
     * "show 10", "10 shares", "10 tcs" (quantity). A number with no such word
     * ("buy tcs 10 4100") is left out, so the model may place it.
     */
    roles: Record<Role, string[]>;
    /**
     * Numbers the text waits for: after "if", "when" or "once", or a word
     * such as "falls", "crosses" or "below" ("sell 3 tcs if it falls to
     * 4000"). The rules do not read these sentences, but they do see that
     * such a number is a price to reach, not one to trade at now (ground.ts).
     */
    triggers: string[];
  };
}

/** Words that start a condition: a number has to follow, or there is nothing to wait for. */
const CONDITIONS = new Set(["if", "when", "whenever", "once", "agar", "jab"]);
/** Words that make the next number a price to reach. */
const DIRECTIONS = new Set([
  ...CONDITIONS,
  ...["falls", "fall", "drops", "drop", "dips", "dip", "goes", "rises", "rise", "crosses", "cross", "hits", "hit", "reaches", "reach", "touches", "touch", "breaks", "break"],
  ...["below", "above", "under", "over", "beneath"],
]);

const aliasCache = new WeakMap<readonly MarketInstrument[], Alias[]>();

function aliasesFor(instruments: readonly MarketInstrument[]): Alias[] {
  let aliases = aliasCache.get(instruments);
  if (aliases === undefined) {
    aliases = buildAliases(instruments);
    // "btc usdt": a pair written as base and quote.
    for (const i of instruments) {
      const c = i.currency.toLowerCase();
      const s = i.symbol.toLowerCase();
      if (s.endsWith(c) && s.length > c.length) aliases.unshift({ words: [s.slice(0, -c.length), c], symbol: i.symbol });
    }
    aliasCache.set(instruments, aliases);
  }
  return aliases;
}

export function parseWithRules(text: string, instruments: readonly MarketInstrument[]): RuleParse {
  const tokens = tokenize(text);
  const words = tokens.map((t) => t.word);
  const aliases = aliasesFor(instruments);

  const sides = new Set<Side>();
  const symbols = new Set<string>();
  const tifs = new Set<TimeInForce>();
  const numbers: { value: string; role: Role | null }[] = [];
  const unknown: string[] = [];
  const conflicts: string[] = [];
  let cancel = false;
  let market = false;
  let limit = false;
  let stopType = false;
  let stopLimit = false;
  /** Any stop word at all ("stop", "sl", "trigger", "stop loss order"), with or without its number. */
  let stopWord = false;
  let iceberg = false;
  let vague = false;
  let all = false;
  let notional = false;
  /** "don't", "maybe", "tomorrow", "twice"...: each as typed. */
  const modifiers: string[] = [];
  /** "tata" in "tata motors": a short name followed by a word that is not ours to place. */
  const otherCompanies: string[] = [];
  const triggers: string[] = [];
  /** A word such as "if" or "falls" seen, and the condition word ("if") still waiting for its number. */
  let toReach = false;
  let condition: string | null = null;
  /** In a cancel, "buy tcs" or "sell infy" is an order, not the cancel's side ("cancel my tcs buy orders"). */
  let sideThenInstrument = false;
  let sideJustBefore = false;
  /** Role announced by a prefix cue, waiting for its number. */
  let expect: Role | null = null;
  let dangling = false;
  /**
   * A cue followed by a word instead of a number. "stop loss sell 20 HDFC at
   * 1680" names the order type up front, so a stop cue without its number
   * marks a stop order; any other cue left hanging means the text was not read.
   */
  const settleCue = () => {
    if (expect === "stop") stopType = true;
    else if (expect !== null) dangling = true;
    expect = null;
  };
  /** The number token immediately before this one, if the previous token was a number. */
  let previous: { value: string; role: Role | null } | null = null;

  const phraseAt = (i: number) => PHRASES.find((p) => p.words.every((w, k) => words[i + k] === w));

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i]!;
    const afterSide = sideJustBefore;
    sideJustBefore = false;
    if (token.number !== undefined) {
      const n = { value: token.number, role: expect };
      numbers.push(n);
      if (toReach) triggers.push(token.number);
      toReach = false;
      condition = null;
      expect = null;
      previous = n;
      i += 1;
      continue;
    }

    const match = phraseAt(i);
    const after = previous;
    previous = null;
    if (match !== undefined) {
      const e = match.entry;
      i += match.words.length;
      if (e.kind === "filler") continue;
      if (e.kind === "post") {
        if (after !== null) {
          if (after.role === null) after.role = e.role;
          continue;
        }
        if (e.prefix === true) expect = e.role;
        // Otherwise it says nothing on its own: "buy shares of TCS", or the
        // "at a time" in "show 10 shares at a time", where the cue already
        // gave the number its role.
        continue;
      }
      if (e.kind === "cue") {
        expect = e.role;
        if (e.limit === true) limit = true;
        if (e.role === "stop") stopWord = true;
        continue;
      }
      settleCue();
      if (e.kind === "side") {
        sides.add(e.side);
        sideJustBefore = true;
      } else if (e.kind === "tif") tifs.add(e.tif);
      else if (e.kind === "cancel") cancel = true;
      else if (e.kind === "market") market = true;
      else if (e.kind === "limit_type") limit = true;
      else if (e.kind === "stop_type") stopType = stopWord = true;
      else if (e.kind === "stop_limit") stopLimit = stopWord = true;
      else if (e.kind === "iceberg") iceberg = true;
      else if (e.kind === "vague") vague = true;
      else if (e.kind === "all") all = true;
      else if (e.kind === "notional") notional = true;
      else if (e.kind === "negative") conflicts.push("quantities and prices cannot be negative");
      else if (e.kind === "modifier") modifiers.push(match.words.join(" ").replace(/ t$/, "'t"));
      continue;
    }

    const instrument = matchInstrument(words.slice(i), aliases);
    if (instrument !== null) {
      settleCue();
      symbols.add(instrument.symbol);
      if (afterSide) sideThenInstrument = true;
      // "10 tcs", "0.05 btc": a number right before the instrument is its quantity.
      if (after !== null && after.role === null) after.role = "quantity";
      // "tata motors" is not Tata Consultancy, nor "hdfc life" HDFC Bank: a
      // short name followed by a word the rules cannot place may be another
      // company. qwen2.5:1.5b proposed TCS for "buy 10 tata motors at 900",
      // and the text check passed it, since "tata" names TCS.
      const j = i + instrument.used;
      const next = words[j];
      const placed = next === undefined || tokens[j]!.number !== undefined || DIRECTIONS.has(next) || phraseAt(j) !== undefined || matchInstrument(words.slice(j), aliases) !== null;
      if (instrument.short && !placed) {
        otherCompanies.push(`${words.slice(i, j).join(" ")} ${next}`);
      }
      i = j;
      continue;
    }

    if (DIRECTIONS.has(token.word)) toReach = true;
    if (CONDITIONS.has(token.word)) condition = token.word;
    unknown.push(token.word);
    // A cue only names the number right after it: in "if price goes above
    // 82000", 82000 is a trigger, not the price the word "price" announced.
    // The text is already not understood, so this only keeps a wrong role
    // out of `named.roles`, which the model's reading is checked against.
    expect = null;
    i += 1;
  }
  settleCue();

  const byRole = (role: Role) => numbers.filter((n) => n.role === role).map((n) => n.value);
  const bare = numbers.filter((n) => n.role === null).map((n) => n.value);
  const quantities = byRole("quantity");
  // The roles the text itself gives, before the guess below makes a lone
  // unmarked number the quantity.
  const statedQuantities = [...quantities];
  if (quantities.length === 0 && bare.length > 0) quantities.push(bare.shift()!);
  const prices = byRole("price");
  const stops = byRole("stop");
  // "a stop order to sell 20 HDFC at 1680": with a stop order named and one
  // price, that price is the trigger.
  if (stopType && stops.length === 0 && prices.length === 1) stops.push(prices.pop()!);
  const displays = byRole("display");
  const roles: Record<Role, string[]> = { quantity: statedQuantities, price: [...prices], stop: [...stops], display: [...displays] };
  // A second number with nothing to say what it is: "buy tcs 10 4100" is
  // probably 10 at 4100, but the rules do not guess. The model may.
  const ambiguous = bare.length > 0;

  // Even the same number twice: "buy 10 tcs and 10 tcs" may be two orders,
  // and counting it as one consistent quantity proposed 10 where 20 was meant.
  for (const [list, what] of [
    [quantities, "quantities"],
    [prices, "prices"],
    [stops, "stop prices"],
    [displays, "display sizes"],
  ] as const) {
    if (list.length > 1) conflicts.push(`more than one of the ${what} (${list.join(", ")})`);
  }
  // A cancel names one side at most: "cancel my buy orders and sell tcs at
  // market" read as one cancel covered both sides of TCS.
  if (sides.size > 1) conflicts.push("it says both buy and sell");
  if (symbols.size > 1) conflicts.push(`it names more than one instrument (${[...symbols].join(", ")})`);
  if (tifs.size > 1) conflicts.push(`it gives more than one time in force (${[...tifs].join(", ")})`);
  if (market && prices.length > 0) conflicts.push("it asks for a market order and gives a limit price");
  else if (market && (limit || stopLimit)) conflicts.push("it asks for both a market order and a limit order");
  if (cancel) {
    // A cancel uses no numbers and no order words. Only a number used to be
    // checked, so "buy tcs at market and cancel my sell orders" came out as
    // a cancel of every TCS order, the buy dropped. And a cancel covers an
    // instrument and a side, nothing narrower: "cancel my stop orders" was
    // proposed as a cancel of every order.
    const orderWords = market || limit || stopWord || stopType || stopLimit || tifs.size > 0 || iceberg || displays.length > 0 || notional;
    if (numbers.length > 0 && sides.size === 0 && symbols.size === 0) conflicts.push("a cancel takes no quantity or price; say which orders to cancel");
    else if (numbers.length > 0 || sideThenInstrument) conflicts.push("it mixes a cancel with a new order");
    else if (orderWords) conflicts.push("a cancel covers an instrument or a side, not an order type or price; say which orders to cancel");
    if (vague) conflicts.push("it cancels only some of them; say which orders to cancel");
  }
  if (iceberg && displays.length === 0) conflicts.push("an iceberg order needs a display size, e.g. \"show 10 at a time\"");
  for (const n of misgroupedNumbers(prepare(text))) conflicts.push(`"${n}" could be read more than one way; write decimals with a point (0.05) and thousands as 4,100 or 1,00,000`);
  if (modifiers.length > 0) conflicts.push(`it says ${modifiers.map((m) => `"${m}"`).join(", ")}, which may change or undo the order; type just the order`);
  if (condition !== null) conflicts.push(`it says "${condition}" but gives no price to wait for`);
  for (const name of otherCompanies) conflicts.push(`"${name}" may be another company; use the listed name or symbol`);

  let orderType: OrderKind | null = null;
  if (stops.length > 0 || stopType) orderType = prices.length > 0 || stopLimit ? "stop_limit" : "stop";
  else if (stopLimit) orderType = "stop_limit";
  else if (market) orderType = "market";
  else if (prices.length > 0 || limit) orderType = "limit";

  const fields: OrderFields = {
    intent: cancel ? "cancel" : "order",
    side: sides.size === 1 ? [...sides][0]! : null,
    symbol: symbols.size === 1 ? [...symbols][0]! : null,
    orderType: cancel ? null : orderType,
    quantity: cancel ? null : (quantities[0] ?? null),
    price: cancel ? null : (prices[0] ?? null),
    stopPrice: cancel ? null : (stops[0] ?? null),
    timeInForce: cancel ? null : tifs.size === 1 ? [...tifs][0]! : null,
    displayQuantity: cancel ? null : (displays[0] ?? null),
    explanation: "",
  };

  const understood = unknown.length === 0 && !dangling && !ambiguous && tokens.length > 0;
  const reasons: string[] = [];
  if (!understood) {
    if (tokens.length === 0) reasons.push("nothing to read");
    if (unknown.length > 0) reasons.push(`unknown words: ${unknown.map((w) => `"${w}"`).join(", ")}`);
    if (dangling) reasons.push("a price or size word with no number after it");
    if (ambiguous) reasons.push("a number with nothing to say whether it is a quantity or a price");
  }
  const blocking = [...conflicts];
  if (!cancel && notional) blocking.unshift("it gives an amount of money; say how many shares or units");
  if (!cancel && (vague || all)) blocking.unshift("the quantity is vague; say how many");
  reasons.push(...blocking);
  if (!cancel && sides.size === 0 && symbols.size === 0 && numbers.length === 0 && understood) reasons.push("no order in it");

  if (reasons.length > 0) {
    fields.intent = "unclear";
    fields.explanation = `Rules: ${reasons.join("; ")}.`;
  } else {
    fields.explanation = cancel ? "Rules: a cancel request." : "Rules: one order, every word recognised.";
  }
  const certain = understood || blocking.length > 0;
  const named = { sides: [...sides], symbols: [...symbols], timesInForce: [...tifs], cancel, market, limit: limit || stopLimit, stop: stopWord, all, roles, triggers };
  return { fields, understood, certain, blocking, conflicts, named };
}
