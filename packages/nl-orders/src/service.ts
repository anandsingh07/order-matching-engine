import type { Side } from "@ome/client";
import { sanitize } from "./llm.ts";
import { DEFAULT_MODE, MAX_TEXT_LENGTH, parseOrder, type ParseOptions } from "./parse.ts";
import { readNlOrderRequest } from "./request.ts";
import { parseWithRules } from "./rules.ts";
import type { MarketInstrument, ParseResult, Proposal } from "./types.ts";

// The gateway's plain-English endpoint without the web framework: an
// untrusted body in, a status and a JSON body out. The gateway wires it to a
// route (e.g. POST /api/nl-order) and supplies its instruments with live
// prices; nothing here places an order.

export interface HandlerOptions extends ParseOptions {
  /**
   * Requests allowed to wait on the model at once. A laptop CPU answers one
   * at a time, so more would only queue towards the timeout; beyond this the
   * rules answer at once and `fallback` says why. Default 2.
   */
  maxConcurrent?: number;
  /**
   * Include futures and options. Off by default: the evaluation covers
   * stocks and BTC only, and contract names differ by a strike and an
   * expiry, which no parser here was measured on.
   */
  derivatives?: boolean;
}

export interface HandlerResponse {
  status: 200 | 400 | 503;
  body: ParseResult | { error: string };
}

export const BUSY = "the local model is busy with other requests, so the rules answered";

/**
 * One handler per gateway, so the bound on waiting requests is shared.
 * `busy` lets the caller treat the model as taken for this one request (the
 * gateway sets it while the same trader already has a request out), so one
 * caller cannot hold every slot.
 */
export function createNlOrderHandler(options: HandlerOptions = {}) {
  const maxConcurrent = options.maxConcurrent ?? 2;
  let waiting = 0;
  return async (body: unknown, instruments: readonly MarketInstrument[], signal?: AbortSignal, busy = false): Promise<HandlerResponse> => {
    const request = readNlOrderRequest(body);
    if ("error" in request) return { status: 400, body: { error: request.error } };
    const tradable = options.derivatives === true ? instruments : instruments.filter((i) => (i.kind ?? "spot") === "spot");
    const mode = request.mode ?? options.mode ?? DEFAULT_MODE;
    const respond = (r: ParseResult): HandlerResponse => ({ status: r.kind === "error" ? 503 : 200, body: r });

    if (mode !== "rules" && (busy || waiting >= maxConcurrent)) {
      const r = await parseOrder(request.text, tradable, { ...options, mode: "rules" });
      return respond(r.kind === "error" || !wouldAskModel(request.text, tradable, mode) ? r : { ...r, fallback: BUSY, fallbackReason: "busy" });
    }
    waiting++;
    try {
      return respond(await parseOrder(request.text, tradable, { ...options, mode, ...(signal === undefined ? {} : { signal }) }));
    } finally {
      waiting--;
    }
  };
}

/**
 * Whether parseOrder would have asked the model about this text. In hybrid
 * mode, text the rules read with certainty (and text too long or empty to
 * read) never reaches it, so "the model is busy" would be untrue there.
 */
function wouldAskModel(text: string, instruments: readonly MarketInstrument[], mode: "llm" | "hybrid"): boolean {
  if (mode === "llm") return true;
  const clean = sanitize(text);
  return clean !== "" && clean.length <= MAX_TEXT_LENGTH && !parseWithRules(clean, instruments).certain;
}

/** For the terminal: whether a confirmed cancel proposal covers one of the trader's open orders. */
export function cancelCovers(proposal: Extract<Proposal, { kind: "cancel" }>, order: { symbol: string; side: Side }): boolean {
  return (proposal.symbol === null || proposal.symbol === order.symbol) && (proposal.side === null || proposal.side === order.side);
}
