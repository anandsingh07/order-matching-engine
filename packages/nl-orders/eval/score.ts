import { toUnits, type ClientOrder, type Side } from "@ome/client";
import type { MarketInstrument, OrderFields, OrderKind, ParseResult, TimeInForce } from "../src/index.ts";

// Scoring a parser against the labelled phrasings in test/fixtures. Labels
// are display units, converted here with @ome/client's toUnits, so the
// expected wire orders do not depend on the code being measured.

export interface Expect {
  kind: "order" | "cancel" | "unclear";
  symbol?: string | null;
  side?: Side | null;
  type?: OrderKind;
  quantity?: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: TimeInForce;
  display?: string;
}

export interface Case {
  text: string;
  expect: Expect;
  why?: string;
  tags?: string[];
}

export interface FixtureSet {
  description: string;
  conventions: string[];
  cases: Case[];
}

export const FIELDS = ["side", "symbol", "type", "quantity", "price", "stopPrice", "timeInForce", "display"] as const;
export type Field = (typeof FIELDS)[number];

/** Limit and stop-limit orders rest until cancelled unless told otherwise; market orders never rest. */
const defaultTif = (type: OrderKind | null, tif: TimeInForce | null | undefined): TimeInForce | null =>
  type === "limit" || type === "stop_limit" ? (tif ?? "GTC") : tif === "GTC" ? null : (tif ?? null);

export function expectedOrder(e: Expect, instrument: MarketInstrument): ClientOrder {
  const q = (s: string) => toUnits(s, instrument.quantityScale)!;
  const p = (s: string) => toUnits(s, instrument.priceScale)!;
  const side = e.side!;
  const quantity = q(e.quantity!);
  const tif = defaultTif(e.type!, e.timeInForce);
  switch (e.type) {
    case "market":
      return tif === null ? { type: "market", side, quantity } : { type: "market", side, quantity, timeInForce: tif as "IOC" | "FOK" };
    case "limit": {
      const order: ClientOrder = { type: "limit", side, price: p(e.price!), quantity, timeInForce: tif! };
      if (e.display !== undefined) order.displayQuantity = q(e.display);
      return order;
    }
    case "stop":
      return tif === null ? { type: "stop", side, quantity, stopPrice: p(e.stopPrice!) } : { type: "stop", side, quantity, stopPrice: p(e.stopPrice!), timeInForce: tif };
    case "stop_limit":
      return { type: "stop", side, quantity, stopPrice: p(e.stopPrice!), limitPrice: p(e.price!), timeInForce: tif! };
    default:
      throw new Error(`label without an order type: ${JSON.stringify(e)}`);
  }
}

/** The order type the fields imply, inferred from the prices when the parser left it out (as validation does). */
function impliedType(f: OrderFields): OrderKind {
  if (f.orderType !== null) return f.orderType;
  if (f.stopPrice !== null) return f.price !== null ? "stop_limit" : "stop";
  return f.price !== null ? "limit" : "market";
}

/** Field-level comparison on what the parser extracted, before validation: a parser can get the price right and still fail validation elsewhere. */
function fieldMatches(e: Expect, f: OrderFields, instrument: MarketInstrument | undefined): Record<Field, boolean> {
  const units = (s: string | null | undefined, scale: number | undefined) => (s === null || s === undefined || scale === undefined ? null : toUnits(s, scale));
  const sameUnits = (got: string | null, want: string | undefined, scale: number | undefined) => {
    if (want === undefined) return got === null;
    return got !== null && /^\d+(\.\d+)?$/.test(got) && units(got, scale) === units(want, scale) && units(got, scale) !== null;
  };
  const type = impliedType(f);
  return {
    side: f.side === e.side,
    symbol: f.symbol === e.symbol,
    type: type === e.type,
    quantity: sameUnits(f.quantity, e.quantity, instrument?.quantityScale),
    price: sameUnits(f.price, e.price, instrument?.priceScale),
    stopPrice: sameUnits(f.stopPrice, e.stopPrice, instrument?.priceScale),
    timeInForce: defaultTif(type, f.timeInForce) === defaultTif(e.type ?? null, e.timeInForce),
    display: sameUnits(f.displayQuantity, e.display, instrument?.quantityScale),
  };
}

