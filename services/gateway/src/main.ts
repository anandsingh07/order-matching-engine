import { Exchange } from "@ome/exchange";
import { SurveillanceModel } from "@ome/surveillance";
import { loadManifest, VolatilityMonitor } from "@ome/volatility";
import { Gateway } from "./gateway.js";
import { DEFAULT_INSTRUMENTS } from "./instruments.js";

// Starts the exchange and its gateway.
//   PORT=8080 DATA_DIR=./data WORKERS=4 pnpm --filter @ome/gateway start
// Without DATA_DIR everything is in memory and lost on exit.
// CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000 sets the browser origins allowed to call the REST API.
// OPENING_AUCTION_MS=10000 opening call auction length (0 = none); CIRCUIT_BREAKER=0 turns halts off;
// HALT_MS=15000 how long a circuit-breaker halt lasts.
// BOT_KEY=... the key bots use for unlimited accounts; ADMIN_KEY=... reads /api/surveillance and creates tournaments.
// SURVEILLANCE_SHADOW_MS=60000 starts surveillance in shadow mode for that long (calibrating per symbol), then goes live.
// VOLATILITY=0 turns off volatility forecasting and the volatility-aware limits; VOL_MODEL=har|garch|ewma
// overrides the model the training run chose.
// DERIVATIVES=0 lists no futures or options; DERIVATIVES_EXPIRY_MS=1800000 sets their expiry cycle
// (series expire on multiples of it, UTC, and a new series is listed as each one expires).
// TOURNAMENTS=0 turns trading tournaments off; TOURNAMENT_MS=900000 runs back-to-back tournaments of that
// length (on multiples of it, UTC; 0 or unset = none, anything else not a whole number of ms >= 1000 stops
// startup); USDT_INR=88 is the fixed rate leaderboards convert USDT equity at.
// GATEWAY_PROCESSES=2 serves clients through that many front-end processes (WebSocket, HTTP, validation,
// rate limits, serialization, market-data fan-out) while this process keeps all trading state; unset or 1
// is a single process. RATE_LIMIT=off lifts the per-connection order rate limit (for load tests);
// RATE_LIMIT=500,200 sets burst,perSecond (default 200,100).
// NL_ORDERS=0 turns plain-English orders (POST /api/parse-order) off; NL_MODE=rules|llm|hybrid (default
// hybrid), NL_MODEL=qwen2.5:1.5b, OLLAMA_URL=http://127.0.0.1:11434 and NL_TIMEOUT_MS=10000 set up the
// local model. Without Ollama the built-in rules answer alone.
// ENGINE=rust runs the Rust/WebAssembly matching engine in the exchange workers (default ts).

const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.DATA_DIR;
const workers = Number(process.env.WORKERS ?? 2);
const processes = Number(process.env.GATEWAY_PROCESSES ?? 1);
if (!Number.isInteger(processes) || processes < 1) {
  throw new Error(`GATEWAY_PROCESSES must be a whole number >= 1, got ${process.env.GATEWAY_PROCESSES}`);
}
const rateLimitText = process.env.RATE_LIMIT?.trim() ?? "";
function parseRateLimit(text: string): { burst: number; perSecond: number } | undefined {
  if (text === "") return undefined;
  if (text === "off") return { burst: 1e9, perSecond: 1e9 };
  const [burst, perSecond] = text.split(",").map(Number);
  if (!(burst! > 0) || !(perSecond! > 0)) throw new Error(`RATE_LIMIT must be "off" or "burst,perSecond", got ${text}`);
  return { burst: burst!, perSecond: perSecond! };
}
const rateLimit = parseRateLimit(rateLimitText);
const nlMode = process.env.NL_MODE ?? "hybrid";
if (nlMode !== "rules" && nlMode !== "llm" && nlMode !== "hybrid") throw new Error(`NL_MODE must be rules, llm or hybrid, got ${nlMode}`);

