import { contractMultiplier, contractName, instrumentKind, type Instrument } from "@ome/client";

/** Futures and options: instruments written on another symbol. */
export const isDerivative = (instrument: Pick<Instrument, "kind">) => instrumentKind(instrument) !== "spot";

/** The symbol a derivative is written on, or the symbol itself for spot. */
export const underlyingOf = (instrument: Pick<Instrument, "symbol" | "underlying">) => instrument.underlying ?? instrument.symbol;

/** Every live future and option on `underlying`, in the gateway's listing order. */
export function derivativesOn(instruments: Instrument[], underlying: string): Instrument[] {
  return instruments.filter((i) => isDerivative(i) && i.underlying === underlying);
}

/** The most channels the gateway accepts in one subscribe message. */
export const MAX_CHANNELS_PER_MESSAGE = 50;

/** Splits a list into pieces of at most `size`, for messages with a limit. */
export function chunks<T>(items: T[], size = MAX_CHANNELS_PER_MESSAGE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The book and candle channels the terminal needs for the selected symbol:
 * its own book and candles, plus the book of every future and option on the
 * same underlying, which the option chain reads its quotes from. Kept as one
 * set so switching between a stock and its options never unsubscribes a
 * book the chain still shows.
 */
export function marketChannels(instruments: Instrument[], symbol: string, interval: string): string[] {
  const selected = instruments.find((i) => i.symbol === symbol);
  const chain = selected === undefined ? [] : derivativesOn(instruments, underlyingOf(selected));
  return [...new Set([`book:${symbol}`, `candles:${symbol}:${interval}`, ...chain.map((i) => `book:${i.symbol}`)])];
}

/** Time left as "12:05" or "1:02:03"; "expired" once it is gone. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "expired";
  const total = Math.ceil(ms / 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** "TCS 4100 call · 10 shares a contract": a derivative's terms in one line; null for spot. */
export function contractTerms(instrument: Instrument): string | null {
  if (!isDerivative(instrument)) return null;
  const units = contractMultiplier(instrument);
  return `${contractName(instrument)} · ${units} share${units === 1 ? "" : "s"} a contract`;
}

/**
 * What an order for `quantity` at `price` (ticks) is worth, in ticks x units:
 * the share value for spot, the notional for a future, the premium for an
 * option. Derivatives are priced per share, so a contract is worth price x
 * multiplier.
 */
export const orderValue = (instrument: Instrument, price: number, quantity: number) => price * quantity * contractMultiplier(instrument);
