import type { ClientOrder, Instrument, Side } from "@ome/client";

/** An instrument as the parser sees it: the wire definition plus what the caller knows right now. */
export interface MarketInstrument extends Instrument {
  /** Last traded price in ticks, if known. The reference price stands in otherwise. */
  lastPrice?: number;
  /** Extra names people use for it, e.g. "hdfc" for HDFCBANK. */
  aliases?: readonly string[];
}

export type OrderKind = "limit" | "market" | "stop" | "stop_limit";
export type TimeInForce = "GTC" | "IOC" | "FOK";

/**
 * What a parser (rules or the model) read from the text, before any checks.
 * Numbers are exact decimal strings in display units ("4100.50", "0.05"), so
 * nothing passes through floating point on the way to integer ticks.
 */
export interface OrderFields {
  intent: "order" | "cancel" | "unclear";
  side: Side | null;
  symbol: string | null;
  orderType: OrderKind | null;
  quantity: string | null;
  /** The limit price. */
  price: string | null;
  stopPrice: string | null;
  timeInForce: TimeInForce | null;
  /** Iceberg: how much to show at a time. */
  displayQuantity: string | null;
  /** One short sentence: what was understood, or why it is unclear. */
  explanation: string;
}

export interface Problem {
  field: keyof OrderFields | "text" | "model";
  message: string;
}

export type ParseMode = "rules" | "llm" | "hybrid";

/** Where a result came from, so the UI can say "understood by rules" or "by qwen2.5:1.5b". */
export interface ResultMeta {
  /** What the parser read, before any checks: for the model, its own answer, even where the text overruled it. */
  fields: OrderFields;
  source: "rules" | "llm";
  /** The Ollama model, when source is "llm". */
  model?: string;
  /** Set when the model was asked for but could not be used, and the rules answered instead. */
  fallback?: string;
  /**
   * Why, as a code: `fallback` is for logs (it can name Ollama's URL), so a
   * gateway shows users its own sentence chosen by this. "busy": too many
   * requests were already waiting on the model.
   */
  fallbackReason?: "unreachable" | "timeout" | "http" | "bad_output" | "busy";
  latencyMs: number;
}

/**
 * A proposal, never an instruction. It deliberately carries no clientOrderId
 * or reqId: the caller has to build the gateway message itself, after the user
 * has seen `summary` and confirmed, so nothing typed can ever be sent unseen.
 */
export type Proposal =
  | {
      kind: "order";
      symbol: string;
      /** Exactly the gateway's wire format: integer ticks and units, already checked against tick and lot sizes. */
      order: ClientOrder;
      summary: string;
      /** Assumptions and oddities the user should read before confirming. */
      warnings: string[];
    }
  | {
      kind: "cancel";
      /** null: every symbol. */
      symbol: string | null;
      /** null: both sides. */
      side: Side | null;
      summary: string;
    }
  | { kind: "unclear"; problems: Problem[]; summary: string };

export type ParseResult = (Proposal & ResultMeta) | { kind: "error"; message: string; latencyMs: number };
