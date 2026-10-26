import fc from "fast-check";
import type { AmendInput, EngineEvent, OrderInput, SelfTradePrevention, Side, TimeInForce } from "../src/types.js";

export type Command =
  | {
      kind: "limit";
      trader: number;
      side: Side;
      price: number;
      quantity: number;
      tif: TimeInForce;
      display: number | undefined;
      selfTrade: SelfTradePrevention | undefined;
      reuseId: number | null;
    }
  | {
      kind: "market";
      trader: number;
      side: Side;
      quantity: number;
      tif: "IOC" | "FOK";
      selfTrade: SelfTradePrevention | undefined;
    }
  | {
      kind: "stop";
      trader: number;
      side: Side;
      stopPrice: number;
      limitPrice: number | undefined;
      quantity: number;
      tif: TimeInForce | undefined;
      selfTrade: SelfTradePrevention | undefined;
    }
  | { kind: "cancel"; target: number }
  | { kind: "amend"; target: number; price: number | undefined; quantity: number | undefined }
  | { kind: "auction" }
  | { kind: "uncross" };

export interface BookLike {
  submit(input: OrderInput): EngineEvent[];
  cancel(orderId: string): EngineEvent[];
  amend(orderId: string, changes: AmendInput): EngineEvent[];
  startAuction(): EngineEvent[];
  uncross(): EngineEvent[];
}

const side = fc.constantFrom<Side>("buy", "sell");
// Few traders, so self-trades happen often.
const trader = fc.integer({ min: 1, max: 5 });

// A narrow price band so orders cross often; occasional invalid values exercise rejects.
const price = fc.oneof(
  { weight: 30, arbitrary: fc.integer({ min: 95, max: 105 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, -1, 100.5) },
);
const quantity = fc.oneof(
  { weight: 30, arbitrary: fc.integer({ min: 1, max: 50 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, -3, 1.5) },
);
const selfTrade = fc.option(fc.constantFrom<SelfTradePrevention>("allow", "cancel_taker", "cancel_maker", "cancel_both"), {
  nil: undefined,
});
const display = fc.oneof(
  { weight: 6, arbitrary: fc.constant(undefined) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 10 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 2.5) },
);

const limit = fc.record({
  kind: fc.constant("limit" as const),
  trader,
  side,
  price,
  quantity,
  tif: fc.constantFrom<TimeInForce>("GTC", "GTC", "GTC", "IOC", "FOK"),
  display,
  selfTrade,
  reuseId: fc.oneof({ weight: 20, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.nat() }),
});

const market = fc.record({
  kind: fc.constant("market" as const),
  trader,
  side,
  quantity,
  tif: fc.constantFrom<"IOC" | "FOK">("IOC", "FOK"),
  selfTrade,
});

const stop = fc.record({
  kind: fc.constant("stop" as const),
  trader,
  side,
  stopPrice: price,
  limitPrice: fc.option(price, { nil: undefined }),
  quantity,
  tif: fc.option(fc.constantFrom<TimeInForce>("GTC", "IOC", "FOK"), { nil: undefined }),
  selfTrade,
});

const cancel = fc.record({ kind: fc.constant("cancel" as const), target: fc.nat() });

const amend = fc.record({
  kind: fc.constant("amend" as const),
  target: fc.nat(),
  price: fc.option(price, { nil: undefined }),
  quantity: fc.option(quantity, { nil: undefined }),
});

export const commandArb = (options: { amends?: boolean; auctions?: boolean } = {}): fc.Arbitrary<Command> => {
  const choices: fc.WeightedArbitrary<Command>[] = [
    { weight: 6, arbitrary: limit },
    { weight: 2, arbitrary: market },
    { weight: 2, arbitrary: stop },
    { weight: 2, arbitrary: cancel },
  ];
  if (options.amends !== false) choices.push({ weight: 2, arbitrary: amend });
  if (options.auctions !== false) {
    // Rare enough that the book has time to build up (and cross) between them.
    choices.push({ weight: 1, arbitrary: fc.constant({ kind: "auction" as const }) });
    choices.push({ weight: 1, arbitrary: fc.constant({ kind: "uncross" as const }) });
  }
  return fc.oneof(...choices);
};

/**
 * Turns abstract commands into concrete calls. It hands out fresh order ids
 * and points cancels/amends at ids it issued, so most of them hit real orders.
 * Every book receives the identical input object.
 */
export class CommandDriver {
  readonly ids: string[] = [];

  apply<B extends BookLike>(books: B[], command: Command): EngineEvent[][] {
    switch (command.kind) {
      case "limit": {
        const input: OrderInput = {
          type: "limit",
          id: this.orderId(command.reuseId),
          traderId: `t${command.trader}`,
          side: command.side,
          price: command.price,
          quantity: command.quantity,
          timeInForce: command.tif,
        };
        if (command.display !== undefined) input.displayQuantity = command.display;
        if (command.selfTrade !== undefined) input.selfTrade = command.selfTrade;
        return books.map((b) => b.submit(input));
      }
      case "market": {
        const input: OrderInput = {
          type: "market",
          id: this.orderId(null),
          traderId: `t${command.trader}`,
          side: command.side,
          quantity: command.quantity,
          timeInForce: command.tif,
        };
        if (command.selfTrade !== undefined) input.selfTrade = command.selfTrade;
        return books.map((b) => b.submit(input));
      }
      case "stop": {
        const input: OrderInput = {
          type: "stop",
          id: this.orderId(null),
          traderId: `t${command.trader}`,
          side: command.side,
          stopPrice: command.stopPrice,
          quantity: command.quantity,
        };
        if (command.limitPrice !== undefined) input.limitPrice = command.limitPrice;
        if (command.tif !== undefined) input.timeInForce = command.tif;
        if (command.selfTrade !== undefined) input.selfTrade = command.selfTrade;
        return books.map((b) => b.submit(input));
      }
      case "cancel": {
        const id = this.existingId(command.target);
        return books.map((b) => b.cancel(id));
      }
      case "amend": {
        const id = this.existingId(command.target);
        const changes: AmendInput = {};
        if (command.price !== undefined) changes.price = command.price;
        if (command.quantity !== undefined) changes.quantity = command.quantity;
        return books.map((b) => b.amend(id, changes));
      }
      case "auction":
        return books.map((b) => b.startAuction());
      case "uncross":
        return books.map((b) => b.uncross());
    }
  }

  private orderId(reuse: number | null): string {
    if (reuse !== null && this.ids.length > 0) return this.ids[reuse % this.ids.length]!;
    const id = `o${this.ids.length + 1}`;
    this.ids.push(id);
    return id;
  }

  private existingId(target: number): string {
    return this.ids.length === 0 ? "missing" : this.ids[target % this.ids.length]!;
  }
}
