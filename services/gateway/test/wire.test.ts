import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import * as wire from "../src/cluster/wire.js";
import type { ServerMessage } from "../src/index.js";

// The link between front-end processes and the core (src/cluster/wire.ts):
// every request survives encoding with absent fields still absent, every
// reply the front-end rebuilds serializes to exactly the single-process
// JSON, and frames reassemble however the stream splits them.

const trades: wire.TradeMessage[] = [
  { op: "order", reqId: "r1", symbol: "TCS", clientOrderId: "a1", order: { type: "limit", side: "buy", price: 410_000, quantity: 10 } },
  {
    op: "order",
    reqId: 7,
    symbol: "INFY-25OCT1030-1850C",
    clientOrderId: "x_-9",
    order: { type: "limit", side: "sell", price: 5, quantity: 30, timeInForce: "IOC", displayQuantity: 10, selfTrade: "allow" },
  },
  { op: "order", reqId: "m", symbol: "BTCUSDT", clientOrderId: "m1", order: { type: "market", side: "sell", quantity: 1 } },
  { op: "order", reqId: "m2", symbol: "BTCUSDT", clientOrderId: "m2", order: { type: "market", side: "buy", quantity: 3, timeInForce: "FOK", selfTrade: "cancel_both" } },
  { op: "order", reqId: "s", symbol: "TCS", clientOrderId: "s1", order: { type: "stop", side: "sell", quantity: 3, stopPrice: 400_000 } },
  {
    op: "order",
    reqId: "s2",
    symbol: "TCS",
    clientOrderId: "s2",
    order: { type: "stop", side: "buy", quantity: 3, stopPrice: 420_000, limitPrice: 421_000, timeInForce: "GTC", selfTrade: "cancel_maker" },
  },
  { op: "cancel", reqId: "c", symbol: "TCS", clientOrderId: "a1" },
  { op: "amend", reqId: "am", symbol: "TCS", clientOrderId: "a1" },
  { op: "amend", reqId: -3, symbol: "TCS", clientOrderId: "a1", price: 409_000 },
  { op: "amend", reqId: "am3", symbol: "TCS", clientOrderId: "a1", quantity: 4 },
  { op: "amend", reqId: "am4", symbol: "TCS", clientOrderId: "ünï", price: 409_000, quantity: 4 },
];

const head = { type: "execution", symbol: "TCS", clientOrderId: "a1", time: 1_761_400_000_123 } as const;
// Built the way gateway.ts builds them (route() and trade()), field order included.
const replies: ServerMessage[] = [
  { type: "ack", reqId: "r1", clientOrderId: "a1" },
  { type: "ack", reqId: 42, clientOrderId: "a1" },
  { type: "reject", reqId: "r2", clientOrderId: "a2", reason: "insufficient_buying_power" },
  { type: "reject", reqId: 3, reason: "rate_limited" },
  { ...head, event: "accepted" },
  { ...head, event: "rejected", reason: "not_allowed_in_auction" },
  { ...head, event: "rested", side: "buy", price: 410_000, quantity: 10, visible: 5 },
  { ...head, event: "fill", side: "sell", price: 410_005, quantity: 2, liquidity: "maker" },
  { ...head, event: "fill", side: "buy", price: 410_005, quantity: 2, liquidity: "taker" },
  { ...head, event: "cancelled", remaining: 8, reason: "expired" },
  { ...head, event: "amended", price: 409_000, quantity: 4, keptPriority: false },
  { ...head, event: "amended", price: 409_000, quantity: 3, keptPriority: true },
  { ...head, event: "stop_pending", side: "sell", stopPrice: 400_000, quantity: 3 },
  { ...head, event: "triggered", lastPrice: 399_995 },
];

/** A link over an in-memory stream, recording what it decodes. */
function sink() {
  const socket = new PassThrough() as unknown as Socket;
  const records: unknown[] = [];
  const errors: Error[] = [];
  const link = new wire.Link(
    socket,
    (r, kind) => records.push(kind === wire.MESSAGE ? { conn: r.u32(), essential: r.u8(), text: r.str() } : { kind, ...wire.readTrade(r, kind) }),
    (e) => errors.push(e),
  );
  return { link, records, errors };
}

/** One frame holding every request plus a JSON message. */
function frameBytes(): Buffer {
  const socket = new PassThrough();
  const chunks: Buffer[] = [];
  socket.on("data", (c: Buffer) => chunks.push(c));
  const link = new wire.Link(socket as unknown as Socket, () => {});
  trades.forEach((m, i) => wire.writeTrade(link.begin(m.op === "order" ? wire.ORDER : m.op === "cancel" ? wire.CANCEL : wire.AMEND), i, m));
  const w = link.begin(wire.MESSAGE);
  w.u32(99);
  w.u8(1);
  w.str(JSON.stringify({ type: "notice", level: "info", text: "₹ settled — ok" }));
  link.flush();
  return Buffer.concat(chunks);
}

describe("front-end link", () => {
  it("round-trips every order, cancel and amend with absent fields still absent", () => {
    const { link, records, errors } = sink();
    link.receive(frameBytes());
    expect(errors).toEqual([]);
    expect(records.slice(0, trades.length)).toStrictEqual(
      trades.map((message, conn) => ({ kind: message.op === "order" ? wire.ORDER : message.op === "cancel" ? wire.CANCEL : wire.AMEND, conn, message })),
    );
    expect(records[trades.length]).toEqual({ conn: 99, essential: 1, text: JSON.stringify({ type: "notice", level: "info", text: "₹ settled — ok" }) });
  });

  it("rebuilds acks, rejects and every execution event as byte-identical JSON", () => {
    for (const message of replies) {
      expect(wire.isBinaryReply(message)).toBe(true);
      const w = new wire.Writer();
      w.reset();
      wire.writeReply(w, 5, message as Parameters<typeof wire.writeReply>[2]);
      const bytes = w.take();
      const decoded = wire.readReply(new wire.Reader(bytes, 0, bytes.length), wire.replyKind(message as Parameters<typeof wire.replyKind>[0]));
      expect(decoded.conn).toBe(5);
      expect(JSON.stringify(decoded.message)).toBe(JSON.stringify(message));
    }
    // Anything else goes as its JSON text.
    expect(wire.isBinaryReply({ type: "welcome", traderId: "u1", name: "a" })).toBe(false);
  });

  it("reassembles frames split at every byte offset, and byte by byte", () => {
    const bytes = Buffer.concat([frameBytes(), frameBytes()]);
    const whole = sink();
    whole.link.receive(bytes);
    for (let cut = 1; cut < bytes.length; cut++) {
      const split = sink();
      split.link.receive(bytes.subarray(0, cut));
      split.link.receive(bytes.subarray(cut));
      expect(split.errors).toEqual([]);
      expect(split.records).toStrictEqual(whole.records);
    }
    const trickle = sink();
    for (let i = 0; i < bytes.length; i++) trickle.link.receive(bytes.subarray(i, i + 1));
    expect(trickle.records).toStrictEqual(whole.records);
  });

  it("closes the link on a corrupt frame instead of misreading it", () => {
    const bytes = frameBytes();
    bytes.writeUInt32LE(bytes.readUInt32LE(4) + 1, 4); // claims one more record than it holds
    const { link, errors } = sink();
    link.receive(bytes);
    expect(errors).toHaveLength(1);
    const huge = sink();
    huge.link.receive(Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
    expect(huge.errors).toHaveLength(1);
  });
});
