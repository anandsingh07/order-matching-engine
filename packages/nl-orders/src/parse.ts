import { checkReading } from "./ground.ts";
import { OllamaError, parseWithOllama, sanitize, type OllamaOptions } from "./llm.ts";
import { parseWithRules } from "./rules.ts";
import type { MarketInstrument, OrderFields, ParseMode, ParseResult, ResultMeta } from "./types.ts";
import { toProposal } from "./validate.ts";

/**
 * Defaults chosen by the evaluation (eval/run.ts), by a rule fixed before the
 * holdout set was first run: the most accurate setup on the holdout whose p95
 * latency is at most 3 s on this laptop's CPU, overall and (added after a
 * review) for the requests the model answers. On the final code, hybrid with
 * qwen2.5:1.5b scored 97.6% exact with no wrong proposals; the model answered
 * 11 of 83 requests, at p95 2.3 s in one run and 4.7 s in another (two slow
 * answers under load, from texts that took 2.0-2.8 s in every other run), so
 * it met the rule in one of the two. The rules alone scored 92.8%; hybrid with
 * qwen2.5:3b also 97.6%, with one wrong proposal and model answers at p95
 * 5.2-7.5 s. Fresh: 100% for both hybrids, 96.5% for the rules. When Ollama
 * is not running, hybrid is the rules, with `fallback` saying why. The README
 * has the full table.
 */
export const DEFAULT_MODE: ParseMode = "hybrid";
export const DEFAULT_MODEL = "qwen2.5:1.5b";

/** Orders are one line. Anything longer is refused before it reaches a model, which also bounds what an injection attempt can carry. */
export const MAX_TEXT_LENGTH = 300;

export interface ParseOptions extends Partial<OllamaOptions> {
  mode?: ParseMode;
  /** When the model cannot be used (not running, timeout, bad answer), answer with the rules instead. Default true. */
  fallback?: boolean;
}

const now = () => performance.now();

/**
 * Reads a plain-English order and proposes it. The result is never sent
 * anywhere: the caller shows `summary` and `warnings`, and builds the gateway
 * message only after the user confirms.
 *
 * - "rules": the rule-based parser only. Instant; no model needed.
 * - "llm": the local model through Ollama. The text must back its answer
 *   (ground.ts: the same numbers, a side and an instrument the text names),
 *   which then passes the same validation as the rules.
 * - "hybrid": the rules first; the model only for text the rules could not read
 *   (unknown words or an unexplained number, and no conflict that already makes it unclear).
 *
 * Network and model failures never throw: with `fallback` the rules answer
 * and `fallback` on the result says why; without it the result is an error.
 */
export async function parseOrder(text: string, instruments: readonly MarketInstrument[], options: ParseOptions = {}): Promise<ParseResult> {
  const started = now();
  const mode = options.mode ?? DEFAULT_MODE;
  const model = options.model ?? DEFAULT_MODEL;
  const finish = (fields: OrderFields, source: "rules" | "llm", extra: Pick<ResultMeta, "model" | "fallback" | "fallbackReason"> = {}): ParseResult => ({
    ...toProposal(fields, instruments),
    fields,
    source,
    ...extra,
    latencyMs: now() - started,
  });

  if (instruments.length === 0) return { kind: "error", message: "no instruments to trade", latencyMs: now() - started };
  const clean = sanitize(text);
  if (clean.length > MAX_TEXT_LENGTH) {
    return finish(unreadable(`That is too long for one order (${clean.length} characters; the limit is ${MAX_TEXT_LENGTH}).`), "rules");
  }
  if (clean === "") return finish(unreadable("Type an order, e.g. \"buy 10 TCS at 4100\"."), "rules");

  if (mode === "rules") return finish(parseWithRules(clean, instruments).fields, "rules");
  if (mode === "hybrid") {
    const rules = parseWithRules(clean, instruments);
    if (rules.certain) return finish(rules.fields, "rules");
  }

  try {
    const reading = await parseWithOllama(clean, instruments, { ...options, model });
    // The model's answer is only a reading, and the text has to back it
    // (ground.ts). `fields` on the result stays the model's own answer, so
    // what it said can always be compared with what was proposed.
    const checked = checkReading(clean, reading, instruments);
    if (checked.problems.length > 0) {
      const summary = `Could not read that reliably: ${checked.problems.map((p) => p.message).join("; ")}.`;
      return { kind: "unclear", problems: checked.problems, summary, fields: reading, source: "llm", model, latencyMs: now() - started };
    }
    return { ...toProposal(checked.fields, instruments), fields: reading, source: "llm", model, latencyMs: now() - started };
  } catch (e) {
    if (!(e instanceof OllamaError)) throw e;
    if (e.reason === "aborted" || options.fallback === false) return { kind: "error", message: e.message, latencyMs: now() - started };
    return finish(parseWithRules(clean, instruments).fields, "rules", { fallback: e.message, fallbackReason: e.reason });
  }
}

function unreadable(explanation: string): OrderFields {
  return {
    intent: "unclear",
    side: null,
    symbol: null,
    orderType: null,
    quantity: null,
    price: null,
    stopPrice: null,
    timeInForce: null,
    displayQuantity: null,
    explanation,
  };
}
