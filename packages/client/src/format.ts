import type { Instrument } from "./types.ts";

/** Number of decimal places a scale such as 100 or 100_000 represents. */
const decimals = (scale: number) => Math.round(Math.log10(scale));

/** Integer ticks to a display string, e.g. 290050 with scale 100 -> "2900.50". */
export function formatPrice(instrument: Pick<Instrument, "priceScale">, price: number): string {
  return (price / instrument.priceScale).toFixed(decimals(instrument.priceScale));
}

export function formatQuantity(instrument: Pick<Instrument, "quantityScale">, quantity: number): string {
  const d = decimals(instrument.quantityScale);
  return d === 0 ? String(quantity) : (quantity / instrument.quantityScale).toFixed(d);
}

/**
 * Exact decimal string to integer units, without floating-point rounding:
 * toUnits("80605.82", 100) === 8060582. Extra decimals beyond the scale are
 * truncated. Returns null for anything that is not a plain decimal.
 */
export function toUnits(text: string, scale: number): number | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (match === null) return null;
  const d = decimals(scale);
  const fraction = (match[2] ?? "").padEnd(d, "0").slice(0, d);
  const value = Number(match[1]! + fraction);
  return Number.isSafeInteger(value) ? value : null;
}
