import { formatPrice, formatQuantity, type ClientOrder, type Instrument, type Side } from "@ome/client";

/**
 * The terminal's order-ticket fields (apps/terminal/src/lib/order-form.ts,
 * OrderForm), as display strings. Prefilling the ticket from a confirmed
 * proposal means the user still sees, and can still edit, exactly what will
 * be sent, and the ticket's own checks run once more.
 */
export interface TicketForm {
  kind: "limit" | "market" | "stop";
  side: Side;
  price: string;
  stopPrice: string;
  quantity: string;
  timeInForce: "GTC" | "IOC" | "FOK";
  display: string;
}

export function toTicket(instrument: Pick<Instrument, "priceScale" | "quantityScale">, order: ClientOrder): TicketForm {
  const quantity = formatQuantity(instrument, order.quantity);
  if (order.type === "market") {
    return { kind: "market", side: order.side, price: "", stopPrice: "", quantity, timeInForce: order.timeInForce ?? "GTC", display: "" };
  }
  if (order.type === "limit") {
    return {
      kind: "limit",
      side: order.side,
      price: formatPrice(instrument, order.price),
      stopPrice: "",
      quantity,
      timeInForce: order.timeInForce ?? "GTC",
      display: order.displayQuantity === undefined ? "" : formatQuantity(instrument, order.displayQuantity),
    };
  }
  return {
    kind: "stop",
    side: order.side,
    price: order.limitPrice === undefined ? "" : formatPrice(instrument, order.limitPrice),
    stopPrice: formatPrice(instrument, order.stopPrice),
    quantity,
    timeInForce: order.timeInForce ?? "GTC",
    display: "",
  };
}
