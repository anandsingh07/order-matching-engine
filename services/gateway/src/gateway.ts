import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import websocket, { type WebSocket } from "@fastify/websocket";
import { formatPrice, instrumentKind, type Instrument, type MarketStatus, type Side } from "@ome/client";
import type { EngineCommand, EngineEvent, OrderInput } from "@ome/core";
import type { Exchange } from "@ome/exchange";
import { SurveillanceMonitor, TOUCH_LEVELS, type SurveillanceModel } from "@ome/surveillance";
import type { VolatilityMonitor } from "@ome/volatility";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { Accounts, DEFAULT_RISK, marginRate, type RiskOptions } from "./accounts.js";
import { INTERVALS, type Interval } from "./candles.js";
import { Derivatives, type DerivativesOptions } from "./derivatives.js";
import { DEFAULT_INSTRUMENTS } from "./instruments.js";
import { DEFAULT_RULES, MarketControl, type MarketRules } from "./market-control.js";
import { FrontendPool, forwardLinkAborts, type FrontendStats } from "./cluster/pool.js";
import { MarketData, type MarketSubscriptions, type Subscriber } from "./market-data.js";
import { sendCorked, serialize } from "./outbound.js";
import { registerParseOrder, type ParseOrderOptions, type PlainEnglishOrders } from "./parse-order.js";
import { parseClientMessage, type ClientMessage, type ClientOrder, type Execution, type ServerMessage } from "./protocol.js";
import { TokenBucket } from "./rate-limit.js";
import { DEFAULT_TOURNAMENTS, JOIN_ERRORS, Tournaments, type TournamentOptions } from "./tournaments.js";

export interface GatewayOptions {
  exchange: Exchange;
  instruments?: Instrument[];
  /** Wall clock for trade and report timestamps; the engine itself has none. */
  now?: () => number;
  /** Per-connection order rate limit. Defaults to bursts of 200, 100/sec sustained. */
  rateLimit?: { burst: number; perSecond: number };
  /** How often changed books are published. Defaults to 100 ms. */
  bookIntervalMs?: number;
  /** Origins allowed to call the REST API from a browser. */
  corsOrigins?: string[];
  /** Opening auction, price bands and circuit breaker. */
  market?: Partial<MarketRules>;
  /** Starting cash, leverage and limits for trader accounts. */
  risk?: Partial<RiskOptions>;
  /** Sessions created with this key get unlimited accounts (bots acting as market makers). */
  botKey?: string;
  /**
   * Market-abuse surveillance: score traders with this model; alerts readable with the admin key.
   * With `shadowMs`, the first `shadowMs` of trading are a shadow period that calibrates per-symbol thresholds.
   */
  surveillance?: { model: SurveillanceModel; adminKey: string; scanIntervalMs?: number; shadowMs?: number };
  /** Live volatility forecasts: published in each symbol's status, and used by `market.volatility` limits. */
  volatility?: VolatilityMonitor;
  /**
   * Futures and options on some of the stocks, listed on a rolling expiry
   * cycle and cash-settled at expiry (see derivatives.ts). Off when absent.
   */
  derivatives?: Partial<DerivativesOptions>;
  /** How often series are checked for expiry. Defaults to 250 ms; trading stops at the expiry instant whatever this is. */
  rollIntervalMs?: number;
  /**
   * Trading tournaments and their leaderboards (see tournaments.ts). Off when
   * absent. Starting cash defaults to the accounts' starting cash.
   */
  tournaments?: Partial<TournamentOptions>;
  /** Key for admin actions (creating tournaments). Defaults to the surveillance admin key. */
  adminKey?: string;
  /**
   * Plain-English orders: POST /api/parse-order reads "buy 10 tcs at 4100"
   * into a proposal (see parse-order.ts). Off when absent, so nothing
   * contacts a local model unless asked to.
   */
  parseOrder?: Partial<ParseOrderOptions>;
  logger?: boolean;
}

export interface Trader {
  id: string;
  name: string;
}

/**
 * A trader's connection as the gateway's logic sees it: a WebSocket in this
 * process (Session), or one held by a front-end process (cluster/pool.ts).
 */
export interface SessionLike extends Subscriber {
  readonly trader: Trader;
  /** The per-connection rate limit. A front-end process applies it before forwarding, so its sessions' always allows. */
  readonly bucket: { take(): boolean };
  /** Where this session's market-data subscriptions go; MarketData itself when absent. */
  readonly channels?: MarketSubscriptions;
  /** Set on front-end sessions: broadcasts reach them once per front-end, not once per session. */
  readonly remote?: boolean;
}

/** Market data is dropped for a client whose socket has this much unsent data... */
const SOFT_BUFFER_LIMIT = 1 << 20;
/** ...and the client is disconnected if even essential messages back up this far. */
const HARD_BUFFER_LIMIT = 16 << 20;
/** Remembered client order ids per trader, for duplicate detection. */
const MAX_REMEMBERED_IDS = 100_000;
/** Market orders are risk-checked as if they fill this much worse than the touch. */
const MARKET_SLIPPAGE = 0.02;

class Session implements SessionLike {
  constructor(
    readonly socket: WebSocket,
    readonly trader: Trader,
    readonly bucket: TokenBucket,
  ) {}

  deliver(message: ServerMessage, essential: boolean): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    const buffered = this.socket.bufferedAmount;
    if (buffered > HARD_BUFFER_LIMIT) {
      this.socket.close(4008, "slow consumer");
      return;
    }
    if (!essential && buffered > SOFT_BUFFER_LIMIT) return;
    sendCorked(this.socket, serialize(message));
  }
}

/** Splits an engine order id "<traderId>:<clientOrderId>". */
/** The price a limit or stop order is risk-checked at. */
function restingPrice(order: Exclude<ClientOrder, { type: "market" }>): number {
  return order.type === "limit" ? order.price : (order.limitPrice ?? order.stopPrice);
}

function owner(orderId: string): { traderId: string; clientOrderId: string } | null {
  const i = orderId.indexOf(":");
  return i <= 0 ? null : { traderId: orderId.slice(0, i), clientOrderId: orderId.slice(i + 1) };
}

