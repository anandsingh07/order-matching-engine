import { formatStrike, instrumentKind, type Instrument, type OptionRight, type SettlementBasis } from "@ome/client";
import { annualizedVolatility, blackScholes, yearsUntil } from "./pricing.js";

export interface UnderlyingSpec {
  symbol: string;
  /** Shares per contract. */
  multiplier: number;
  /** Distance between strikes, in the underlying's ticks. */
  strikeStep: number;
}

export interface DerivativesOptions {
  /** Stocks with a future and an option chain. */
  underlyings: UnderlyingSpec[];
  /**
   * Length of the expiry cycle. Series expire on multiples of it since the
   * epoch (UTC), so every 30 minutes on the hour and half hour by default.
   * At least a second.
   */
  expiryMs: number;
  /** A new series gets more than this long before it expires; otherwise it takes the expiry after. */
  minLifeMs: number;
  /** Strikes either side of the one nearest the underlying's price: 2 lists five. */
  strikesEachSide: number;
  /** The final settlement price is the underlying's volume-weighted price over this window before expiry. */
  settlementWindowMs: number;
  /** Volatility for option values before the underlying has a forecast: a typical 15-minute move, in percent. */
  defaultSigmaPct: number;
}

export const DEFAULT_DERIVATIVES: DerivativesOptions = {
  underlyings: [
    // About Rs 41,000 and Rs 46,000 of stock per contract, so a Rs 10 lakh paper account can trade a few.
    { symbol: "TCS", multiplier: 10, strikeStep: 5_000 },
    { symbol: "INFY", multiplier: 25, strikeStep: 2_500 },
  ],
  expiryMs: 30 * 60_000,
  minLifeMs: 15 * 60_000,
  strikesEachSide: 2,
  settlementWindowMs: 60_000,
  // The simulated stocks' random walk moves about 1.5% in 15 minutes.
  defaultSigmaPct: 1.5,
};

/** What the derivatives desk needs to know about the rest of the market. */
export interface DerivativesHost {
  now(): number;
  /** A spot symbol's current price in ticks: its last trade, or its reference price. */
  price(symbol: string): number;
  /** A spot symbol's volatility forecast: a typical move of `sigmaPct` percent over `horizonMinutes`; null before there is one. */
  forecast(symbol: string): { sigmaPct: number; horizonMinutes: number } | null;
  /** A spot symbol's price band in force, percent either side of its reference. */
  bandPct(symbol: string): number;
}

/** An option's band never closes below this many ticks wide, so worthless far out-of-the-money options can still be quoted. */
const MIN_BAND_TICKS = 20;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** The first expiry on the cycle that leaves more than `minLifeMs` to trade. */
export function nextExpiry(now: number, cycleMs: number, minLifeMs: number): number {
  return (Math.floor((now + minLifeMs) / cycleMs) + 1) * cycleMs;
}

/**
 * The expiry part of a series symbol, in UTC: "25OCT1030" for 10:30 on
 * 25 October, with seconds added when the cycle is not whole minutes.
 */
export function expiryCode(expiry: number, cycleMs: number): string {
  const d = new Date(expiry);
  const two = (n: number) => String(n).padStart(2, "0");
  const seconds = cycleMs % 60_000 === 0 ? "" : two(d.getUTCSeconds());
  return `${two(d.getUTCDate())}${MONTHS[d.getUTCMonth()]}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${seconds}`;
}

const roundTo = (value: number, step: number) => Math.round(value / step) * step;

/**
 * One expiry's series on an underlying: a future, then a call and a put at
 * each strike around the underlying's price, lowest strike first. Symbols
 * read like "TCS-25OCT1030-F" and "TCS-25OCT1030-4100C".
 */
