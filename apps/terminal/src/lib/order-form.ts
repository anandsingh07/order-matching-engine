import { formatPrice, formatQuantity, toUnits, type ClientOrder, type Instrument, type Side } from "@ome/client";

export type OrderKind = "limit" | "market" | "stop";

export interface OrderForm {
  kind: OrderKind;
  side: Side;
  /** Display units, exactly as typed. */
  price: string;
  stopPrice: string;
  quantity: string;
  timeInForce: "GTC" | "IOC" | "FOK";
  /** Iceberg display quantity, optional; display units. */
  display: string;
}

export type BuildResult = { ok: true; order: ClientOrder } | { ok: false; error: string };

/**
 * Like toUnits, but refuses to drop digits: "2.5" shares must be an error,
 * not silently become 2. Trailing zeros beyond the scale are fine.
 */
function parseExact(text: string, scale: number, label: string): { value: number } | { error: string } {
  const places = Math.round(Math.log10(scale));
  const fraction = /^\s*\d*\.(\d*)\s*$/.exec(text)?.[1] ?? "";
  if (/[1-9]/.test(fraction.slice(places))) {
    return { error: places === 0 ? `${label} must be a whole number` : `${label} can have at most ${places} decimal places` };
  }
  const value = toUnits(text, scale);
  if (value === null || value <= 0) return { error: `${label} must be a positive number` };
  return { value };
}

/**
 * Turns what the user typed into an order the gateway will accept, or a clear
 * message saying what to fix. Typed decimals are converted to integer ticks
 * exactly (no floating point), then checked against tick and lot sizes so the
 * user hears about mistakes before the order is sent.
 */
export function buildOrder(instrument: Instrument, form: OrderForm): BuildResult {
  const tick = formatPrice(instrument, instrument.tickSize);
  const lot = formatQuantity(instrument, instrument.lotSize);

  if (form.quantity.trim() === "") return { ok: false, error: "Enter a quantity" };
  const parsedQuantity = parseExact(form.quantity, instrument.quantityScale, "Quantity");
  if ("error" in parsedQuantity) return { ok: false, error: parsedQuantity.error };
  const quantity = parsedQuantity.value;
  if (quantity % instrument.lotSize !== 0) return { ok: false, error: `Quantity must be a multiple of ${lot}` };

  const price = (label: string, text: string): { value: number } | { error: string } => {
    if (text.trim() === "") return { error: `Enter a ${label}` };
    const parsed = parseExact(text, instrument.priceScale, capitalize(label));
    if ("error" in parsed) return parsed;
    if (parsed.value % instrument.tickSize !== 0) return { error: `${capitalize(label)} must be a multiple of ${tick}` };
    return parsed;
  };

  if (form.kind === "market") {
    return { ok: true, order: { type: "market", side: form.side, quantity } };
  }

  if (form.kind === "limit") {
    const p = price("price", form.price);
    if ("error" in p) return { ok: false, error: p.error };
    const order: ClientOrder = { type: "limit", side: form.side, price: p.value, quantity, timeInForce: form.timeInForce };
    if (form.display.trim() !== "") {
      const parsed = parseExact(form.display, instrument.quantityScale, "Iceberg size");
      const display = "value" in parsed ? parsed.value : 0;
      if (display <= 0 || display % instrument.lotSize !== 0) {
        return { ok: false, error: `Iceberg size must be a positive multiple of ${lot}` };
      }
      if (form.timeInForce !== "GTC") return { ok: false, error: "Iceberg orders must be GTC" };
      if (display < quantity) order.displayQuantity = display;
    }
    return { ok: true, order };
  }

  const stop = price("stop price", form.stopPrice);
  if ("error" in stop) return { ok: false, error: stop.error };
  if (form.price.trim() === "") return { ok: true, order: { type: "stop", side: form.side, quantity, stopPrice: stop.value } };
  const limit = price("limit price", form.price);
  if ("error" in limit) return { ok: false, error: limit.error };
  return {
    ok: true,
    order: { type: "stop", side: form.side, quantity, stopPrice: stop.value, limitPrice: limit.value, timeInForce: form.timeInForce },
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The trading phase that decides which orders are taken right now. */
export interface MarketPhase {
  /** The symbol itself is in an auction (opening, or after a circuit-breaker halt). */
  auction: boolean;
  /** For a future or option: its underlying, when that is in an auction; null otherwise. */
  underlyingInAuction: string | null;
}

/**
 * Why the exchange would refuse this order in the current phase, or null.
 * Re-evaluated as the phase changes, so a refusal shown during an auction
 * goes away by itself when the symbol reopens.
 */
export function phaseRefusal(form: Pick<OrderForm, "kind" | "timeInForce">, phase: MarketPhase): string | null {
  if (phase.auction && (form.kind === "market" || (form.kind === "limit" && form.timeInForce !== "GTC"))) {
    return "During an auction only GTC limit and stop orders are accepted";
  }
  // Nobody can value a contract while its underlying has no price.
  if (phase.underlyingInAuction !== null) {
    return `${phase.underlyingInAuction} is in an auction; its futures and options trade again when it reopens`;
  }
  return null;
}