/**
 * The network edge of the exchange: REST for reference data and history,
 * WebSocket for trading and live market data.
 *
 * Responsibilities the engine deliberately does not have:
 * - Identity: a socket is bound to one trader by its session token, and the
 *   trader id on every order comes from that binding, never from the client.
 * - Namespacing: the engine order id is "<traderId>:<clientOrderId>", so
 *   traders cannot see, collide with, or cancel each other's orders.
 * - Validation (schema, tick and lot sizes), per-connection rate limits, and
 *   session-wide duplicate client order ids.
 * - Privacy: engine events name both sides of a trade. Each trader only gets
 *   private execution reports for their own orders; everyone else sees
 *   anonymous public trades.
 * - Market protections: opening auction, price bands, circuit breaker.
 * - Accounts: pre-trade buying-power checks and liquidation on margin breach.
 */
export class Gateway {
  readonly app: FastifyInstance;
  private readonly exchange: Exchange;
  private readonly instruments: Map<string, Instrument>;
  private readonly market: MarketData;
  private readonly control: MarketControl;
  private readonly accounts: Accounts;
  private readonly now: () => number;
  private readonly rateLimit: { burst: number; perSecond: number };
  private readonly botKey: string | undefined;
  private readonly traders = new Map<string, Trader>(); // by token
  private readonly sessions = new Map<string, Set<SessionLike>>(); // by trader id
  private readonly usedIds = new Map<string, Set<string>>(); // by trader id
  /**
   * Per connection: resolves once its latest trade has been handed to the
   * exchange. Present only while a trade is waiting on a price or a
   * surveillance check; later trades from that connection wait behind it.
   */
  private readonly sendQueues = new WeakMap<SessionLike, Promise<void>>();
  /** Traders whose account changed since it was last pushed. */
  private readonly dirtyAccounts = new Set<string>();
  private readonly liquidating = new Set<string>();
  private readonly monitor: SurveillanceMonitor | null;
  private readonly surveillance: GatewayOptions["surveillance"];
  private readonly volatility: VolatilityMonitor | null;
  private readonly names = new Map<string, string>(); // trader id -> display name
  private readonly derivatives: Derivatives | null;
  /** Series being expired: every request for them is refused. */
  private readonly expiring = new Set<string>();
  /** Engine order ids cancelled because their series expired, so the report can say so. */
  private readonly expiryCancels = new Set<string>();
  private readonly tournaments: Tournaments | null;
  private readonly adminKey: string | undefined;
  /** Leaderboard subscribers by tournament id ("leaderboard:<id>" channels). */
  private readonly boards = new Map<string, Set<SessionLike>>();
  /** Finished tournaments whose final standings have been pushed: they never change again. */
  private readonly boardsFinal = new Set<string>();
  private rolling = false;
  private nextTrader = 1;
  private nextLiquidation = 1;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly timeouts: NodeJS.Timeout[] = [];
  private readonly unsubscribe: () => void;
  private readonly parseOrderOptions: Partial<ParseOrderOptions> | undefined;
  private plainEnglish: PlainEnglishOrders | null = null;
  /** Front-end processes, when listening through them (listenFrontends). */
  private pool: FrontendPool | null = null;

  private constructor(options: GatewayOptions) {
    this.exchange = options.exchange;
    this.parseOrderOptions = options.parseOrder;
    this.now = options.now ?? Date.now;
    this.rateLimit = options.rateLimit ?? { burst: 200, perSecond: 100 };
    this.botKey = options.botKey;
    const instruments = (options.instruments ?? DEFAULT_INSTRUMENTS).filter((i) => this.exchange.symbols.includes(i.symbol));
    this.instruments = new Map(instruments.map((i) => [i.symbol, i]));
    this.market = new MarketData(new Set(this.instruments.keys()), (s) => this.exchange.depth(s, 20), this.now);
    const volatility = (this.volatility = options.volatility ?? null);
    const forecast = (symbol: string) => {
      const f = volatility?.forecast(symbol) ?? null;
      return f === null ? null : { sigmaPct: f.sigma * 100, horizonMinutes: f.horizonMinutes };
    };
    const derivatives = (this.derivatives =
      options.derivatives === undefined
        ? null
        : new Derivatives(options.derivatives, {
            now: this.now,
            price: (symbol) => this.control.referencePrice(symbol),
            forecast,
            bandPct: (symbol) => this.control.bandPct(symbol),
          }));
    this.control = new MarketControl(
      this.exchange,
      instruments,
      this.now,
      { ...DEFAULT_RULES, ...options.market },
      (status) => this.broadcast({ type: "status", ...status }),
      (symbol) => volatility?.forecast(symbol) ?? null,
      (symbol) => derivatives?.band(symbol) ?? null,
    );
    const risk = { ...DEFAULT_RISK, ...options.risk };
    this.accounts = new Accounts(
      this.instruments,
      (s) => derivatives?.mark(s) ?? this.control.referencePrice(s),
      risk,
      // Margin follows the underlying's forecast 15-minute move.
      (underlying) => marginRate(forecast(underlying)?.sigmaPct ?? null, risk.margin),
    );
    this.adminKey = options.adminKey ?? options.surveillance?.adminKey;
    this.tournaments = options.tournaments === undefined ? null : this.createTournaments(options.tournaments, risk.startingCash, instruments);
    this.surveillance = options.surveillance;
    this.monitor = options.surveillance === undefined ? null : new SurveillanceMonitor(options.surveillance.model);
    this.unsubscribe = this.exchange.onEvents((symbol, events) => this.route(symbol, events));
    this.every(options.bookIntervalMs ?? 100, () => this.market.publishBooks());
    if (this.monitor !== null) {
      const monitor = this.monitor;
      this.every(options.surveillance?.scanIntervalMs ?? 5_000, () => monitor.scan(this.now()));
      const shadowMs = options.surveillance?.shadowMs ?? 0;
      if (shadowMs > 0) {
        monitor.startShadow();
        const timer = setTimeout(() => monitor.finishShadow(), shadowMs);
        timer.unref();
        this.timeouts.push(timer);
      }
    }
    this.every(250, async () => this.pushAccounts([...this.dirtyAccounts]));
    if (derivatives !== null) this.every(options.rollIntervalMs ?? 250, () => this.rollDerivatives());
    this.every(1_000, async () => {
      // A new forecast moves option marks, so a tournament that has ended is frozen first.
      this.tournaments?.advance(this.now());
      // Minutes that ended without a trade still update the forecast.
      for (const symbol of this.volatility?.roll(this.now()) ?? []) this.control.republish(symbol);
      // Derivatives' bands follow their underlyings.
      this.control.refreshBands();
      await this.control.refreshIndicative();
      await this.liquidate();
      // Marks move with every trade, so open positions need fresh P&L.
      this.pushAccounts([...this.sessions.keys()]);
    });
    if (this.tournaments !== null) {
      const tournaments = this.tournaments;
      this.every(tournaments.options.sampleIntervalMs, async () => tournaments.sample(this.now()));
      this.every(tournaments.options.pushIntervalMs, async () => this.pushBoards());
    }
    this.app = Fastify({ logger: options.logger ?? false });
  }

