import { formatPrice } from "./format.ts";
import type { Instrument, InstrumentKind } from "./types.ts";

/** What an instrument is. Instruments without a kind (everything before derivatives) are spot. */
export function instrumentKind(instrument: Pick<Instrument, "kind">): InstrumentKind {
  return instrument.kind ?? "spot";
}

/** Units of the underlying per contract; 1 for spot. */
export function contractMultiplier(instrument: Pick<Instrument, "multiplier">): number {
  return instrument.multiplier ?? 1;
}

/**
 * An option's strike as people write it: "4100", or "1812.5" for a strike
 * between whole units. The series symbols use the same form.
 */
export function formatStrike(instrument: Pick<Instrument, "priceScale" | "strike">): string {
  const text = formatPrice(instrument, instrument.strike ?? 0);
  // Only zeros after the decimal point are dropped: "4100" itself stays whole.
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** A short name for people: "TCS", "TCS future", "TCS 4100 call". */
export function contractName(instrument: Instrument): string {
  const underlying = instrument.underlying ?? instrument.symbol;
  switch (instrumentKind(instrument)) {
    case "spot":
      return instrument.symbol;
    case "future":
      return `${underlying} future`;
    case "option":
      return `${underlying} ${formatStrike(instrument)} ${instrument.right ?? "call"}`;
  }
}