const exchange = Exchange.start({
  symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol),
  workers,
  ...(dataDir === undefined ? {} : { dataDir }),
  // ENGINE=rust matches in the Rust/WebAssembly engine instead of TypeScript (same events, same journal).
  ...(process.env.ENGINE === undefined ? {} : { engine: process.env.ENGINE as "ts" | "rust" }),
});
const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim());
// "0" means off, as for the other switches here; a typo ("15m") becomes NaN, which the gateway refuses at startup.
const tournamentMsText = process.env.TOURNAMENT_MS?.trim() ?? "";
const tournamentMs = tournamentMsText === "" || tournamentMsText === "0" ? undefined : Number(tournamentMsText);
const adminKey = process.env.ADMIN_KEY ?? "local-dev-admin-key";
// Surveillance runs if the trained models are present (packages/surveillance/models).
const model = await SurveillanceModel.load().catch((error: unknown) => {
  console.warn(`Surveillance disabled: ${error instanceof Error ? error.message : String(error)}`);
  return null;
});
// Volatility forecasting runs if the trained model is present (packages/volatility/models).
let volatility: VolatilityMonitor | null = null;
if (process.env.VOLATILITY !== "0") {
  try {
    volatility = new VolatilityMonitor(
      loadManifest(),
      DEFAULT_INSTRUMENTS.map((i) => i.symbol),
      process.env.VOL_MODEL === undefined ? {} : { model: process.env.VOL_MODEL },
    );
  } catch (error) {
    console.warn(`Volatility forecasting disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const gateway = await Gateway.create({
  exchange,
  logger: process.env.LOG === "1",
  ...(rateLimit === undefined ? {} : { rateLimit }),
  ...(corsOrigins === undefined ? {} : { corsOrigins }),
  // Bots presenting this key get unlimited (market-maker) accounts.
  botKey: process.env.BOT_KEY ?? "local-dev-bot-key",
  // Creates tournaments (and reads surveillance).
  adminKey,
  ...(model === null
    ? {}
    : { surveillance: { model, adminKey, shadowMs: Number(process.env.SURVEILLANCE_SHADOW_MS ?? 0) } }),
  ...(volatility === null ? {} : { volatility }),
  ...(process.env.DERIVATIVES === "0"
    ? {}
    : {
        derivatives:
          process.env.DERIVATIVES_EXPIRY_MS === undefined
            ? {}
            : { expiryMs: Number(process.env.DERIVATIVES_EXPIRY_MS), minLifeMs: Number(process.env.DERIVATIVES_EXPIRY_MS) / 2 },
      }),
  ...(process.env.TOURNAMENTS === "0"
    ? {}
    : {
        tournaments: {
          fx: { INR: 1, USDT: Number(process.env.USDT_INR ?? 88) },
          ...(tournamentMs === undefined ? {} : { rollingMs: tournamentMs }),
        },
      }),
  ...(process.env.NL_ORDERS === "0"
    ? {}
    : {
        parseOrder: {
          mode: nlMode,
          ...(process.env.NL_MODEL === undefined ? {} : { model: process.env.NL_MODEL }),
          ...(process.env.OLLAMA_URL === undefined ? {} : { ollamaUrl: process.env.OLLAMA_URL }),
          ...(process.env.NL_TIMEOUT_MS === undefined ? {} : { timeoutMs: Number(process.env.NL_TIMEOUT_MS) }),
        },
      }),
  market: {
    openingAuctionMs: Number(process.env.OPENING_AUCTION_MS ?? 10_000),
    bandPct: 10,
    circuitBreaker:
      process.env.CIRCUIT_BREAKER === "0" ? null : { windowMs: 60_000, movePct: 5, haltMs: Number(process.env.HALT_MS ?? 15_000) },
    // Band: 10 expected 15-minute moves, at least 2%. Breaker: 8 expected moves over its minute, at least 1%.
    volatility: volatility === null ? null : { bandSigmas: 10, minBandPct: 2, breakerSigmas: 8, minBreakerPct: 1 },
  },
});
const host = process.env.HOST ?? "127.0.0.1";
const url = processes >= 2 ? await gateway.listenFrontends({ port, host, processes }) : await gateway.listen(port, host);
const mode = processes >= 2 ? `${processes} front-end processes` : "single process";
console.log(`Gateway listening on ${url} (${mode}, ${workers} workers, ${dataDir === undefined ? "in memory" : `durable in ${dataDir}`})`);
if (rateLimit !== undefined) {
  console.log(`Order rate limit per connection: ${rateLimitText === "off" ? "off" : `burst ${rateLimit.burst}, ${rateLimit.perSecond}/s`}`);
}
const plainEnglish = gateway.plainEnglishOrders();
if (plainEnglish !== null) {
  const status = plainEnglish.status();
  console.log(`Plain-English orders: ${status.mode}${status.model === null ? "" : ` (rules + ${status.model})`}`);
  void plainEnglish.warmedUp.then((ms) => {
    if (status.model === null) return;
    console.log(
      ms === null ? "Plain-English orders: the local model is not reachable, so the built-in rules answer alone" : `Plain-English orders: model ready in ${(ms / 1000).toFixed(1)} s`,
    );
  });
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("Shutting down...");
  await gateway.close();
  await exchange.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
