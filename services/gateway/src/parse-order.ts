import type {
  ClientOrder,
  Instrument,
  ModelFallback,
  ParseMode,
  ParseOrderStatus,
  ParseResult as WireParseResult,
} from "@ome/client";
import type { FastifyInstance } from "fastify";
import { TokenBucket } from "./rate-limit.js";
// @ome/nl-orders is not a declared dependency of this package yet: adding one
// needs a lockfile update (`pnpm install`). Until then it is imported by path,
// as pricing.ts does; afterwards this becomes `from "@ome/nl-orders"`.
import {
  createNlOrderHandler,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_URL,
  MAX_TEXT_LENGTH,
  warmUp,
  type HandlerResponse,
  type MarketInstrument,
  type ParseResult,
} from "../../../packages/nl-orders/src/index.ts";

// POST /api/parse-order: plain-English orders ("buy 10 tcs at 4100") read into
// a proposal for the trader to confirm. This route only proposes: it never
// sends an order, touches an account or mints a client order id. The
// terminal prefills its ticket from the answer, and the order goes through
// the normal WebSocket path (and all its checks) only when the user presses
// Buy or Sell there.
//
// The rules read most phrasings at once; a local model (Ollama) reads the
// rest. When the model is not running, slow or busy, the rules answer and
// `fallback` says why in a sentence for the user.

/**
 * What the parser answers with: @ome/nl-orders' handler, or a stand-in in tests.
 * `busy` asks it to treat the model as taken for this request (the rules answer).
 */
export type ParseHandler = (body: unknown, instruments: readonly MarketInstrument[], signal?: AbortSignal, busy?: boolean) => Promise<HandlerResponse>;

export interface ParseOrderOptions {
  /**
   * Default "hybrid": the rules first, the model for what they cannot read.
   * "rules" never contacts Ollama, whatever a request asks for. A request can
   * only ask for less than this: in hybrid, its "llm" (skip the rules) is ignored.
   */
  mode: ParseMode;
  /** Default qwen2.5:1.5b, the evaluation's pick. */
  model: string;
  /** Default http://127.0.0.1:11434. */
  ollamaUrl: string;
  /**
   * How long one request waits on the model before the rules answer instead.
   * Default 10 s: a person is waiting, and the warm-up absorbs the cold load.
   */
  timeoutMs: number;
  /**
   * Requests allowed to wait on the model at once, across all traders; beyond
   * that the rules answer. Default 2. Each trader also has at most one request
   * out at a time that may reach the model: a second one is read by the rules.
   * This bound, like the rate limit, is per process: a gateway run as several
   * workers has one per worker.
   */
  maxConcurrent: number;
  /** Per trader. Default bursts of 10, 1/s sustained: the rules cost well under a millisecond, so this bounds the work one tab can ask for. */
  rateLimit: { burst: number; perSecond: number };
  /** Load the model when the route is registered, so the first trader does not wait out a cold start. Default true. */
  warmUp: boolean;
  /** Nicknames only the model would know, by symbol, e.g. { RELIANCE: ["ril"] }. */
  aliases: Record<string, readonly string[]>;
  fetch?: typeof fetch;
  /** Replaces the parser (tests). */
  handler?: ParseHandler;
}

/** What the gateway supplies. Prices always come from here, never from the request, so a client cannot steer the price checks. */
export interface ParseOrderHost {
  /** The trader id a session token belongs to, or undefined. */
  traderFor(token: string): string | undefined;
  /** What trades now. Only spot instruments are offered to the parser. */
  instruments(): Iterable<Instrument>;
  /** The live price in ticks (last trade, or the reference before any), or undefined if unknown. */
  lastPrice(symbol: string): number | undefined;
  /**
   * Authoritative pre-trade hints for a proposed order: price band, auction,
   * buying power. Shown with the proposal; they never block it (the gateway
   * checks again when the order is really sent).
   */
  warnings?(traderId: string, symbol: string, order: ClientOrder): string[] | Promise<string[]>;
  now?(): number;
}

export interface PlainEnglishOrders {
  status(): ParseOrderStatus;
  /** Resolves when the start-up warm-up has (time taken in ms, or null without a model). */
  readonly warmedUp: Promise<number | null>;
  /** Aborts the warm-up and every model call in flight, so nothing keeps the process alive. */
  close(): void;
}

