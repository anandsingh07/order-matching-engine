// Plain-English orders: "buy 10 tata consultancy at 4100" -> a proposed
// ClientOrder for the user to confirm. Imported by the gateway (Node) and the
// terminal (browser), so everything here uses only standard web APIs.

export { DEFAULT_MODE, DEFAULT_MODEL, MAX_TEXT_LENGTH, parseOrder } from "./parse.ts";
export type { ParseOptions } from "./parse.ts";
export { parseWithRules, tokenize } from "./rules.ts";
export type { RuleParse } from "./rules.ts";
export { buildChatRequest, DEFAULT_OLLAMA_URL, fieldsFromModel, OllamaError, orderSchema, parseWithOllama, sanitize, systemPrompt, warmUp } from "./llm.ts";
export type { OllamaFailure, OllamaOptions } from "./llm.ts";
export { describe as describeOrder, toProposal } from "./validate.ts";
export { checkReading } from "./ground.ts";
export { toTicket } from "./ticket.ts";
export type { TicketForm } from "./ticket.ts";
export { readNlOrderRequest } from "./request.ts";
export type { NlOrderRequest } from "./request.ts";
export { BUSY, cancelCovers, createNlOrderHandler } from "./service.ts";
export type { HandlerOptions, HandlerResponse } from "./service.ts";
export { buildAliases, editDistance, matchInstrument } from "./instruments.ts";
export { cleanDecimal, numberToDecimal, shiftDecimal, toExactUnits } from "./numbers.ts";
export type * from "./types.ts";