  private createTournaments(options: Partial<TournamentOptions>, startingCash: Record<string, number>, instruments: Instrument[]): Tournaments {
    const settings: TournamentOptions = { ...DEFAULT_TOURNAMENTS, startingCash, ...options };
    // Checked here, not when equity is first converted: a missing rate found mid-tournament could only be skipped.
    for (const currency of new Set([...instruments.map((i) => i.currency), ...Object.keys(settings.startingCash)])) {
      const rate = settings.fx[currency];
      if (rate === undefined || !(rate > 0) || !Number.isFinite(rate)) throw new Error(`tournaments: no valid FX rate for ${currency} (got ${rate})`);
    }
    return new Tournaments(settings, {
      balances: (traderId) => this.accounts.snapshot(traderId)?.balances,
      isUnlimited: (traderId) => this.accounts.isUnlimited(traderId),
      isFlat: (traderId) => this.accounts.isFlat(traderId),
      reset: (traderId, cash) => {
        const done = this.accounts.reset(traderId, cash);
        if (done) this.dirtyAccounts.add(traderId);
        return done;
      },
      name: (traderId) => this.names.get(traderId) ?? traderId,
      notice: (traderId, level, text) => {
        for (const session of this.sessions.get(traderId) ?? []) session.deliver({ type: "notice", level, text }, true);
      },
    });
  }

