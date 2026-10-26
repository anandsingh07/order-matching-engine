// Wire types shared by the gateway, bots and the browser terminal.

export type Side = "buy" | "sell";

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

/**
 * Everything on the wire is an integer. An instrument says how those
 * integers map to the prices and quantities people read:
 * display price = price / priceScale, display quantity = quantity / quantityScale.
 */
export interface Instrument {
  symbol: string;
  name: string;
  /** Currency the instrument trades in; accounts hold cash per currency. */
  currency: string;
  priceScale: number;
  quantityScale: number;
  /** Prices must be a multiple of this many ticks. */
  tickSize: number;
  /** Quantities must be a multiple of this many units. */
  lotSize: number;
  /** Starting price in ticks, used by bots and price bands until trading sets one. */
  referencePrice: number;
  /** Absent means "spot": a share or coin traded outright. */
  kind?: InstrumentKind;
  /** Futures and options: the spot symbol the contract is written on. */
  underlying?: string;
  /** Futures and options: when trading stops and the contract cash-settles, ms since epoch. */
  expiry?: number;
  /** Options: the strike price, in the underlying's ticks. */
  strike?: number;
  /** Options. */
  right?: OptionRight;
  /**
   * Units of the underlying per contract (absent means 1). Prices are quoted
   * per unit of the underlying, so a contract's value is price x quantity x multiplier.
   */
  multiplier?: number;
}

export type InstrumentKind = "spot" | "future" | "option";

export type OptionRight = "call" | "put";

export type ClientOrder =
  | {
      type: "limit";
      side: Side;
      price: number;
      quantity: number;
      timeInForce?: "GTC" | "IOC" | "FOK";
      displayQuantity?: number;
      selfTrade?: SelfTradePrevention;
    }
  | { type: "market"; side: Side; quantity: number; timeInForce?: "IOC" | "FOK"; selfTrade?: SelfTradePrevention }
  | {
      type: "stop";
      side: Side;
      quantity: number;
      stopPrice: number;
      limitPrice?: number;
      timeInForce?: "GTC" | "IOC" | "FOK";
      selfTrade?: SelfTradePrevention;
    };

export type SelfTradePrevention = "allow" | "cancel_taker" | "cancel_maker" | "cancel_both";

export type ClientMessage =
  | { op: "subscribe"; channels: string[] }
  | { op: "unsubscribe"; channels: string[] }
  | { op: "order"; reqId: string | number; symbol: string; clientOrderId: string; order: ClientOrder }
  | { op: "cancel"; reqId: string | number; symbol: string; clientOrderId: string }
  | { op: "amend"; reqId: string | number; symbol: string; clientOrderId: string; price?: number; quantity?: number }
  | { op: "ping"; reqId?: string | number };

export interface PublicTrade {
  /** Engine sequence number; unique and increasing per symbol. */
  id: number;
  price: number;
  quantity: number;
  /** The aggressor's side. */
  side: Side;
  time: number;
}

