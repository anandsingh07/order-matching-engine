import type { ClientOrder, ExecutionMessage, Side } from "@ome/client";

export type OrderStatus =
  | "pending" // sent, no answer yet
  | "accepted" // the engine has it; trades or resting status follow
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "stop_pending";

export interface MyOrder {
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: ClientOrder["type"];
  /** Limit price (or stop-limit price); absent for market and stop-market orders. */
  price?: number;
  stopPrice?: number;
  /** Total ordered, including anything already filled. */
  quantity: number;
  filled: number;
  /** Quantity still working on the book. */
  remaining: number;
  /** Total paid or received, in ticks x units, for the average fill price. */
  notional: number;
  status: OrderStatus;
  reason?: string;
  updatedAt: number;
}

export function newOrder(symbol: string, clientOrderId: string, order: ClientOrder, now: number): MyOrder {
  return {
    clientOrderId,
    symbol,
    side: order.side,
    type: order.type,
    ...(order.type === "limit" ? { price: order.price } : {}),
    ...(order.type === "stop" ? { stopPrice: order.stopPrice, ...(order.limitPrice === undefined ? {} : { price: order.limitPrice }) } : {}),
    quantity: order.quantity,
    filled: 0,
    remaining: 0,
    notional: 0,
    status: "pending",
    updatedAt: now,
  };
}

export const isActive = (o: MyOrder) =>
  o.status === "pending" || o.status === "accepted" || o.status === "open" || o.status === "partially_filled" || o.status === "stop_pending";

export const averageFillPrice = (o: MyOrder) => (o.filled === 0 ? null : o.notional / o.filled);

/**
 * The order's next state after an execution report. Reports can arrive for
 * orders this browser did not place (another tab, or before a reload), so an
 * unknown order is created from what the report says.
 */
export function applyExecution(order: MyOrder | undefined, m: ExecutionMessage): MyOrder {
  const o: MyOrder = order
    ? { ...order, updatedAt: m.time }
    : {
        clientOrderId: m.clientOrderId,
        symbol: m.symbol,
        side: "side" in m ? m.side : "buy",
        type: "limit",
        quantity: "quantity" in m ? m.quantity : 0,
        filled: 0,
        remaining: 0,
        notional: 0,
        status: "accepted",
        updatedAt: m.time,
      };

  switch (m.event) {
    case "accepted":
      if (o.status === "pending") o.status = "accepted";
      break;
    case "rejected":
      o.status = "rejected";
      o.reason = m.reason;
      o.remaining = 0;
      break;
    case "rested":
      o.price = m.price;
      o.remaining = m.quantity;
      o.status = o.filled > 0 ? "partially_filled" : "open";
      if (order === undefined) o.quantity = m.quantity;
      break;
    case "fill":
      o.filled += m.quantity;
      o.notional += m.quantity * m.price;
      o.remaining = Math.max(0, o.remaining - m.quantity);
      if (o.quantity < o.filled) o.quantity = o.filled;
      o.status = o.filled >= o.quantity ? "filled" : o.remaining > 0 ? "partially_filled" : o.status;
      if (o.status === "filled") o.remaining = 0;
      break;
    case "cancelled":
      o.status = "cancelled";
      o.reason = m.reason;
      o.remaining = 0;
      break;
    case "amended":
      o.price = m.price;
      o.remaining = m.quantity;
      o.quantity = o.filled + m.quantity;
      break;
    case "stop_pending":
      o.status = "stop_pending";
      o.stopPrice = m.stopPrice;
      break;
    case "triggered":
      o.status = "accepted";
      break;
  }
  return o;
}