  static async create(options: GatewayOptions): Promise<Gateway> {
    const gateway = new Gateway(options);
    await gateway.app.register(cors, { origin: options.corsOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"] });
    await gateway.app.register(websocket, { options: { maxPayload: 64 * 1024 } });
    // Front-end processes forward their clients' aborted requests (cluster/pool.ts).
    forwardLinkAborts(gateway.app);
    gateway.routes();
    await gateway.control.start();
    // The first series are listed before anyone can connect.
    if (gateway.derivatives !== null) await gateway.rollDerivatives();
    return gateway;
  }

  /** Starts listening; returns the base URL. Port 0 picks a free port. */
  async listen(port: number, host = "127.0.0.1"): Promise<string> {
    return this.app.listen({ port, host });
  }

  /**
   * Starts listening through `processes` front-end processes instead of this
   * one; returns the base URL. Port 0 picks a free port.
   *
   * The front-ends do the per-connection work (WebSocket framing, JSON,
   * validation, rate limits, serialization, market-data fan-out and the
   * socket writes); this process keeps everything stateful (sessions,
   * client order ids, accounts and risk, market control, surveillance,
   * volatility, derivatives, tournaments, the exchange). See cluster/pool.ts.
   * One front-end is allowed, but only for measuring what the link costs.
   */
  async listenFrontends(options: { port: number; host?: string; processes: number }): Promise<string> {
    if (this.pool !== null) throw new Error("already listening through front-end processes");
    const pool = new FrontendPool({
      app: this.app,
      market: this.market,
      rateLimit: this.rateLimit,
      traderFor: (token) => this.traders.get(token),
      attach: (session) => this.attach(session),
      detach: (session) => this.detach(session),
      dispatch: (session, message) => this.dispatch(session, message),
    });
    this.pool = pool;
    return pool.start({ port: options.port, host: options.host ?? "127.0.0.1", processes: options.processes });
  }

  /** Plain-English orders (POST /api/parse-order), or null when not enabled. */
  plainEnglishOrders(): PlainEnglishOrders | null {
    return this.plainEnglish;
  }

  /** Which front-ends hold the trader's connections, by front-end number (tests and diagnostics). */
  frontendsOf(traderId: string): number[] {
    return this.pool?.frontendsOf(traderId) ?? [];
  }

  /** The front-end processes' ids (empty in single-process mode). */
  frontendPids(): number[] {
    return this.pool?.pids() ?? [];
  }

  /**
   * Each front-end's CPU and event-loop use since the previous call, and its
   * open connections (empty in single-process mode). For load tests.
   */
  async frontendStats(): Promise<FrontendStats[]> {
    return this.pool?.stats() ?? [];
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    for (const timer of this.timeouts) clearTimeout(timer);
    this.plainEnglish?.close();
    await this.pool?.close();
    this.control.stop();
    this.unsubscribe();
    await this.app.close();
  }

  private every(ms: number, task: () => Promise<unknown>): void {
    const timer = setInterval(() => void task().catch(() => {}), ms);
    timer.unref();
    this.timers.push(timer);
  }

  private routes(): void {
    const app = this.app;

    app.post("/api/session", async (request, reply) => {
      const body = z
        .object({ name: z.string().trim().min(1).max(32), botKey: z.string().max(200).optional() })
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "name must be 1-32 characters" });
      const unlimited = this.botKey !== undefined && body.data.botKey === this.botKey;
      const trader: Trader = { id: `u${this.nextTrader++}`, name: body.data.name };
      const token = randomUUID();
      this.traders.set(token, trader);
      this.names.set(trader.id, trader.name);
      this.accounts.open(trader.id, unlimited);
      return { token, traderId: trader.id, name: trader.name };
    });

    // Compliance view: every active trader's latest assessment and the alert log.
    app.get("/api/surveillance", async (request, reply) => {
      if (this.monitor === null || this.surveillance === undefined) return reply.code(404).send({ error: "surveillance is not enabled" });
      if ((request.query as { key?: string }).key !== this.surveillance.adminKey) return reply.code(403).send({ error: "admin key required" });
      const named = (a: { traderId: string }) => ({ ...a, traderName: this.names.get(a.traderId) ?? a.traderId });
      const { trained_at, metrics, labels, thresholds } = this.surveillance.model.manifest;
      return {
        model: { trainedAt: trained_at, labels, metrics, thresholds },
        mode: this.monitor.mode,
        calibration: this.monitor.calibration(),
        current: this.monitor.current().map(named),
        alerts: this.monitor.history().slice(0, 100).map(named),
      };
    });

    // Shadow mode: score without alerting on known-honest traffic, then calibrate thresholds per symbol and go live.
    app.post("/api/surveillance/shadow", async (request, reply) => {
      if (this.monitor === null || this.surveillance === undefined) return reply.code(404).send({ error: "surveillance is not enabled" });
      if ((request.query as { key?: string }).key !== this.surveillance.adminKey) return reply.code(403).send({ error: "admin key required" });
      const action = (request.query as { action?: string }).action;
      if (action === "start") this.monitor.startShadow();
      else if (action === "finish") {
        const calibration = this.monitor.finishShadow();
        return { mode: this.monitor.mode, calibration };
      } else return reply.code(400).send({ error: "action must be start or finish" });
      return { mode: this.monitor.mode };
    });

    this.tournamentRoutes();

    app.get("/api/health", async () => ({ status: "ok", traders: this.traders.size, connections: this.connectionCount() }));
    app.get("/api/instruments", async () => [...this.instruments.values()]);
    app.get("/api/status", async () => this.control.all());

    // Which volatility model is running, and how it and the alternatives scored when it was trained.
    app.get("/api/volatility", async (_request, reply) => {
      if (this.volatility === null) return reply.code(404).send({ error: "volatility forecasting is not enabled" });
      const { trained_at, data, chosen, best_in_walk_forward, chosen_by, live_model, live_model_note, results } = this.volatility.manifest;
      return {
        model: {
          trainedAt: trained_at,
          data,
          chosen,
          bestInWalkForward: best_in_walk_forward,
          chosenBy: chosen_by,
          running: live_model,
          runningNote: live_model_note,
          results,
        },
        forecasts: [...this.instruments.values()]
          .filter((i) => instrumentKind(i) === "spot")
          .map(({ symbol }) => ({ symbol, forecast: this.volatility!.forecast(symbol) })),
      };
    });

    app.get("/api/account", async (request, reply) => {
      const trader = this.traders.get((request.query as { token?: string }).token ?? "");
      if (trader === undefined) return reply.code(401).send({ error: "unknown session token" });
      return this.accounts.snapshot(trader.id);
    });

    app.get("/api/book/:symbol", async (request, reply) => {
      const { symbol } = request.params as { symbol: string };
      if (!this.instruments.has(symbol)) return reply.code(404).send({ error: "unknown symbol" });
      const levels = Math.min(100, Math.max(1, Number((request.query as { levels?: string }).levels ?? 20) || 20));
      return { symbol, ...(await this.exchange.depth(symbol, levels)) };
    });

    app.get("/api/trades/:symbol", async (request, reply) => {
      const { symbol } = request.params as { symbol: string };
      if (!this.instruments.has(symbol)) return reply.code(404).send({ error: "unknown symbol" });
      return this.market.recentTrades(symbol);
    });

    app.get("/api/candles/:symbol", async (request, reply) => {
      const { symbol } = request.params as { symbol: string };
      const interval = ((request.query as { interval?: string }).interval ?? "1m") as Interval;
      if (!this.instruments.has(symbol)) return reply.code(404).send({ error: "unknown symbol" });
      if (!(interval in INTERVALS)) return reply.code(400).send({ error: `interval must be one of ${Object.keys(INTERVALS).join(", ")}` });
      return this.market.candleHistory(symbol, interval);
    });

    app.get("/ws", { websocket: true }, (socket, request) => {
      const token = (request.query as { token?: string }).token ?? "";
      const trader = this.traders.get(token);
      if (trader === undefined) {
        socket.close(4001, "unauthorized: create a session with POST /api/session");
        return;
      }
      const session = new Session(socket, trader, new TokenBucket(this.rateLimit.burst, this.rateLimit.perSecond, this.now));
      socket.on("message", (data: Buffer) => void this.handle(session, data.toString()));
      socket.on("close", () => this.detach(session));
      this.attach(session);
    });

    if (this.parseOrderOptions !== undefined) {
      this.plainEnglish = registerParseOrder(
        app,
        {
          traderFor: (token) => this.traders.get(token)?.id,
          instruments: () => this.instruments.values(),
          lastPrice: (symbol) => (this.instruments.has(symbol) ? this.control.referencePrice(symbol) : undefined),
          warnings: (traderId, symbol, order) => this.orderWarnings(traderId, symbol, order),
          now: this.now,
        },
        this.parseOrderOptions,
      );
    }
  }

  /** Binds an authenticated connection to its trader and sends it the current state. */
  private attach(session: SessionLike): void {
    const trader = session.trader;
    let set = this.sessions.get(trader.id);
    if (set === undefined) this.sessions.set(trader.id, (set = new Set()));
    set.add(session);
    session.deliver({ type: "welcome", traderId: trader.id, name: trader.name }, true);
    // Series roll while clients connect: one that read /api/instruments just before a roll would
    // otherwise miss the broadcast and keep showing an expired series.
    if (this.derivatives !== null) session.deliver({ type: "instruments", instruments: [...this.instruments.values()] }, true);
    for (const status of this.control.all()) session.deliver({ type: "status", ...status }, true);
    const account = this.accounts.snapshot(trader.id);
    if (account !== undefined) session.deliver({ type: "account", ...account }, true);
  }

  /** Forgets a closed connection. Its trader's orders stay, as on any disconnect. */
  private detach(session: SessionLike): void {
    const traderId = session.trader.id;
    this.sessions.get(traderId)?.delete(session);
    if (this.sessions.get(traderId)?.size === 0) this.sessions.delete(traderId);
    (session.channels ?? this.market).unsubscribeAll(session);
    this.unsubscribeBoards(session);
  }

