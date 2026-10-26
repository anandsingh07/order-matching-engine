import { formatPrice, formatQuantity, type ClientOrder } from "@ome/client";
import { toExactUnits } from "./numbers.ts";
import type { MarketInstrument, OrderFields, Problem, Proposal } from "./types.ts";

// Whatever read the text, rules or a language model, its answer ends up here:
// one deterministic function that turns display-unit fields into the
// gateway's integer wire format, or says exactly what is missing or wrong. The
// model never decides whether an order is valid.

/** Farther than this from the current price and the proposal carries a warning (the gateway's static band is 10%). */
const FAR_FROM_MARKET = 0.1;

const SIDE_TEXT = { buy: "Buy", sell: "Sell" } as const;
const TIF_TEXT = { GTC: "good till cancelled", IOC: "immediate or cancel", FOK: "fill or kill" } as const;

export function toProposal(fields: OrderFields, instruments: readonly MarketInstrument[]): Proposal {
  if (fields.intent === "unclear") {
    const message = fields.explanation.trim() || "That does not read as a single order.";
    return { kind: "unclear", problems: [{ field: "text", message }], summary: message };
  }

  const problems: Problem[] = [];
  const instrument = fields.symbol === null ? undefined : instruments.find((i) => i.symbol.toUpperCase() === fields.symbol!.toUpperCase());
  if (fields.symbol !== null && instrument === undefined) problems.push({ field: "symbol", message: `there is no instrument called ${fields.symbol}` });

  if (fields.intent === "cancel") {
    if (problems.length > 0) return unclear(problems);
    const what = `${fields.side === null ? "" : `${fields.side} `}orders`;
    const summary = instrument === undefined ? `Cancel all your open ${what}` : `Cancel your open ${instrument.symbol} ${what}`;
    return { kind: "cancel", symbol: instrument?.symbol ?? null, side: fields.side, summary };
  }

  if (fields.side === null) problems.push({ field: "side", message: "say whether to buy or sell" });
  if (fields.symbol === null) problems.push({ field: "symbol", message: "say which instrument" });
  if (fields.quantity === null) problems.push({ field: "quantity", message: "say how many" });
  if (instrument === undefined || problems.length > 0) return unclear(problems);

  const warnings: string[] = [];
  const quantity = units("quantity", fields.quantity!, instrument.quantityScale, instrument.lotSize, formatQuantity(instrument, instrument.lotSize), problems);
  const tickText = formatPrice(instrument, instrument.tickSize);
  const price = fields.price === null ? null : units("price", fields.price, instrument.priceScale, instrument.tickSize, tickText, problems);
  const stopPrice = fields.stopPrice === null ? null : units("stopPrice", fields.stopPrice, instrument.priceScale, instrument.tickSize, tickText, problems);

  let type = fields.orderType;
  if (type === null) {
    // Infer the type from the prices given. No price at all is a market
    // order: the user will see "at market" and confirm it.
    type = stopPrice !== null ? (price !== null ? "stop_limit" : "stop") : price !== null ? "limit" : "market";
    if (type === "market") warnings.push("No price was given, so this is a market order: it fills at whatever the book offers.");
  }
  if (type === "market" && price !== null) problems.push({ field: "price", message: "a market order cannot have a limit price" });
  if (type === "market" && stopPrice !== null) type = "stop";
  if (type === "limit" && fields.price === null) problems.push({ field: "price", message: "a limit order needs a price" });
  if ((type === "stop" || type === "stop_limit") && fields.stopPrice === null) problems.push({ field: "stopPrice", message: "a stop order needs a stop price" });
  if (type === "stop_limit" && fields.price === null) problems.push({ field: "price", message: "a stop-limit order needs a limit price" });
  // A limit order with a trigger, or a stop with a limit price, is a stop-limit.
  if ((type === "limit" && stopPrice !== null) || (type === "stop" && price !== null)) type = "stop_limit";

  let tif = fields.timeInForce;
  if (type === "market" && tif === "GTC") {
    tif = null;
    warnings.push("Market orders never rest on the book, so good-till-cancelled does not apply.");
  }

  let display: number | null = null;
  if (fields.displayQuantity !== null) {
    if (type !== "limit") problems.push({ field: "displayQuantity", message: "only limit orders can be icebergs" });
    else if ((tif ?? "GTC") !== "GTC") problems.push({ field: "displayQuantity", message: "iceberg orders must be good till cancelled, not IOC or FOK" });
    else {
      display = units("displayQuantity", fields.displayQuantity, instrument.quantityScale, instrument.lotSize, formatQuantity(instrument, instrument.lotSize), problems);
      if (display !== null && quantity !== null && display >= quantity) {
        warnings.push("The display size is not smaller than the order, so the whole order shows.");
        display = null;
      }
    }
  }

  const side = fields.side!;
  const market = instrument.lastPrice ?? instrument.referencePrice;
  // A buy stop at or below the market (a sell stop at or above it) fires on
  // the next trade, so it is not a stop at all. Indian brokers refuse these
  // too. The usual cause is a stop loss written with its entry, "buy 100 tcs
  // at 4100 sl 4000": a bracket, which is two orders. Proposing it as one
  // stop-limit was the only wrong proposal the rules made on the holdout set.
  if (stopPrice !== null && market > 0 && (side === "buy" ? stopPrice <= market : stopPrice >= market)) {
    const bracket = price === null ? "" : `; if it is a stop loss for this ${side}, that is a second order, placed once this one fills`;
    problems.push({
      field: "stopPrice",
      message: `a ${side} stop must be ${side === "buy" ? "above" : "below"} the current ${formatPrice(instrument, market)}, or it triggers at once${bracket}`,
    });
  }
  if (problems.length > 0 || quantity === null) return unclear(problems);

  let order: ClientOrder;
  if (type === "market") {
    order = { type: "market", side, quantity };
    if (tif === "IOC" || tif === "FOK") order.timeInForce = tif;
  } else if (type === "limit") {
    order = { type: "limit", side, price: price!, quantity, timeInForce: tif ?? "GTC" };
    if (display !== null) order.displayQuantity = display;
  } else {
    order = { type: "stop", side, quantity, stopPrice: stopPrice! };
    if (type === "stop_limit") {
      order.limitPrice = price!;
      order.timeInForce = tif ?? "GTC";
    } else if (tif !== null) order.timeInForce = tif;
  }

  // Distance from the market only warns: the gateway's price bands are the
  // authority, and the user confirms anyway.
  for (const [label, p] of [
    ["price", price],
    ["stop price", stopPrice],
  ] as const) {
    if (p === null || market <= 0) continue;
    const away = (p - market) / market;
    if (Math.abs(away) > FAR_FROM_MARKET) {
      warnings.push(`The ${label} ${formatPrice(instrument, p)} is ${Math.round(Math.abs(away) * 100)}% ${away > 0 ? "above" : "below"} the current ${formatPrice(instrument, market)}.`);
    }
  }

  return { kind: "order", symbol: instrument.symbol, order, summary: describe(instrument, order), warnings };
}