export const DEFAULT_PARSE_ORDER: ParseOrderOptions = {
  mode: "hybrid",
  model: DEFAULT_MODEL,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  timeoutMs: 10_000,
  maxConcurrent: 2,
  rateLimit: { burst: 10, perSecond: 1 },
  warmUp: true,
  aliases: { RELIANCE: ["ril"] },
};

/** The parser's 300-character cap is at most ~2 KB of JSON even escaped; anything bigger is refused before parsing. */
const BODY_LIMIT = 8 * 1024;
/**
 * Beyond the model's own timeout, a request is cut off after this much more,
 * whatever the parser is doing: its signal is aborted and, if it still does
 * not answer, the route answers 503 without it.
 */
const GRACE_MS = 2_000;
const CANCELLED: HandlerResponse = { status: 503, body: { kind: "error", message: "the request was cancelled", latencyMs: 0 } };

/**
 * The sentence users see when the model could not be used. nl-orders' own
 * message is for logs: it can name Ollama's internal URL.
 */
export function fallbackText(reason: ModelFallback, options: Pick<ParseOrderOptions, "model" | "timeoutMs">): string {
  switch (reason) {
    case "unreachable":
      return "The local model is not running (start Ollama), so only the built-in rules read this.";
    case "http":
      return `The local model could not answer (is ${options.model} installed? ollama pull ${options.model}), so only the built-in rules read this.`;
    case "timeout":
      return `The local model took longer than ${options.timeoutMs / 1000} s, so only the built-in rules read this.`;
    case "bad_output":
      return "The local model's answer could not be used, so only the built-in rules read this.";
    case "busy":
      return "The local model is busy with other requests, so only the built-in rules read this.";
  }
}

/** The session token: "authorization: Bearer <token>", or ?token= as GET /api/account takes it. */
function tokenOf(headers: Record<string, unknown>, query: unknown): string {
  const header = typeof headers.authorization === "string" ? /^Bearer (.+)$/.exec(headers.authorization)?.[1] : undefined;
  if (header !== undefined) return header;
  const token = (query as { token?: unknown } | undefined)?.token;
  return typeof token === "string" ? token : "";
}

/**
 * Registers GET and POST /api/parse-order on `app` (call before it listens).
 *
 *   POST /api/parse-order  authorization: Bearer <session token>  {"text": "...", "mode"?: "rules"}
 *   200 a proposal (kind order | cancel | unclear)   400 bad body   401 unknown token
 *   413 over 8 KiB   429 rate limited (+ Retry-After)   503 {kind: "error"} cancelled or timed out
 *   GET /api/parse-order   the status: mode, model, and whether the model is answering.
 */