  /**
   * Pre-trade hints for a plain-English proposal, from the same checks a real
   * order meets: the price band, the auction, buying power. They never block
   * the proposal; the order is checked again when it is really sent.
   */
  private async orderWarnings(traderId: string, symbol: string, order: ClientOrder): Promise<string[]> {
    const instrument = this.instruments.get(symbol);
    if (instrument === undefined) return [];
    const warnings: string[] = [];
    if (this.control.checkBand(symbol, order) === "price_outside_band") {
      warnings.push(`The exchange would refuse this price now: it is outside ${symbol}'s price band.`);
    }
    const status = this.control.status(symbol);
    const restingOnly = order.type === "market" || (order.type === "limit" && (order.timeInForce ?? "GTC") !== "GTC");
    if (status?.phase === "auction" && restingOnly) {
      warnings.push(`${symbol} is in a call auction: only good-till-cancelled limit and stop orders are accepted until it reopens.`);
    }
    const problem = this.accounts.checkOrder(traderId, instrument, order.side, order.quantity, await this.estimatePrice(symbol, order));
    if (problem === "insufficient_buying_power") warnings.push("Your buying power is not enough for this order right now.");
    else if (problem !== null) warnings.push(`The exchange would refuse this order now (${problem}).`);
    return warnings;
  }