export function seriesFor(underlying: Instrument, spec: UnderlyingSpec, spot: number, expiry: number, options: DerivativesOptions): Instrument[] {
  const code = expiryCode(expiry, options.expiryMs);
  const when = new Date(expiry).toISOString().slice(11, options.expiryMs % 60_000 === 0 ? 16 : 19);
  const base = {
    currency: underlying.currency,
    priceScale: underlying.priceScale,
    quantityScale: 1,
    tickSize: underlying.tickSize,
    lotSize: 1,
    underlying: underlying.symbol,
    expiry,
    multiplier: spec.multiplier,
  };
  const out: Instrument[] = [
    {
      ...base,
      symbol: `${underlying.symbol}-${code}-F`,
      name: `${underlying.name} future, expires ${when} UTC`,
      kind: "future",
      referencePrice: roundTo(spot, underlying.tickSize),
    },
  ];
  const atTheMoney = roundTo(spot, spec.strikeStep);
  for (let k = -options.strikesEachSide; k <= options.strikesEachSide; k++) {
    const strike = atTheMoney + k * spec.strikeStep;
    if (strike <= 0) continue;
    const display = formatStrike({ priceScale: underlying.priceScale, strike });
    for (const right of ["call", "put"] as const satisfies readonly OptionRight[]) {
      out.push({
        ...base,
        symbol: `${underlying.symbol}-${code}-${display}${right === "call" ? "C" : "P"}`,
        name: `${underlying.name} ${display} ${right}, expires ${when} UTC`,
        kind: "option",
        strike,
        right,
        referencePrice: 0, // priced below, once the instrument exists
      });
    }
  }
  return out;
}

interface Print {
  time: number;
  price: number;
  quantity: number;
}

/**
 * The derivatives desk: which series are live, what they are worth, their
 * price bands, and the price they settle at. It holds no orders or money;
 * the gateway lists and expires the books and settles the accounts.
 *
 * Values come from Black-Scholes at the underlying's current price, with the
 * gateway's volatility forecast for the underlying scaled to the series'
 * remaining life by the square root of time (or a default volatility before
 * there is a forecast). The rate is zero: paper cash earns nothing here.
 */
export class Derivatives {
  readonly options: DerivativesOptions;
  private readonly live = new Map<string, Instrument>();
  /** Last trade of each live derivative. */
  private readonly lastTrade = new Map<string, number>();
  /** Each underlying's recent trades, for settlement, oldest first. */
  private readonly tape = new Map<string, Print[]>();
  /** The newest trade that has left the tape, the fallback when the settlement window is empty. */
  private readonly before = new Map<string, Print>();

  constructor(
    options: Partial<DerivativesOptions>,
    private readonly host: DerivativesHost,
  ) {
    this.options = { ...DEFAULT_DERIVATIVES, ...options };
    if (!(this.options.expiryMs >= 1_000)) throw new Error("the expiry cycle must be at least a second");
  }

  has(symbol: string): boolean {
    return this.live.has(symbol);
  }

  get(symbol: string): Instrument | undefined {
    return this.live.get(symbol);
  }

  /** Every live series, in listing order. */
  all(): Instrument[] {
    return [...this.live.values()];
  }

  /**
   * New series for every underlying that has none live: strikes around its
   * price now, the next expiry with enough life left, and reference prices
   * at fair value. They count as live from here on.
   */
  plan(underlyings: ReadonlyMap<string, Instrument>): Instrument[] {
    const now = this.host.now();
    const listed = new Set([...this.live.values()].map((i) => i.underlying));
    const out: Instrument[] = [];
    for (const spec of this.options.underlyings) {
      const underlying = underlyings.get(spec.symbol);
      if (underlying === undefined || instrumentKind(underlying) !== "spot" || listed.has(spec.symbol)) continue;
      const expiry = nextExpiry(now, this.options.expiryMs, this.options.minLifeMs);
      for (const instrument of seriesFor(underlying, spec, this.host.price(spec.symbol), expiry, this.options)) {
        if (instrument.kind === "option") {
          instrument.referencePrice = Math.max(instrument.tickSize, roundTo(this.fairValue(instrument), instrument.tickSize));
        }
        this.live.set(instrument.symbol, instrument);
        out.push(instrument);
      }
    }
    return out;
  }

  /** Live series whose expiry has come. */
  due(): Instrument[] {
    const now = this.host.now();
    return [...this.live.values()].filter((i) => i.expiry! <= now);
  }

  remove(symbol: string): void {
    this.live.delete(symbol);
    this.lastTrade.delete(symbol);
  }

  /** Every trade on every symbol passes through here. */
  onTrade(symbol: string, price: number, quantity: number, time: number): void {
    if (this.live.has(symbol)) {
      this.lastTrade.set(symbol, price);
      return;
    }
    if (!this.options.underlyings.some((u) => u.symbol === symbol)) return;
    let tape = this.tape.get(symbol);
    if (tape === undefined) this.tape.set(symbol, (tape = []));
    tape.push({ time, price, quantity });
    // Keep the window of the earliest expiry still to settle, however late the
    // expiry check runs.
    const expiries = [...this.live.values()].filter((i) => i.underlying === symbol).map((i) => i.expiry!);
    const cutoff = Math.min(time, ...expiries) - this.options.settlementWindowMs;
    while (tape.length > 0 && tape[0]!.time <= cutoff) this.before.set(symbol, tape.shift()!);
  }

