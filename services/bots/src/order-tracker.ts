import type { ExecutionMessage, Side } from "@ome/client";

export interface OpenOrder {
  side: Side;
  price: number;
  remaining: number;
}

/** A bot's own view of its resting orders, position and P&L, built from execution reports. */
export class OrderTracker {
  readonly open = new Map<string, OpenOrder>();
  position = 0;
  /** Cash flow in price-ticks x quantity: negative after buying. */
  cash = 0;
  fills = 0;

  constructor(readonly symbol: string) {}

  handle(message: ExecutionMessage): void {
    if (message.symbol !== this.symbol) return;
    const id = message.clientOrderId;
    switch (message.event) {
      case "rested":
        this.open.set(id, { side: message.side, price: message.price, remaining: message.quantity });
        break;
      case "fill": {
        const signed = message.side === "buy" ? message.quantity : -message.quantity;
        this.position += signed;
        this.cash -= signed * message.price;
        this.fills++;
        const order = this.open.get(id);
        if (order !== undefined) {
          order.remaining -= message.quantity;
          if (order.remaining <= 0) this.open.delete(id);
        }
        break;
      }
      case "cancelled":
        this.open.delete(id);
        break;
      case "amended": {
        const order = this.open.get(id);
        if (order !== undefined) {
          order.price = message.price;
          order.remaining = message.quantity;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Mark-to-market profit and loss, in price-ticks x quantity. */
  pnl(markPrice: number): number {
    return this.cash + this.position * markPrice;
  }
}
