import { CommandStream, OrderBook, type EngineCommand } from "@ome/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeReplies, decodeRequests, encodeReplies, encodeRequests } from "../src/codec.js";
import type { Reply, Request } from "../src/protocol.js";

/** Realistic traffic: every command and event shape the engine produces. */
function traffic(seed: number, count: number): { requests: Request[]; replies: Reply[] } {
  const book = new OrderBook();
  const stream = new CommandStream(seed);
  const requests: Request[] = [];
  const replies: Reply[] = [];
  for (let id = 1; id <= count; id++) {
    const command = stream.next();
    requests.push({ kind: "command", id, symbol: "TCS", command });
    replies.push({ id, events: book.apply(command) });
  }
  return { requests, replies };
}

const text = fc.string({ unit: "binary", maxLength: 80 });
const number = fc.oneof(fc.integer(), fc.double(), fc.constant(Number.NaN));

const order = fc.oneof(
  fc.record(
    {
      type: fc.constant("limit" as const),
      id: text,
      traderId: text,
      side: fc.constantFrom("buy" as const, "sell" as const),
      quantity: number,
      price: number,
      timeInForce: fc.constantFrom("GTC" as const, "IOC" as const, "FOK" as const),
      displayQuantity: number,
      selfTrade: fc.constantFrom("allow" as const, "cancel_taker" as const, "cancel_maker" as const, "cancel_both" as const),
    },
    { requiredKeys: ["type", "id", "traderId", "side", "quantity", "price"], noNullPrototype: true },
  ),
  fc.record(
    {
      type: fc.constant("stop" as const),
      id: text,
      traderId: text,
      side: fc.constantFrom("buy" as const, "sell" as const),
      quantity: number,
      stopPrice: number,
      limitPrice: number,
    },
    { requiredKeys: ["type", "id", "traderId", "side", "quantity", "stopPrice"], noNullPrototype: true },
  ),
  fc.record(
    {
      type: fc.constant("market" as const),
      id: text,
      traderId: text,
      side: fc.constantFrom("buy" as const, "sell" as const),
      quantity: number,
      timeInForce: fc.constantFrom("IOC" as const, "FOK" as const),
    },
    { requiredKeys: ["type", "id", "traderId", "side", "quantity"], noNullPrototype: true },
  ),
);

const command: fc.Arbitrary<EngineCommand> = fc.oneof(
  fc.constant({ type: "start_auction" as const }),
  fc.constant({ type: "uncross" as const }),
  order.map((o) => ({ type: "submit" as const, order: o })),
  text.map((orderId) => ({ type: "cancel" as const, orderId })),
  fc.record(
    {
      type: fc.constant("amend" as const),
      orderId: text,
      changes: fc.record({ price: number, quantity: number }, { requiredKeys: [], noNullPrototype: true }),
    },
    { noNullPrototype: true },
  ),
);

describe("binary codec", () => {
  it("round-trips realistic requests and replies exactly", () => {
    for (const seed of [1, 2, 3]) {
      const { requests, replies } = traffic(seed, 3_000);
      expect(decodeRequests(encodeRequests(requests).slice())).toEqual(requests);
      expect(decodeReplies(encodeReplies(replies).slice())).toEqual(replies);
    }
  });

  it("round-trips any command, keeping absent fields absent and odd numbers intact", () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 20 }), fc.string({ unit: "binary" }), (commands, symbol) => {
        const requests: Request[] = commands.map((c, i) => ({ kind: "command", id: i, symbol, command: c }));
        const decoded = decodeRequests(encodeRequests(requests).slice());
        // Object.is-style equality, so NaN must stay NaN and missing keys must stay missing.
        expect(decoded).toStrictEqual(requests);
      }),
    );
  });

  it("round-trips control requests and non-event replies", () => {
    const requests: Request[] = [
      { kind: "snapshot", id: 1, symbol: "INFY" },
      { kind: "checkpoint", id: 2 },
      { kind: "shutdown", id: 3 },
      { kind: "depth", id: 7, symbol: "TCS", levels: 20 },
      { kind: "indicative", id: 9, symbol: "INFY" },
      { kind: "list", id: 12, symbol: "TCS-25OCT1030-4100C" },
      { kind: "delist", id: 13, symbol: "TCS-25OCT1030-F" },
    ];
    expect(decodeRequests(encodeRequests(requests).slice())).toEqual(requests);
    const book = new OrderBook();
    const stream = new CommandStream(4);
    for (let i = 0; i < 500; i++) book.apply(stream.next());
    const replies: Reply[] = [
      { id: 4, snapshot: book.snapshot() },
      { id: 5, error: "boom ✗" },
      { id: 6 },
      { id: 8, depth: book.depth(20) },
      { id: 10, indicative: null },
      { id: 11, indicative: { price: 410_005, volume: 1_200, imbalance: -35 } },
    ];
    expect(decodeReplies(encodeReplies(replies).slice())).toEqual(replies);
  });

  it("refuses to encode values it cannot represent", () => {
    const bad = { kind: "command", id: 1, symbol: "X", command: { type: "cancel" } } as unknown as Request;
    expect(() => encodeRequests([{ ...bad, command: { type: "explode" } } as unknown as Request])).toThrow(/cannot encode/);
  });
});