export interface CaseScore {
  text: string;
  expected: Expect["kind"];
  got: ParseResult["kind"];
  /** The whole proposal is what the label says (for "unclear": that it was unclear). */
  exact: boolean;
  /** A confident proposal that differs from the label: the user has to catch it at confirmation. */
  wrongProposal: boolean;
  /** For order labels: which extracted fields were right. */
  fields: Record<Field, boolean> | null;
  source: string;
  latencyMs: number;
  detail: string;
}

export function scoreCase(c: Case, r: ParseResult, instruments: readonly MarketInstrument[]): CaseScore {
  const e = c.expect;
  const instrument = instruments.find((i) => i.symbol === e.symbol);
  let exact = false;
  if (r.kind === e.kind) {
    if (r.kind === "unclear") exact = true;
    else if (r.kind === "cancel") exact = r.symbol === (e.symbol ?? null) && r.side === (e.side ?? null);
    else if (r.kind === "order") exact = r.symbol === e.symbol && JSON.stringify(sortKeys(r.order)) === JSON.stringify(sortKeys(expectedOrder(e, instrument!)));
  }
  const proposal = r.kind === "order" || r.kind === "cancel";
  const fields = e.kind === "order" && r.kind !== "error" ? fieldMatches(e, r.fields, instrument) : e.kind === "order" ? Object.fromEntries(FIELDS.map((f) => [f, false])) as Record<Field, boolean> : null;
  const detail =
    r.kind === "error" ? `error: ${r.message}` : r.kind === "order" ? `${r.summary}` : r.kind === "cancel" ? r.summary : `unclear: ${r.summary}`;
  return {
    text: c.text,
    expected: e.kind,
    got: r.kind,
    exact,
    wrongProposal: proposal && !exact,
    fields,
    source: r.kind === "error" ? "error" : r.source + (r.fallback === undefined ? "" : " (fallback)"),
    latencyMs: r.latencyMs,
    detail,
  };
}

function sortKeys(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

export interface Summary {
  cases: number;
  /** Every case: the full proposal right, or correctly unclear. */
  exact: number;
  /** Order labels only: the full ClientOrder and symbol right. */
  orderExact: number;
  cancelExact: number;
  /** Unclear labels answered unclear. */
  unclearRecall: number;
  /** Order and cancel labels answered unclear or error. */
  falseUnclear: number;
  /** Proposals (orders or cancels) that differ from the label, as a share of all cases. */
  wrongProposals: number;
  wrongProposalCount: number;
  fieldAccuracy: Record<Field, number>;
  latency: { p50: number; p95: number; max: number };
  /**
   * The requests the model answered, on their own. In hybrid mode most
   * answers are the rules' and take no time, so the overall p95 is really a
   * lower percentile of the model's latency, and depends on how many
   * phrasings in a set the rules can read. A user whose text reaches the
   * model waits this long.
   */
  modelLatency: { count: number; p50: number; p95: number; max: number };
  counts: { order: number; cancel: number; unclear: number };
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest rank: the smallest value with at least q of the data at or below it.
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export function summarize(scores: readonly CaseScore[]): Summary {
  const share = (list: readonly CaseScore[], ok: (s: CaseScore) => boolean) => (list.length === 0 ? 0 : list.filter(ok).length / list.length);
  const orders = scores.filter((s) => s.expected === "order");
  const cancels = scores.filter((s) => s.expected === "cancel");
  const unclear = scores.filter((s) => s.expected === "unclear");
  const latencies = scores.map((s) => s.latencyMs);
  const modelLatencies = scores.filter((s) => s.source === "llm").map((s) => s.latencyMs);
  return {
    cases: scores.length,
    exact: share(scores, (s) => s.exact),
    orderExact: share(orders, (s) => s.exact),
    cancelExact: share(cancels, (s) => s.exact),
    unclearRecall: share(unclear, (s) => s.got === "unclear"),
    falseUnclear: share([...orders, ...cancels], (s) => s.got === "unclear" || s.got === "error"),
    wrongProposals: share(scores, (s) => s.wrongProposal),
    wrongProposalCount: scores.filter((s) => s.wrongProposal).length,
    fieldAccuracy: Object.fromEntries(FIELDS.map((f) => [f, share(orders, (s) => s.fields?.[f] === true)])) as Record<Field, number>,
    latency: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), max: Math.max(0, ...latencies) },
    modelLatency: { count: modelLatencies.length, p50: quantile(modelLatencies, 0.5), p95: quantile(modelLatencies, 0.95), max: Math.max(0, ...modelLatencies) },
    counts: { order: orders.length, cancel: cancels.length, unclear: unclear.length },
  };
}
