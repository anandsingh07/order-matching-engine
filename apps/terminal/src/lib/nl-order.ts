import { formatPrice, formatQuantity, type ClientOrder, type Instrument, type ParseOrderReply, type Proposal } from "@ome/client";
import { cancelCovers, toTicket, type TicketForm } from "./nl-orders";
import { buildOrder, type OrderForm } from "./order-form";
import { isActive, type MyOrder } from "./orders";

// The "Type an order" box's logic, kept out of the component so it can be
// unit-tested. The box never sends anything: a confirmed proposal prefills
// the order ticket, and the user presses the ticket's own Buy or Sell.

export interface TicketPlan {
  /** What the ticket is filled in with. */
  form: OrderForm;
  /** What the ticket will send from that form, built by its own buildOrder. */
  sent: ClientOrder;
  /** Where that differs from what was read, in words for the user. */
  differences: string[];
}

/** Fill-or-kill on market orders: the ticket has no time in force for them. */
export const FOK_DROPPED =
  "The ticket has no fill-or-kill for market orders: this is sent as a plain market order, and any part that cannot fill at once is cancelled (it can fill partly).";

/** A stop with no limit price: the ticket sends it with no time in force. */
export const STOP_TIF_DROPPED =
  "The ticket sends no time in force on a stop order: once triggered it trades as a market order (it can fill partly).";

const tif = (o: ClientOrder) => o.timeInForce ?? (o.type === "market" ? "IOC" : "GTC");

/**
 * What prefilling the ticket would really send, and how that differs from the
 * proposal. The preview shows `sent`, not the proposal, so the user confirms
 * exactly what the ticket will send.
 */
export function ticketPlan(instrument: Instrument, proposed: ClientOrder): TicketPlan | { error: string } {
  const form = toTicket(instrument, proposed);
  const built = buildOrder(instrument, form);
  if (!built.ok) return { error: `The ticket cannot take this order: ${built.error}.` };
  const sent = built.order;
  const differences: string[] = [];
  // A market order with no time in force is immediate-or-cancel in the engine, so only FOK is lost.
  // A plain stop is sent with none either, and trades as a market order once triggered.
  if (tif(proposed) !== tif(sent)) {
    const plainStop = sent.type === "stop" && sent.limitPrice === undefined;
    differences.push(
      proposed.type === "market" && tif(proposed) === "FOK" ? FOK_DROPPED : plainStop ? STOP_TIF_DROPPED : `The ticket sends this as ${tif(sent)}, not ${tif(proposed)}.`,
    );
  }
  // Everything else must come through unchanged (JSON drops the undefined time in force).
  const same = JSON.stringify(sortKeys({ ...proposed, timeInForce: undefined })) === JSON.stringify(sortKeys({ ...sent, timeInForce: undefined }));
  if (!same) differences.push("The ticket would send something different from what was read: check every field.");
  return { form, sent, differences };
}

const sortKeys = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const TIF_NAMES = { GTC: "Good till cancelled", IOC: "Immediate or cancel", FOK: "Fill or kill" } as const;

/** The preview's rows: what the ticket will send, formatted as the ticket shows it. */
export function sentRows(instrument: Instrument, order: ClientOrder): { term: string; value: string }[] {
  const price = (ticks: number) => `${formatPrice(instrument, ticks)} ${instrument.currency}`;
  const rows = [
    { term: "Side", value: order.side === "buy" ? "Buy" : "Sell" },
    { term: "Instrument", value: instrument.symbol },
    { term: "Type", value: order.type === "stop" ? (order.limitPrice === undefined ? "Stop (market once triggered)" : "Stop limit") : order.type === "limit" ? "Limit" : "Market" },
    { term: "Quantity", value: formatQuantity(instrument, order.quantity) },
  ];
  if (order.type === "stop") rows.push({ term: "Stop price", value: price(order.stopPrice) });
  if (order.type === "limit") rows.push({ term: "Price", value: price(order.price) });
  if (order.type === "stop" && order.limitPrice !== undefined) rows.push({ term: "Limit price", value: price(order.limitPrice) });
  if (order.type !== "market" && order.timeInForce !== undefined) rows.push({ term: "Time in force", value: TIF_NAMES[order.timeInForce] });
  if (order.type === "limit" && order.displayQuantity !== undefined) rows.push({ term: "Iceberg (show)", value: formatQuantity(instrument, order.displayQuantity) });
  return rows;
}

/** The trader's working orders a confirmed cancel would cancel. */
export function coveredOrders(proposal: Extract<Proposal, { kind: "cancel" }>, orders: Iterable<MyOrder>): MyOrder[] {
  return [...orders].filter((o) => isActive(o) && cancelCovers(proposal, o));
}

/** The box gives up on a request after this long: the gateway's model timeout (10 s) plus a margin. */
export const UI_TIMEOUT_MS = 20_000;

/** Why the gateway never read the text, for the user. */
export function failureText(reply: Extract<ParseOrderReply, { kind: "failed" }>): string {
  switch (reply.status) {
    case null:
      return "Cannot reach the gateway.";
    case 401:
      return "Your session has ended: reconnect.";
    case 404:
      return "This gateway does not read plain-English orders.";
    case 408:
      return `The gateway did not answer in ${UI_TIMEOUT_MS / 1000} s.`;
    case 413:
      return "That is too long for one order.";
    case 429:
      return `Too many requests: try again in ${Math.max(1, Math.ceil((reply.retryAfterMs ?? 1000) / 1000))} s.`;
    default:
      return `The gateway could not read that (${reply.message}).`;
  }
}

/** "Read by the built-in rules · 1 ms" / "Read by qwen2.5:1.5b on this computer, checked against your words · 1.2 s". */
export function sourceLine(reply: { source: "rules" | "llm"; model?: string; latencyMs: number }): string {
  const ms = reply.latencyMs;
  const took = ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
  return reply.source === "llm"
    ? `Read by ${reply.model ?? "the local model"} on this computer, checked against your words · ${took}`
    : `Read by the built-in rules · ${took}`;
}

/**
 * The box's request state. Every request has an id, and a reply only counts
 * if it is for the current one: a newer Read, or Stop, makes older replies
 * stale even if they arrive later.
 */
export type BoxState =
  | { phase: "idle" }
  | { phase: "reading"; id: number; startedAt: number; text: string }
  | { phase: "result"; id: number; text: string; reply: ParseOrderReply };

export type BoxEvent =
  | { type: "start"; id: number; text: string; at: number }
  | { type: "replied"; id: number; reply: ParseOrderReply }
  | { type: "stopped" }
  | { type: "cleared" };

export function reduce(state: BoxState, event: BoxEvent): BoxState {
  switch (event.type) {
    case "start":
      return { phase: "reading", id: event.id, startedAt: event.at, text: event.text };
    case "replied":
      return state.phase === "reading" && state.id === event.id ? { phase: "result", id: event.id, text: state.text, reply: event.reply } : state;
    case "stopped":
      return state.phase === "reading" ? { phase: "idle" } : state;
    case "cleared":
      return { phase: "idle" };
  }
}

// The ticket's form and nl-orders' TicketForm must stay one type: prefilling copies one into the other.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const formsMatch: Same<OrderForm, TicketForm> = true;