  /**
   * The final settlement price of a series: the underlying's volume-weighted
   * average price over the window before expiry, rounded to the tick. One
   * last-second print barely moves an average over a minute of trading, so
   * this is much harder to push around than the last trade (exchanges settle
   * on averages for the same reason: NSE's closing price is a 30-minute VWAP).
   * With no trade in the window, it is the last trade before expiry, and
   * before any trade at all the underlying's reference price. `basis` says
   * which, so traders are told how their contract was settled.
   */
  settlement(instrument: Instrument): { price: number; basis: SettlementBasis } {
    const underlying = instrument.underlying!;
    const expiry = instrument.expiry!;
    const prints = (this.tape.get(underlying) ?? []).filter((p) => p.time <= expiry);
    const window = prints.filter((p) => p.time > expiry - this.options.settlementWindowMs);
    const tick = instrument.tickSize;
    if (window.length > 0) {
      const volume = window.reduce((sum, p) => sum + p.quantity, 0);
      return { price: roundTo(window.reduce((sum, p) => sum + p.price * p.quantity, 0) / volume, tick), basis: "vwap" };
    }
    const previous = this.before.get(underlying);
    const last = prints.at(-1) ?? (previous !== undefined && previous.time <= expiry ? previous : undefined);
    if (last !== undefined) return { price: roundTo(last.price, tick), basis: "last_trade" };
    return { price: roundTo(this.host.price(underlying), tick), basis: "reference" };
  }

  /** The final settlement price alone; see `settlement`. */
  settlementPrice(instrument: Instrument): number {
    return this.settlement(instrument).price;
  }

  /** Fair value in ticks: the underlying's price for a future, Black-Scholes for an option. */
  fairValue(instrument: Instrument, spot = this.host.price(instrument.underlying!), volatility = this.volatility(instrument)): number {
    if (instrument.kind !== "option") return spot;
    return blackScholes({
      right: instrument.right!,
      spot,
      strike: instrument.strike!,
      time: yearsUntil(instrument.expiry!, this.host.now()),
      volatility,
    });
  }

  /** The annualised volatility an option on this underlying is valued with. */
  volatility(instrument: Instrument): number {
    const f = this.host.forecast(instrument.underlying!);
    return f === null ? annualizedVolatility(this.options.defaultSigmaPct, 15) : annualizedVolatility(f.sigmaPct, f.horizonMinutes);
  }

  /**
   * The price positions are marked at. A future is marked at its own last
   * trade, and at its fair value (the underlying's price) until it has one.
   * An option is marked at its model value: option books are thin, and one
   * trade far from value would otherwise move an account's equity, and its
   * margin calls, for as long as nobody traded again.
   */
  mark(symbol: string): number | undefined {
    const instrument = this.live.get(symbol);
    if (instrument === undefined) return undefined;
    if (instrument.kind === "future") return this.lastTrade.get(symbol) ?? this.fairValue(instrument);
    return this.fairValue(instrument);
  }

  /**
   * A live series' price band, in ticks. A future's is its underlying's band
   * around the underlying's price. An option's is every value it could have
   * with the underlying anywhere in its own band and volatility anywhere from
   * half to double the forecast: from the lowest (underlying at the far edge,
   * half the volatility) to the highest (near edge, double). That allows any
   * honest quote and refuses the fat-fingered ones.
   */
  band(symbol: string): { low: number; high: number } | null {
    const instrument = this.live.get(symbol);
    if (instrument === undefined) return null;
    const underlying = instrument.underlying!;
    const spot = this.host.price(underlying);
    const pct = this.host.bandPct(underlying) / 100;
    const down = spot * (1 - pct);
    const up = spot * (1 + pct);
    const tick = instrument.tickSize;
    if (instrument.kind === "future") return { low: Math.ceil(down / tick) * tick, high: Math.floor(up / tick) * tick };
    const vol = this.volatility(instrument);
    const call = instrument.right === "call";
    const low = this.fairValue(instrument, call ? down : up, vol / 2);
    const high = this.fairValue(instrument, call ? up : down, vol * 2);
    return { low: Math.max(0, Math.floor(low / tick) * tick), high: Math.max(MIN_BAND_TICKS * tick, Math.ceil(high / tick) * tick) };
  }
}