export function registerParseOrder(app: FastifyInstance, host: ParseOrderHost, options: Partial<ParseOrderOptions> = {}): PlainEnglishOrders {
  const o: ParseOrderOptions = { ...DEFAULT_PARSE_ORDER, ...options };
  const now = host.now ?? Date.now;
  const ollama = { model: o.model, url: o.ollamaUrl, timeoutMs: o.timeoutMs, ...(o.fetch === undefined ? {} : { fetch: o.fetch }) };
  // One handler for the whole gateway, so the bound on requests waiting for the model is shared by every trader.
  const handle: ParseHandler = o.handler ?? createNlOrderHandler({ ...ollama, mode: o.mode, maxConcurrent: o.maxConcurrent });
  const buckets = new Map<string, TokenBucket>();
  const inFlight = new Set<AbortController>();
  /** Traders with a request out that may reach the model. */
  const modelHolders = new Set<string>();
  let state: ParseOrderStatus["state"] = o.mode === "rules" ? "rules_only" : o.warmUp ? "warming" : "ready";

  const spot = (): MarketInstrument[] => {
    const out: MarketInstrument[] = [];
    for (const i of host.instruments()) {
      if ((i.kind ?? "spot") !== "spot") continue;
      const lastPrice = host.lastPrice(i.symbol);
      const aliases = o.aliases[i.symbol];
      out.push({ ...i, ...(lastPrice === undefined ? {} : { lastPrice }), ...(aliases === undefined ? {} : { aliases }) });
    }
    return out;
  };

  const warmController = new AbortController();
  const warmedUp: Promise<number | null> =
    o.mode === "rules" || !o.warmUp || o.handler !== undefined
      ? Promise.resolve(null)
      : warmUp(spot(), { ...ollama, signal: warmController.signal }).then((ms) => {
          if (state === "warming") state = ms === null ? "offline" : "ready";
          return ms;
        });

  /** Keeps `state` in line with what the model last did. */
  const observe = (result: ParseResult) => {
    if (o.mode === "rules" || result.kind === "error") return;
    if (result.source === "llm") state = "ready";
    else if (result.fallbackReason === "unreachable" || result.fallbackReason === "http") state = "offline";
    else if (result.fallbackReason === "timeout") state = "slow";
  };

  app.get("/api/parse-order", async () => status());

  app.post("/api/parse-order", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const traderId = host.traderFor(tokenOf(request.headers, request.query));
    if (traderId === undefined) return reply.code(401).send({ error: "unknown session token" });

    let bucket = buckets.get(traderId);
    if (bucket === undefined) {
      bucket = new TokenBucket(o.rateLimit.burst, o.rateLimit.perSecond, now);
      buckets.set(traderId, bucket);
    }
    if (!bucket.take()) {
      const retryAfterMs = Math.ceil(1000 / o.rateLimit.perSecond);
      return reply
        .code(429)
        .header("retry-after", String(Math.ceil(retryAfterMs / 1000)))
        .send({ error: "rate_limited", retryAfterMs });
    }

    // A client can only ask for less than the server allows: in rules mode, never
    // the model; in hybrid, not the model alone (which would skip the rules).
    const asked = typeof request.body === "object" && request.body !== null ? (request.body as { mode?: unknown }).mode : undefined;
    const body =
      typeof request.body !== "object" || request.body === null
        ? request.body
        : o.mode === "rules"
          ? { ...request.body, mode: "rules" }
          : asked === "llm" && o.mode === "hybrid"
            ? { ...request.body, mode: "hybrid" }
            : request.body;
    // One request per trader may reach the model at a time, so one trader cannot hold every slot.
    const busy = modelHolders.has(traderId);
    const holds = !busy && o.mode !== "rules" && asked !== "rules";
    if (holds) modelHolders.add(traderId);

    const controller = new AbortController();
    inFlight.add(controller);
    // The browser gave up (Stop, or a newer request): stop waiting on the model too.
    // request.raw's "close" fires on every request in Fastify 5, so it is the reply's
    // close, before the answer is written, that means the client went away.
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    const timer = setTimeout(() => controller.abort(), o.timeoutMs + GRACE_MS);
    let response: HandlerResponse;
    try {
      const parsing = handle(body, spot(), controller.signal, busy);
      // If the cut-off wins, a later failure of the abandoned parse must not go unhandled.
      parsing.catch(() => {});
      const cutOff = new Promise<HandlerResponse>((resolve) => {
        if (controller.signal.aborted) resolve(CANCELLED);
        controller.signal.addEventListener("abort", () => resolve(CANCELLED), { once: true });
      });
      response = await Promise.race([parsing, cutOff]);
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
      if (holds) modelHolders.delete(traderId);
    }
    if (!("kind" in response.body)) return reply.code(response.status).send(response.body);

    const result = response.body;
    observe(result);
    let wire: WireParseResult = { ...result, latencyMs: Math.round(result.latencyMs * 10) / 10 };
    if (wire.kind !== "error" && wire.fallbackReason !== undefined) wire = { ...wire, fallback: fallbackText(wire.fallbackReason, o) };
    if (wire.kind === "order" && host.warnings !== undefined) {
      try {
        wire = { ...wire, warnings: [...wire.warnings, ...(await host.warnings(traderId, wire.symbol, wire.order))] };
      } catch (error) {
        request.log.warn({ err: error }, "parse-order: context warnings failed");
      }
    }
    // The text itself is never logged: it is the trader's.
    return reply.code(response.status).send(wire);
  });

  function status(): ParseOrderStatus {
    return { enabled: true, mode: o.mode, model: o.mode === "rules" ? null : o.model, state, maxTextLength: MAX_TEXT_LENGTH };
  }

  return {
    status,
    warmedUp,
    close() {
      warmController.abort();
      for (const controller of inFlight) controller.abort();
    },
  };
}

// The wire types in @ome/client mirror nl-orders' results; this fails to compile if they drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const wireMatchesParser: Same<ParseResult, WireParseResult> = true;
