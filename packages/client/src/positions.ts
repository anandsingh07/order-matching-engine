import type { Side } from "./types.ts";

/**
 * A position under average-cost accounting. Prices are integer ticks and
 * quantities integer units; `realized` is in ticks x units.
 */
export interface Position {
  /** Signed: positive is long. */
  quantity: number;
  /** Average entry price of the open quantity; 0 when flat. */
  averagePrice: number;
  realized: number;
}

export const FLAT: Position = { quantity: 0, averagePrice: 0, realized: 0 };

/**
 * Applies one fill. Adding to a position blends the average price; reducing
 * it realizes P&L against the average; a fill larger than the position closes
 * it and opens the remainder the other way at the fill price.
 */
export function applyFill(position: Position, side: Side, price: number, quantity: number): Position {
  const signed = side === "buy" ? quantity : -quantity;
  const { quantity: held, averagePrice, realized } = position;

  if (held === 0 || Math.sign(held) === Math.sign(signed)) {
    const total = Math.abs(held) + quantity;
    return { quantity: held + signed, averagePrice: (averagePrice * Math.abs(held) + price * quantity) / total, realized };
  }

  const closing = Math.min(quantity, Math.abs(held));
  const pnl = closing * (price - averagePrice) * Math.sign(held);
  const after = held + signed;
  if (after === 0) return { quantity: 0, averagePrice: 0, realized: realized + pnl };
  if (Math.sign(after) === Math.sign(held)) return { quantity: after, averagePrice, realized: realized + pnl };
  return { quantity: after, averagePrice: price, realized: realized + pnl };
}

/** Open P&L at the mark price, in ticks x units. */
export function unrealized(position: Position, mark: number): number {
  return position.quantity === 0 ? 0 : position.quantity * (mark - position.averagePrice);
}