  /**
   * Tournaments: anyone may list them and read a leaderboard; creating one
   * needs the admin key; joining needs the trader's session token.
   */
  private tournamentRoutes(): void {
    const app = this.app;
    const disabled = { error: "tournaments are not enabled" };

    app.get("/api/tournaments", async (_request, reply) => {
      if (this.tournaments === null) return reply.code(404).send(disabled);
      return this.tournaments.list(this.now());
    });

    app.post("/api/tournaments", async (request, reply) => {
      if (this.tournaments === null) return reply.code(404).send(disabled);
      if (this.adminKey === undefined || (request.query as { key?: string }).key !== this.adminKey) {
        return reply.code(403).send({ error: "admin key required" });
      }
      const body = z
        .object({
          name: z.string().trim().min(1).max(48),
          start: z.number().int().nonnegative(),
          end: z.number().int().positive(),
          startingCash: z.record(z.string().max(8), z.number().nonnegative().max(1e12)).optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        const issue = body.error.issues[0];
        return reply.code(400).send({ error: issue === undefined ? "invalid tournament" : `${issue.path.join(".") || "body"}: ${issue.message}` });
      }
      const { startingCash, ...rest } = body.data;
      const created = this.tournaments.create({ ...rest, ...(startingCash === undefined ? {} : { startingCash }) }, this.now());
      if ("error" in created) return reply.code(400).send({ error: created.error });
      return reply.code(201).send(created.tournament);
    });

    app.get("/api/tournaments/:id/leaderboard", async (request, reply) => {
      if (this.tournaments === null) return reply.code(404).send(disabled);
      const board = this.tournaments.leaderboard((request.params as { id: string }).id, this.now());
      return board === undefined ? reply.code(404).send({ error: "unknown tournament" }) : board;
    });

    app.post("/api/tournaments/:id/join", async (request, reply) => {
      if (this.tournaments === null) return reply.code(404).send(disabled);
      const token = (request.body as { token?: unknown } | null)?.token;
      const trader = typeof token === "string" ? this.traders.get(token) : undefined;
      if (trader === undefined) return reply.code(401).send({ error: "unknown_trader", message: "unknown session token" });
      const joined = this.tournaments.join((request.params as { id: string }).id, trader.id, this.now());
      if ("error" in joined) {
        return reply.code(joined.error === "unknown_tournament" ? 404 : 409).send({ error: joined.error, message: JOIN_ERRORS[joined.error] });
      }
      // The reset is pushed at once rather than with the next periodic update (a queued entry has none yet).
      if (!joined.queued) this.pushAccounts([trader.id]);
      this.pushBoard(joined.tournament.id);
      return joined;
    });
  }

  /** Subscribes to a "leaderboard:<id>" channel and sends the current standings; false for an unknown one. */
  private subscribeBoard(session: SessionLike, channel: string): boolean {
    const id = channel.slice("leaderboard:".length);
    const board = this.tournaments?.leaderboard(id, this.now());
    if (board === undefined) return false;
    let set = this.boards.get(id);
    if (set === undefined) this.boards.set(id, (set = new Set()));
    set.add(session);
    session.deliver({ type: "leaderboard", ...board }, false);
    return true;
  }

  private unsubscribeBoards(session: SessionLike, channels?: string[]): void {
    const ids = channels?.filter((c) => c.startsWith("leaderboard:")).map((c) => c.slice("leaderboard:".length)) ?? [...this.boards.keys()];
    for (const id of ids) {
      const set = this.boards.get(id);
      set?.delete(session);
      if (set?.size === 0) this.boards.delete(id);
    }
  }

  /**
   * Pushes fresh standings to every leaderboard channel with subscribers.
   * A finished tournament's are pushed once more (the frozen result), then
   * never again: they cannot change. New subscribers still get them on subscribing.
   */
  private async pushBoards(): Promise<void> {
    for (const id of [...this.boards.keys()]) if (!this.boardsFinal.has(id)) this.pushBoard(id);
  }

  private pushBoard(id: string): void {
    const subscribers = this.boards.get(id);
    if (subscribers === undefined) return;
    const board = this.tournaments?.leaderboard(id, this.now());
    // No longer kept (pruned): drop the channel.
    if (board === undefined) {
      this.boards.delete(id);
      this.boardsFinal.delete(id);
      return;
    }
    if (board.tournament.status === "finished") this.boardsFinal.add(id);
    const message: ServerMessage = { type: "leaderboard", ...board };
    for (const session of subscribers) session.deliver(message, false);
  }

  private async handle(session: SessionLike, text: string): Promise<void> {
    const parsed = parseClientMessage(text);
    if ("error" in parsed) {
      session.deliver(parsed.error, true);
      return;
    }
    await this.dispatch(session, parsed.message);
  }

  /** Acts on a validated message (front-end processes validate before forwarding). */
  private async dispatch(session: SessionLike, message: ClientMessage): Promise<void> {
    switch (message.op) {
      case "ping":
        session.deliver({ type: "pong", ...(message.reqId === undefined ? {} : { reqId: message.reqId }), time: this.now() }, true);
        return;
      case "subscribe": {
        const market = session.channels ?? this.market;
        const ok = message.channels.filter((c) =>
          c.startsWith("leaderboard:") ? this.tournaments !== null && this.subscribeBoard(session, c) : market.subscribe(session, c),
        );
        const bad = message.channels.filter((c) => !ok.includes(c));
        session.deliver({ type: "subscribed", channels: ok }, true);
        if (bad.length > 0) session.deliver({ type: "error", message: `unknown channels: ${bad.join(", ")}` }, true);
        return;
      }
      case "unsubscribe": {
        const market = session.channels ?? this.market;
        for (const c of message.channels) if (!c.startsWith("leaderboard:")) market.unsubscribe(session, c);
        this.unsubscribeBoards(session, message.channels);
        return;
      }
      default:
        await this.trade(session, message);
    }
  }

  private async trade(session: SessionLike, message: Extract<ClientMessage, { op: "order" | "cancel" | "amend" }>): Promise<void> {
    const { reqId, clientOrderId } = message;
    const reject = (reason: string) => session.deliver({ type: "reject", reqId, clientOrderId, reason }, true);

    if (!session.bucket.take()) return reject("rate_limited");
    // Commands from one connection reach the exchange in the order it sent
    // them: a cancel pipelined behind its own market order must not overtake
    // it while the order waits on its price estimate (or on surveillance).
    // Trades with nothing to wait for and nothing queued ahead skip this.
    const ahead = this.sendQueues.get(session);
    const waits = message.op === "order" && (message.order.type === "market" || this.monitor !== null);
    let sent = () => {};
    if (ahead !== undefined || waits) {
      const turn: Promise<void> = new Promise((resolve) => {
        sent = () => {
          if (this.sendQueues.get(session) === turn) this.sendQueues.delete(session);
          resolve();
        };
      });
      this.sendQueues.set(session, turn);
    }
    try {
      if (ahead !== undefined) await ahead;
      await this.checkAndSend(session, message, reject, sent);
    } finally {
      sent();
    }
  }

  private async checkAndSend(
    session: SessionLike,
    message: Extract<ClientMessage, { op: "order" | "cancel" | "amend" }>,
    reject: (reason: string) => void,
    sent: () => void,
  ): Promise<void> {
    const { reqId, symbol, clientOrderId } = message;
    const traderId = session.trader.id;
    // An entrant's account waits, flat, for the tournament to start; cancels have nothing to cancel.
    if (message.op !== "cancel" && this.tournaments?.locked(traderId, this.now()) === true) return reject("tournament_not_started");
    const instrument = this.instruments.get(symbol);
    if (instrument === undefined) return reject("unknown_symbol");
    if (this.expiring.has(symbol) || this.pastExpiry(instrument, message.op)) return reject("series_expired");
    // A derivative stops trading while its underlying is halted or in its opening auction: with no
    // price for the underlying nobody can value it (exchanges halt the derivatives along with the stock).
    if (instrument.underlying !== undefined && message.op !== "cancel" && this.control.status(instrument.underlying)?.phase === "auction") {
      return reject("underlying_in_auction");
    }
    const orderId = `${traderId}:${clientOrderId}`;

    let command: EngineCommand;
    let events: EngineEvent[];
    let reserved = false;
    try {
      if (message.op === "order") {
        const order = message.order;
        const invalid = this.checkIncrements(instrument, order) ?? this.control.checkBand(symbol, order);
        if (invalid !== null) return reject(invalid);
        // Only a market order's estimate needs the book; limit and stop orders go straight on.
        const estimated = order.type === "market" ? await this.estimatePrice(symbol, order) : restingPrice(order);
        const problem = this.accounts.checkOrder(traderId, instrument, order.side, order.quantity, estimated);
        if (problem !== null) return reject(problem);
        if (!this.rememberId(traderId, clientOrderId)) return reject("duplicate_client_order_id");
        // Counted as resting from here until the exchange answers, so orders
        // pipelined on one connection are checked against each other, not
        // each against an account that has not heard of the others yet.
        reserved = this.accounts.reserve(traderId, clientOrderId, symbol, order.side, estimated, order.quantity);
        const input = { ...order, id: orderId, traderId } as OrderInput;
        // Wash trades are blocked unless the client explicitly allows them.
        input.selfTrade ??= "cancel_taker";
        command = { type: "submit", order: input };
        // The surveillance models were trained on stock order books, not option chains.
        if (this.monitor !== null && order.type !== "stop" && instrumentKind(instrument) === "spot") {
          await this.watchOrder(this.monitor, traderId, symbol, orderId, order);
        }
      } else if (message.op === "cancel") {
        command = { type: "cancel", orderId };
      } else {
        if (message.price !== undefined && message.price % instrument.tickSize !== 0) return reject("invalid_tick_size");
        if (message.quantity !== undefined && message.quantity % instrument.lotSize !== 0) return reject("invalid_lot_size");
        const problem =
          (message.price === undefined ? null : this.control.checkBand(symbol, { type: "limit", price: message.price })) ??
          this.accounts.checkAmend(traderId, instrument, clientOrderId, message.price, message.quantity);
        if (problem !== null) return reject(problem);
        command = {
          type: "amend",
          orderId,
          changes: {
            ...(message.price === undefined ? {} : { price: message.price }),
            ...(message.quantity === undefined ? {} : { quantity: message.quantity }),
          },
        };
      }

      // Checked again with nothing awaited before the send: the clock may have
      // passed expiry during the checks above, and a series that finished
      // expiring meanwhile is gone from the exchange (which would only say
      // "unavailable").
      if (this.expiring.has(symbol) || !this.instruments.has(symbol) || this.pastExpiry(instrument, message.op)) return reject("series_expired");
      // Likewise the tournament lock: a join that arrived during the awaits above found no order in
      // flight (the reservation comes after the price estimate), so it reset the account and entered
      // an upcoming tournament. Sending now would trade before the bell.
      if (message.op !== "cancel" && this.tournaments?.locked(traderId, this.now()) === true) return reject("tournament_not_started");
      try {
        const answer = this.exchange.send(symbol, command);
        sent();
        events = await answer;
      } catch {
        return reject("unavailable");
      }
    } finally {
      // Every event the order caused has been applied by now (the exchange
      // routes them before it answers), so a reservation still held is for an
      // order that never came to rest: filled, refused, or not sent at all.
      if (reserved) this.accounts.release(traderId, clientOrderId);
    }
    const first = events[0];
    if (first?.type === "rejected") return reject(first.reason);
    session.deliver({ type: "ack", reqId, clientOrderId }, true);
  }

  /**
   * Whether a derivative's expiry instant has passed. From then on the
   * settlement price is fixed by the underlying's tape, so a trade would be
   * a bet on a known outcome: new orders and amends are refused at once,
   * not when the roll timer next comes round. Cancels may still go ahead
   * until the series starts expiring.
   */
  private pastExpiry(instrument: Instrument, op: "order" | "cancel" | "amend"): boolean {
    return op !== "cancel" && instrument.expiry !== undefined && instrument.expiry <= this.now();
  }

  /** Tells surveillance about an arriving order, measured against the book as it stands. */
  private async watchOrder(monitor: SurveillanceMonitor, traderId: string, symbol: string, orderId: string, order: ClientOrder): Promise<void> {
    const price = order.type === "limit" ? order.price : null;
    const book = price === null ? { bids: [], asks: [] } : await this.exchange.depth(symbol, TOUCH_LEVELS);
    monitor.order(traderId, symbol, orderId, this.now(), order.side, price, order.quantity, book);
  }

  /** The price an order is risk-checked at: its limit, or the far touch plus slippage for market orders. */
  private async estimatePrice(symbol: string, order: ClientOrder): Promise<number> {
    if (order.type !== "market") return restingPrice(order);
    const depth = await this.exchange.depth(symbol, 1);
    const touch = (order.side === "buy" ? depth.asks[0] : depth.bids[0])?.price ?? this.control.referencePrice(symbol);
    return touch * (order.side === "buy" ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE);
  }

  private checkIncrements(instrument: Instrument, order: ClientOrder): string | null {
    const prices = [
      order.type === "limit" ? order.price : undefined,
      order.type === "stop" ? order.stopPrice : undefined,
      order.type === "stop" ? order.limitPrice : undefined,
    ];
    if (prices.some((p) => p !== undefined && p % instrument.tickSize !== 0)) return "invalid_tick_size";
    const quantities = [order.quantity, order.type === "limit" ? order.displayQuantity : undefined];
    if (quantities.some((q) => q !== undefined && q % instrument.lotSize !== 0)) return "invalid_lot_size";
    return null;
  }

  /** Records a client order id for the trader; false if it was already used this session. */
  private rememberId(traderId: string, clientOrderId: string): boolean {
    let used = this.usedIds.get(traderId);
    if (used === undefined) this.usedIds.set(traderId, (used = new Set()));
    if (used.has(clientOrderId)) return false;
    used.add(clientOrderId);
    // Bounded memory: forget the oldest ids (Sets iterate in insertion order).
    if (used.size > MAX_REMEMBERED_IDS) used.delete(used.values().next().value!);
    return true;
  }

  /** Turns engine events into public market data, private execution reports, and account updates. */
  private route(symbol: string, events: EngineEvent[]): void {
    const time = this.now();
    // A tournament that has ended is frozen before these events can touch its entrants' equity.
    this.tournaments?.advance(time);
    // Surveillance watches stock books only (see trade()).
    const monitor = this.derivatives?.has(symbol) === true ? null : this.monitor;
    for (const e of events) {
      switch (e.type) {
        case "trade":
          this.market.recordTrade(symbol, { id: e.seq, price: e.price, quantity: e.quantity, side: e.takerSide, time });
          this.derivatives?.onTrade(symbol, e.price, e.quantity, time);
          // A trade that completes a minute bar updates the forecast first, so the
          // breaker check that follows uses the latest limits.
          if (this.volatility?.trade(symbol, e.price, time) === true) this.control.republish(symbol);
          this.control.onTrade(symbol, e.price, time);
          monitor?.fill(e.takerTraderId, symbol, e.takerOrderId, time, e.takerSide, e.quantity, "taker", e.makerTraderId);
          monitor?.fill(e.makerTraderId, symbol, e.makerOrderId, time, e.takerSide === "buy" ? "sell" : "buy", e.quantity, "maker", e.takerTraderId);
          this.report(e.takerOrderId, symbol, time, {
            event: "fill",
            side: e.takerSide,
            price: e.price,
            quantity: e.quantity,
            liquidity: "taker",
          });
          this.report(e.makerOrderId, symbol, time, {
            event: "fill",
            side: e.takerSide === "buy" ? "sell" : "buy",
            price: e.price,
            quantity: e.quantity,
            liquidity: "maker",
          });
          break;
        case "accepted":
          this.report(e.orderId, symbol, time, { event: "accepted" });
          break;
        case "rejected":
          this.report(e.orderId, symbol, time, { event: "rejected", reason: e.reason });
          break;
        case "rested": {
          this.market.markDirty(symbol);
          const who = owner(e.orderId);
          if (who !== null) monitor?.rested(who.traderId, symbol, e.orderId, e.quantity);
          this.report(e.orderId, symbol, time, {
            event: "rested",
            side: e.side,
            price: e.price,
            quantity: e.quantity,
            visible: e.visible,
          });
          break;
        }
        case "cancelled": {
          this.market.markDirty(symbol);
          // Only a trader's own cancels matter to surveillance; IOC remainders and the like just leave the book.
          const who = owner(e.orderId);
          if (who !== null && e.reason === "user") monitor?.cancelled(who.traderId, symbol, e.orderId, time);
          else monitor?.removed(e.orderId);
          const reason = this.expiryCancels.delete(e.orderId) ? "expired" : e.reason;
          this.report(e.orderId, symbol, time, { event: "cancelled", remaining: e.remaining, reason });
          break;
        }
        case "amended":
          this.market.markDirty(symbol);
          this.report(e.orderId, symbol, time, {
            event: "amended",
            price: e.price,
            quantity: e.quantity,
            keptPriority: e.keptPriority,
          });
          break;
        case "stop_pending":
          this.report(e.orderId, symbol, time, { event: "stop_pending", side: e.side, stopPrice: e.stopPrice, quantity: e.quantity });
          break;
        case "triggered":
          this.report(e.orderId, symbol, time, { event: "triggered", lastPrice: e.lastPrice });
          break;
        case "phase":
          this.market.markDirty(symbol);
          this.control.onPhase(symbol, e.phase, e.price);
          break;
      }
    }
  }

  private report(orderId: string, symbol: string, time: number, execution: Execution): void {
    const who = owner(orderId);
    if (who === null) return;
    this.accounts.onExecution(who.traderId, who.clientOrderId, symbol, execution);
    if (execution.event === "fill") this.tournaments?.onFill(who.traderId, time);
    this.dirtyAccounts.add(who.traderId);
    const sessions = this.sessions.get(who.traderId);
    if (sessions === undefined) return;
    const message = { type: "execution", symbol, clientOrderId: who.clientOrderId, time, ...execution } as ServerMessage;
    for (const session of sessions) session.deliver(message, true);
  }

  private pushAccounts(traderIds: string[]): void {
    for (const traderId of traderIds) {
      this.dirtyAccounts.delete(traderId);
      const sessions = this.sessions.get(traderId);
      const snapshot = sessions === undefined ? undefined : this.accounts.snapshot(traderId);
      if (sessions === undefined || snapshot === undefined) continue;
      // One object for all of the trader's connections, so it is serialized once.
      const message: ServerMessage = { type: "account", ...snapshot };
      for (const session of sessions) session.deliver(message, false);
    }
  }

  /**
   * Closes out accounts in breach of margin: cancel their resting orders, then
   * close every position with a market order. Runs once a second; an account
   * still in breach afterwards (say, during an auction, when market orders are
   * refused) is simply tried again.
   */
  private async liquidate(): Promise<void> {
    for (const breach of this.accounts.breaches()) {
      if (this.liquidating.has(breach.traderId)) continue;
      this.liquidating.add(breach.traderId);
      try {
        this.accounts.markLiquidated(breach.traderId);
        for (const { symbol, clientOrderId } of breach.cancel) {
          await this.exchange.send(symbol, { type: "cancel", orderId: `${breach.traderId}:${clientOrderId}` });
        }
        for (const { symbol, side, quantity } of breach.close) {
          // An expired series is about to be settled in cash instead.
          const instrument = this.instruments.get(symbol);
          if (instrument === undefined || this.expiring.has(symbol) || this.pastExpiry(instrument, "order")) continue;
          await this.closeAtMarket(breach.traderId, symbol, side, quantity);
        }
        const notice = { type: "notice", level: "warning", text: "Margin breach: open orders cancelled and positions closed at market." } as const;
        for (const session of this.sessions.get(breach.traderId) ?? []) session.deliver(notice, true);
      } finally {
        this.liquidating.delete(breach.traderId);
      }
    }
  }

  private async closeAtMarket(traderId: string, symbol: string, side: Side, quantity: number): Promise<void> {
    const id = `${traderId}:liq-${this.nextLiquidation++}`;
    await this.exchange.send(symbol, {
      type: "submit",
      order: { type: "market", id, traderId, side, quantity, selfTrade: "cancel_taker" },
    });
  }

  /**
   * Expires every series whose time has come, then lists a new series for
   * each underlying left without one. Runs on a timer; tests drive it through
   * an injected clock.
   */
  private async rollDerivatives(): Promise<void> {
    const derivatives = this.derivatives;
    if (derivatives === null || this.rolling) return;
    this.rolling = true;
    try {
      const due = derivatives.due();
      // The whole set stops at once: the later series must not stay open while the earlier ones are settled.
      for (const instrument of due) this.expiring.add(instrument.symbol);
      for (const instrument of due) await this.expire(instrument);
      const listed = derivatives.plan(this.instruments);
      if (listed.length > 0) {
        await this.exchange.list(listed.map((i) => i.symbol));
        for (const instrument of listed) {
          this.instruments.set(instrument.symbol, instrument);
          this.market.add(instrument.symbol);
          this.control.add(instrument);
        }
      }
      if (due.length > 0 || listed.length > 0) this.broadcast({ type: "instruments", instruments: [...this.instruments.values()] });
    } finally {
      this.rolling = false;
    }
  }

  /**
   * Expiry, in order: stop trading the series, cancel everything resting on
   * it, settle every position in cash at the final settlement price, tell
   * the traders concerned, and remove the book.
   */
  private async expire(instrument: Instrument): Promise<void> {
    const symbol = instrument.symbol;
    // From here every request for the series is refused (see trade()).
    this.expiring.add(symbol);
    // The snapshot request queues behind every command already sent for this
    // book, so once it is answered nothing more can come to rest on it.
    const book = await this.exchange.snapshot(symbol);
    const resting = [...book.bids, ...book.asks, ...book.stops].map((o) => o.id);
    for (const id of resting) this.expiryCancels.add(id);
    await Promise.all(resting.map((orderId) => this.exchange.send(symbol, { type: "cancel", orderId })));

    const { price, basis } = this.derivatives!.settlement(instrument);
    const time = this.now();
    // Settlement changes accounts without any engine event, so route() would not freeze a tournament
    // that has ended: done here, a series expiring on a tournament's end is never part of its result,
    // whether or not orders resting on it were cancelled (and routed) first.
    this.tournaments?.advance(time);
    const how = {
      vwap: `the average ${instrument.underlying} price over its last minute`,
      last_trade: `${instrument.underlying}'s last trade: it did not trade in the last minute`,
      reference: `${instrument.underlying}'s reference price: it never traded`,
    }[basis];
    for (const { traderId, quantity, amount } of this.accounts.settle(symbol, price)) {
      this.dirtyAccounts.add(traderId);
      const settlement = { type: "settlement", symbol, price, basis, quantity, amount, currency: instrument.currency, time } as const;
      const contracts = `${quantity} contract${Math.abs(quantity) === 1 ? "" : "s"}`;
      const text =
        `${symbol} expired and settled at ${formatPrice(instrument, price)} (${how}): ` +
        `${contracts}, ${amount >= 0 ? "+" : ""}${amount.toFixed(2)} ${instrument.currency}.`;
      for (const session of this.sessions.get(traderId) ?? []) {
        session.deliver(settlement, true);
        session.deliver({ type: "notice", level: "info", text }, true);
      }
    }

    this.instruments.delete(symbol);
    this.pool?.channelsGone(this.market.remove(symbol));
    this.control.remove(symbol);
    this.derivatives!.remove(symbol);
    await this.exchange.delist([symbol]);
    this.expiring.delete(symbol);
    for (const id of resting) this.expiryCancels.delete(id);
  }

  private broadcast(message: ServerMessage): void {
    for (const set of this.sessions.values()) for (const session of set) if (session.remote !== true) session.deliver(message, true);
    this.pool?.broadcast(message);
  }

  private connectionCount(): number {
    let n = 0;
    for (const set of this.sessions.values()) n += set.size;
    return n;
  }
}

export type { MarketStatus };
