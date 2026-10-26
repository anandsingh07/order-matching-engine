import { formatPrice, formatQuantity, type Instrument } from "@ome/client";

export { formatPrice, formatQuantity };

/** A price x quantity amount (in ticks x units) as money, e.g. "-1,234.50". */
export function formatMoney(instrument: Instrument, value: number): string {
  return (value / (instrument.priceScale * instrument.quantityScale)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** An amount already in major units (e.g. rupees), with two decimals: "123,456.78". */
export function formatAmount(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const formatTime = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });

/** Percentage change from `reference`, e.g. "+0.42%". */
export function formatChange(last: number, reference: number): string {
  const pct = ((last - reference) / reference) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/** "partially_filled" -> "Partially filled". */
export function humanize(code: string): string {
  const text = code.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