function unclear(problems: Problem[]): Proposal {
  return { kind: "unclear", problems, summary: `Not enough to make an order: ${problems.map((p) => p.message).join("; ")}.` };
}

/** Exact integer units, checked against the step (tick or lot); records a problem and returns null otherwise. */
function units(field: Problem["field"], decimal: string, scale: number, step: number, stepText: string, problems: Problem[]): number | null {
  const label = field === "stopPrice" ? "stop price" : field === "displayQuantity" ? "display size" : field;
  const parsed = toExactUnits(decimal, scale);
  if ("error" in parsed) {
    problems.push({ field, message: `the ${label} ${decimal} ${parsed.error}` });
    return null;
  }
  if (parsed.value % step !== 0) {
    problems.push({ field, message: `the ${label} ${decimal} must be a multiple of ${stepText}` });
    return null;
  }
  return parsed.value;
}

/** One line a person can check before confirming: "Buy 10 TCS at 4100.00 (limit, good till cancelled)". */
export function describe(instrument: MarketInstrument, order: ClientOrder): string {
  const head = `${SIDE_TEXT[order.side]} ${formatQuantity(instrument, order.quantity)} ${instrument.symbol}`;
  const price = (p: number) => `${formatPrice(instrument, p)} ${instrument.currency}`;
  const tif = order.timeInForce === undefined ? "" : `, ${TIF_TEXT[order.timeInForce]}`;
  if (order.type === "market") return `${head} at market${tif}`;
  if (order.type === "limit") {
    const ice = order.displayQuantity === undefined ? "" : `, showing ${formatQuantity(instrument, order.displayQuantity)} at a time`;
    return `${head} at ${price(order.price)} (limit${tif}${ice})`;
  }
  if (order.limitPrice === undefined) return `${head} at market once the price reaches ${price(order.stopPrice)} (stop${tif})`;
  return `${head} at ${price(order.limitPrice)} once the price reaches ${price(order.stopPrice)} (stop-limit${tif})`;
}