export interface Candle {
  /** Start of the interval, ms since epoch. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

/** A trader's private view of what happened to one of their orders. */
export type Execution =
  | { event: "accepted" }
  | { event: "rejected"; reason: string }
  | { event: "rested"; side: Side; price: number; quantity: number; visible: number }
  | { event: "fill"; side: Side; price: number; quantity: number; liquidity: "maker" | "taker" }
  | { event: "cancelled"; remaining: number; reason: string }
  | { event: "amended"; price: number; quantity: number; keptPriority: boolean }
  | { event: "stop_pending"; side: Side; stopPrice: number; quantity: number }
  | { event: "triggered"; lastPrice: number };

export type ExecutionMessage = { type: "execution"; symbol: string; clientOrderId: string; time: number } & Execution;

export type TradingPhase = "continuous" | "auction";

/** A symbol's trading state: continuous, or in an auction and why. */
export interface MarketStatus {
  symbol: string;
  phase: TradingPhase;
  /** Why an auction is running: the opening auction or a circuit-breaker halt. */
  reason: "opening" | "circuit_breaker" | null;
  /** When the current auction is scheduled to uncross, ms since epoch. */
  until: number | null;
  /** Price bands and the circuit breaker are measured from this. */
  referencePrice: number;
  /** During an auction: what an uncross would do right now. */
  indicative: { price: number; volume: number; imbalance: number } | null;
  /** The price band in force: limit and stop prices within this percentage of the reference. */
  bandPct: number;
  /** The move within the breaker window that halts the symbol, in percent; null if there is no breaker. */
  breakerPct: number | null;
  /** Forecast volatility, once there is enough history: a typical move of `sigmaPct` percent over the horizon. */
  volatility: { sigmaPct: number; horizonMinutes: number; model: string } | null;
  /**
   * Derivatives: the band in force as prices in ticks. An option's band is not
   * symmetric around its reference (it comes from its underlying's band), so
   * this replaces `bandPct` for them.
   */
  band?: { low: number; high: number };
}

export interface CurrencyBalance {
  currency: string;
  /** Major units (e.g. rupees). */
  cash: number;
  /** Cash plus positions at market prices. */
  equity: number;
  /** Absolute value of positions plus resting orders. */
  exposure: number;
  /** How much more exposure the account may take on. */
  buyingPower: number;
  /**
   * Margin held against futures and options (positions and resting orders):
   * futures initial margin, short-option margin, and long options' value,
   * which is fully paid. Included in `exposure`. Absent from gateways without derivatives.
   */
  margin?: number;
}

export interface AccountPosition {
  symbol: string;
  quantity: number;
  averagePrice: number;
  /** Major units of the instrument's currency. */
  realized: number;
  unrealized: number;
  markPrice: number;
}

export interface AccountSnapshot {
  traderId: string;
  /** Unlimited accounts (bots acting as market makers) skip buying-power checks. */
  unlimited: boolean;
  balances: CurrencyBalance[];
  positions: AccountPosition[];
  liquidated: boolean;
}

export type ServerMessage =
  | { type: "welcome"; traderId: string; name: string }
  | { type: "ack"; reqId: string | number; clientOrderId: string }
  | { type: "reject"; reqId: string | number; clientOrderId?: string; reason: string }
  | { type: "error"; reqId?: string | number; message: string }
  | { type: "pong"; reqId?: string | number; time: number }
  | { type: "subscribed"; channels: string[] }
  | ExecutionMessage
  | { type: "trade"; symbol: string; trade: PublicTrade }
  | { type: "trades"; symbol: string; trades: PublicTrade[] }
  | { type: "book"; symbol: string; bids: DepthLevel[]; asks: DepthLevel[]; time: number }
  | { type: "candle"; symbol: string; interval: string; candle: Candle }
  | { type: "candles"; symbol: string; interval: string; candles: Candle[] }
  | ({ type: "status" } & MarketStatus)
  | ({ type: "account" } & AccountSnapshot)
  | { type: "notice"; level: "info" | "warning"; text: string }
  /** The tradable instruments changed: a derivative series expired, or a new one was listed. The full current list. */
  | { type: "instruments"; instruments: Instrument[] }
  | ({ type: "settlement" } & Settlement)
  /** A tournament's standings, pushed every couple of seconds on the "leaderboard:<id>" channel. */
  | ({ type: "leaderboard" } & Leaderboard);

export type TournamentStatus = "upcoming" | "live" | "finished";

/**
 * A trading competition over a fixed window. Joining resets the trader's
 * account to `startingCash`, so every entrant starts level; results are
 * measured from there and frozen when the tournament ends.
 */
export interface Tournament {
  id: string;
  name: string;
  /** ms since epoch. */
  start: number;
  end: number;
  /** What each entrant's account is reset to on joining: major units per currency. */
  startingCash: Record<string, number>;
  /** `startingCash` in the leaderboard's base currency, at its FX rates. */
  startingEquity: number;
  status: TournamentStatus;
  participants: number;
  /** Created by the gateway's rolling schedule rather than by an admin. */
  rolling: boolean;
}

export interface LeaderboardEntry {
  /** 1 is the best; every entrant has a distinct rank (see the tie-break on `Leaderboard`). */
  rank: number;
  traderId: string;
  name: string;
  joinedAt: number;
  /** Every currency's equity (cash plus all positions, derivatives included, at the mark), converted to the base currency. */
  equity: number;
  /** Equity against the starting equity, in percent. */
  returnPct: number;
  /** Largest fall from a running peak of the sampled equity, in percent of that peak. */
  maxDrawdownPct: number;
  /** Fills while the tournament was live (a partial fill counts as one). */
  trades: number;
  /**
   * Mean over standard deviation of the 1-second equity returns, times the
   * square root of their count: a Sharpe ratio over the entrant's time in the
   * tournament, not annualised. Null until the equity has moved.
   */
  sharpe: number | null;
}

export interface Leaderboard {
  tournament: Tournament;
  /** The currency equity is reported in. */
  baseCurrency: string;
  /** Units of the base currency per unit of each currency: fixed, configured rates, not live quotes. */
  fx: Record<string, number>;
  /** When the equity was last sampled; for a finished tournament, when its results were frozen. */
  asOf: number;
  /** Ranked by return, then the smaller drawdown, then who joined first, then trader id. */
  entries: LeaderboardEntry[];
  /**
   * Trader ids signed up while still in a tournament that ends by this one's
   * start: each enters (or, with a position or order left, lapses) when that
   * one ends. Not yet ranked.
   */
  queued: string[];
}

/**
 * How a final settlement price was set: the underlying's volume-weighted
 * average over the last minute before expiry, or (with no trade in that
 * minute) its last trade before expiry, or (with no trade at all) its
 * reference price.
 */
export type SettlementBasis = "vwap" | "last_trade" | "reference";

/** A trader's position in an expired future or option, closed by cash settlement. */
export interface Settlement {
  symbol: string;
  /** The final settlement price of the underlying, in ticks. */
  price: number;
  /** How `price` was set. Absent from gateways that predate it. */
  basis?: SettlementBasis;
  /** The position settled, in contracts; negative for a short. */
  quantity: number;
  /**
   * Cash paid (negative) or received, in major units of the currency: a
   * future's last variation since its average price, an option's intrinsic value.
   */
  amount: number;
  currency: string;
  time: number;
}

export type MessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** The reply to a trading request. */
export type RequestResult = MessageOf<"ack"> | MessageOf<"reject"> | MessageOf<"error">;

// Plain-English orders: POST /api/parse-order {"text": "buy 10 tcs at 4100"}.
// The reply is a proposal, never an instruction: it carries no client order
// id, and the terminal only prefills its ticket from it. These mirror
// @ome/nl-orders' result types (the gateway checks they stay identical).

export type ParseMode = "rules" | "llm" | "hybrid";
export type ParsedOrderType = "limit" | "market" | "stop" | "stop_limit";

/** What a parser (rules or the model) read from the text, before any checks. Numbers are exact decimal strings in display units. */
export interface OrderFields {
  intent: "order" | "cancel" | "unclear";
  side: Side | null;
  symbol: string | null;
  orderType: ParsedOrderType | null;
  quantity: string | null;
  price: string | null;
  stopPrice: string | null;
  timeInForce: "GTC" | "IOC" | "FOK" | null;
  displayQuantity: string | null;
  explanation: string;
}

export interface ParseProblem {
  field: keyof OrderFields | "text" | "model";
  message: string;
}

/** Why the model was not used. "busy": too many requests were already waiting on it. */
export type ModelFallback = "unreachable" | "timeout" | "http" | "bad_output" | "busy";

export interface ParseMeta {
  /** What the parser read: for the model, its own answer, even where the text overruled it. */
  fields: OrderFields;
  source: "rules" | "llm";
  /** The local model, when source is "llm". */
  model?: string;
  /** Set when the model could not be used and the rules answered: a sentence for the user (no internal URLs). */
  fallback?: string;
  fallbackReason?: ModelFallback;
  latencyMs: number;
}

export type Proposal =
  | { kind: "order"; symbol: string; order: ClientOrder; summary: string; warnings: string[] }
  | { kind: "cancel"; symbol: string | null; side: Side | null; summary: string }
  | { kind: "unclear"; problems: ParseProblem[]; summary: string };

export type ParseResult = (Proposal & ParseMeta) | { kind: "error"; message: string; latencyMs: number };

export interface ParseOrderRequest {
  text: string;
  mode?: ParseMode;
}

/** What TradingClient.parseOrder resolves to: the gateway's answer, or why it never reached the parser. */
export type ParseOrderReply = ParseResult | { kind: "failed"; status: number | null; message: string; retryAfterMs?: number };

/** GET /api/parse-order: whether plain-English orders are on, and how the model is doing. */
export interface ParseOrderStatus {
  enabled: boolean;
  mode: ParseMode;
  /** null in rules mode. */
  model: string | null;
  state: "ready" | "warming" | "offline" | "slow" | "rules_only";
  maxTextLength: number;
}
