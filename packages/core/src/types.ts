export type Side = "buy" | "sell";

/**
 * GTC: rest on the book until filled or cancelled.
 * IOC: fill what is possible immediately, cancel the rest.
 * FOK: fill the whole quantity immediately or cancel it all.
 */
export type TimeInForce = "GTC" | "IOC" | "FOK";

/**
 * What happens when an incoming order would trade with a resting order from
 * the same trader (a wash trade). The incoming order's setting decides.
 */
export type SelfTradePrevention = "allow" | "cancel_taker" | "cancel_maker" | "cancel_both";

// Prices are integer ticks (e.g. paise) and quantities are integer units,
// so matching never suffers from floating-point rounding.

interface OrderInputBase {
  id: string;
  traderId: string;
  side: Side;
  quantity: number;
  /** Defaults to "allow". */
  selfTrade?: SelfTradePrevention;
}

export interface LimitOrderInput extends OrderInputBase {
  type: "limit";
  price: number;
  /** Defaults to GTC. */
  timeInForce?: TimeInForce;
  /**
   * Iceberg order: only this much is shown on the book at a time. When the
   * shown part fills, the next slice is shown at the back of the queue.
   * GTC only.
   */
  displayQuantity?: number;
}

export interface MarketOrderInput extends OrderInputBase {
  type: "market";
  /** Market orders never rest, so only IOC (default) and FOK apply. */
  timeInForce?: "IOC" | "FOK";
}

/**
 * Waits off the book until a trade prints at or through `stopPrice` (at or
 * above it for buys, at or below for sells), then enters as a limit order at
 * `limitPrice`, or as a market order if no limit price is given.
 */
export interface StopOrderInput extends OrderInputBase {
  type: "stop";
  stopPrice: number;
  limitPrice?: number;
  /** Applies once triggered. Defaults to GTC with a limit price, IOC without. */
  timeInForce?: TimeInForce;
}

export type OrderInput = LimitOrderInput | MarketOrderInput | StopOrderInput;

/** New values for a resting order. `quantity` is the new total remaining quantity. */
export interface AmendInput {
  price?: number;
  quantity?: number;
}

/**
 * continuous: orders match as they arrive.
 * auction:    limit orders collect without matching (the book may cross) until
 *             an uncross trades everything possible at one price.
 */
export type TradingPhase = "continuous" | "auction";

export type RejectReason =
  /** Only GTC limit orders (and stops) can join an auction. */
  | "not_allowed_in_auction"
  | "duplicate_id"
  | "invalid_quantity"
  | "invalid_price"
  | "invalid_display_quantity"
  /** Not a positive integer, or the stop would trigger immediately. */
  | "invalid_stop_price"
  | "unknown_order"
  /** Pending stop orders cannot be amended; cancel and resubmit instead. */
  | "not_amendable";

export type CancelReason =
  /** Cancelled by the trader. */
  | "user"
  /** IOC or market order: the part that could not fill immediately. */
  | "unfilled_remainder"
  /** FOK order: not enough liquidity to fill it completely. */
  | "fok_unfillable"
  /** Self-trade prevention. */
  | "self_trade";

export type EngineEvent =
  | { type: "accepted"; seq: number; orderId: string }
  | { type: "rejected"; seq: number; orderId: string; reason: RejectReason }
  | {
      type: "trade";
      seq: number;
      price: number;
      quantity: number;
      makerOrderId: string;
      makerTraderId: string;
      takerOrderId: string;
      takerTraderId: string;
      takerSide: Side;
    }
  /** `quantity` is the total resting quantity; `visible` is what the book shows. */
  | { type: "rested"; seq: number; orderId: string; side: Side; price: number; quantity: number; visible: number }
  | { type: "cancelled"; seq: number; orderId: string; remaining: number; reason: CancelReason }
  | { type: "amended"; seq: number; orderId: string; price: number; quantity: number; keptPriority: boolean }
  | { type: "stop_pending"; seq: number; orderId: string; side: Side; stopPrice: number; quantity: number }
  | { type: "triggered"; seq: number; orderId: string; lastPrice: number }
  /**
   * The trading phase changed. When an auction ends, `price` and `volume` are
   * its result (price null if nothing could trade).
   */
  | { type: "phase"; seq: number; phase: TradingPhase; price: number | null; volume: number };

type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;

/** An event before the engine stamps its sequence number. */
export type EngineEventBody = WithoutSeq<EngineEvent>;

export interface DepthLevel {
  price: number;
  /** Visible quantity only; iceberg reserves are hidden. */
  quantity: number;
  orders: number;
}

export interface Depth {
  /** Best (highest) price first. */
  bids: DepthLevel[];
  /** Best (lowest) price first. */
  asks: DepthLevel[];
}

export interface OrderView {
  id: string;
  traderId: string;
  side: Side;
  price: number;
  /** Total remaining, including any hidden iceberg reserve. */
  remaining: number;
  visible: number;
}

export interface StopOrderView {
  id: string;
  traderId: string;
  side: Side;
  stopPrice: number;
  limitPrice: number | null;
  quantity: number;
}

/** Every state change goes through one of these, so a journal of them can rebuild the book. */
export type EngineCommand =
  | { type: "submit"; order: OrderInput }
  | { type: "cancel"; orderId: string }
  | { type: "amend"; orderId: string; changes: AmendInput }
  /** Stop continuous matching and start collecting orders for a call auction. */
  | { type: "start_auction" }
  /** End the auction: trade at the single equilibrium price, then resume continuous trading. */
  | { type: "uncross" };

/** What an uncross would do right now, without doing it. */
export interface AuctionResult {
  price: number;
  volume: number;
  /** Unmatched quantity at that price: positive is excess demand, negative excess supply. */
  imbalance: number;
}

export interface RestingOrderSnapshot {
  id: string;
  traderId: string;
  side: Side;
  price: number;
  visible: number;
  hidden: number;
  display: number | null;
  selfTrade: SelfTradePrevention;
}

export interface StopOrderSnapshot {
  id: string;
  traderId: string;
  side: Side;
  stopPrice: number;
  limitPrice: number | null;
  quantity: number;
  timeInForce: TimeInForce;
  selfTrade: SelfTradePrevention;
  arrival: number;
}

/**
 * The complete state of a book as plain JSON-safe data. Restoring it gives a
 * book that behaves identically from then on, including sequence numbers.
 */
export interface BookSnapshot {
  version: 1;
  /** Absent in snapshots written before auctions existed, meaning continuous. */
  phase?: TradingPhase;
  seq: number;
  arrival: number;
  lastPrice: number | null;
  /** Best price first, and in queue order within a price. */
  bids: RestingOrderSnapshot[];
  asks: RestingOrderSnapshot[];
  /** In arrival order. */
  stops: StopOrderSnapshot[];
}
