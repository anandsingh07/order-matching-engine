import { MAX_TEXT_LENGTH } from "./parse.ts";
import type { ParseMode } from "./types.ts";

/** The body of the gateway's plain-English order endpoint, e.g. POST /api/nl-order {"text": "buy 10 tcs at 4100"}. */
export interface NlOrderRequest {
  text: string;
  mode?: ParseMode;
}

const MODES: readonly ParseMode[] = ["rules", "llm", "hybrid"];

/** Checks an untrusted request body without tying this package to a web framework or schema library. */
export function readNlOrderRequest(body: unknown): NlOrderRequest | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "expected a JSON object" };
  const { text, mode } = body as Record<string, unknown>;
  if (typeof text !== "string") return { error: "text must be a string" };
  // Generous here; parseOrder applies the exact limit after cleaning the text.
  if (text.length > MAX_TEXT_LENGTH * 4) return { error: `text is too long (limit ${MAX_TEXT_LENGTH} characters)` };
  if (mode !== undefined && !(typeof mode === "string" && (MODES as readonly string[]).includes(mode))) {
    return { error: `mode must be one of ${MODES.join(", ")}` };
  }
  return mode === undefined ? { text } : { text, mode: mode as ParseMode };
}
