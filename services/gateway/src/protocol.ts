import type { ServerMessage, ClientMessage as WireClientMessage, ClientOrder as WireClientOrder } from "@ome/client";
import { z } from "zod";

// The client-facing WebSocket protocol. Everything arriving from a socket is
// validated here before it can reach the engine. The message types themselves
// live in @ome/client so the browser and bots share them.

export type { Candle, Execution, PublicTrade, ServerMessage } from "@ome/client";

const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const side = z.enum(["buy", "sell"]);
const reqId = z.union([z.string().max(64), z.number().int()]);
/** Client order ids are scoped to the trader, so they only need to be unique per trader. */
const clientOrderId = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/, "1-36 letters, digits, '_' or '-'");
// Derivative series names run longer than stock tickers, e.g. "INFY-25OCT1030-1850C".
const symbol = z.string().max(32);
const selfTrade = z.enum(["allow", "cancel_taker", "cancel_maker", "cancel_both"]);

export const orderSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("limit"),
    side,
    price: positiveInt,
    quantity: positiveInt,
    timeInForce: z.enum(["GTC", "IOC", "FOK"]).optional(),
    displayQuantity: positiveInt.optional(),
    selfTrade: selfTrade.optional(),
  }),
  z.object({
    type: z.literal("market"),
    side,
    quantity: positiveInt,
    timeInForce: z.enum(["IOC", "FOK"]).optional(),
    selfTrade: selfTrade.optional(),
  }),
  z.object({
    type: z.literal("stop"),
    side,
    quantity: positiveInt,
    stopPrice: positiveInt,
    limitPrice: positiveInt.optional(),
    timeInForce: z.enum(["GTC", "IOC", "FOK"]).optional(),
    selfTrade: selfTrade.optional(),
  }),
]);

export type ClientOrder = z.infer<typeof orderSchema>;

export const clientMessageSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), channels: z.array(z.string().max(64)).max(50) }),
  z.object({ op: z.literal("unsubscribe"), channels: z.array(z.string().max(64)).max(50) }),
  z.object({ op: z.literal("order"), reqId, symbol, clientOrderId, order: orderSchema }),
  z.object({ op: z.literal("cancel"), reqId, symbol, clientOrderId }),
  z.object({
    op: z.literal("amend"),
    reqId,
    symbol,
    clientOrderId,
    price: positiveInt.optional(),
    quantity: positiveInt.optional(),
  }),
  z.object({ op: z.literal("ping"), reqId: reqId.optional() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Compile-time guard: the schemas and the shared wire types must describe the
// same messages. If either side changes alone, type checking fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemasMatchWireTypes: [Same<ClientOrder, WireClientOrder>, Same<ClientMessage, WireClientMessage>] = [true, true];
void schemasMatchWireTypes;

/**
 * Parses and validates one client frame. A bad one yields the error message
 * to send back, echoing its reqId when it had a usable one.
 */
export function parseClientMessage(text: string): { message: ClientMessage } | { error: ServerMessage & { type: "error" } } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: { type: "error", message: "invalid JSON" } };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (parsed.success) return { message: parsed.data };
  const issue = parsed.error.issues[0];
  const reqId = (json as { reqId?: unknown } | null)?.reqId;
  return {
    error: {
      type: "error",
      ...(typeof reqId === "string" || typeof reqId === "number" ? { reqId } : {}),
      message: issue === undefined ? "invalid message" : `${issue.path.join(".") || "message"}: ${issue.message}`,
    },
  };
}
