import type {
  ClientMessage,
  ClientOrder,
  Instrument,
  Leaderboard,
  MessageOf,
  ParseMode,
  ParseOrderReply,
  ParseOrderStatus,
  RequestResult,
  ServerMessage,
  Tournament,
} from "./types.ts";

type Listener = (message: ServerMessage) => void;

export interface ConnectOptions {
  /** Defaults to 10 seconds. */
  requestTimeoutMs?: number;
  /** The gateway's bot key: grants an unlimited (market-maker) account. */
  botKey?: string;
}

/** The answer to joining a tournament: the tournament, or the rule that refused the trader. */
/**
 * A join's outcome. `queued`: the trader is still in a tournament that ends by
 * this one's start, so the entry (and the account reset) happens at that end.
 */
export type JoinResult = { ok: true; tournament: Tournament; queued: boolean } | { ok: false; error: string; message: string };

/**
 * Typed client for the exchange gateway. Uses only the standard `fetch` and
 * `WebSocket` globals, so it runs unchanged in browsers and in Node 22+.
 */
export class TradingClient {
  private readonly listeners = new Set<Listener>();
  private readonly closeListeners = new Set<() => void>();
  private readonly pending = new Map<string, { resolve: (r: RequestResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextReq = 1;
  private nextOrder = 1;

  private constructor(
    readonly baseUrl: string,
    readonly traderId: string,
    readonly name: string,
    /** The session token: it identifies this trader to the REST API (joining a tournament). */
    private readonly token: string,
    private readonly socket: WebSocket,
    private readonly requestTimeoutMs: number,
  ) {
    socket.addEventListener("message", (event) => this.receive(JSON.parse(String(event.data)) as ServerMessage));
    socket.addEventListener("close", () => {
      for (const [reqId, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ type: "error", reqId, message: "connection closed" });
      }
      this.pending.clear();
      for (const listener of this.closeListeners) listener();
    });
  }

  /** Creates a trading session named `name` and opens its WebSocket. */
  static async connect(baseUrl: string, name: string, options: ConnectOptions = {}): Promise<TradingClient> {
    const response = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.botKey === undefined ? { name } : { name, botKey: options.botKey }),
    });
    if (!response.ok) throw new Error(`session failed: ${response.status}`);
    const { token, traderId } = (await response.json()) as { token: string; traderId: string };
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${baseUrl}`)), { once: true });
    });
    return new TradingClient(baseUrl, traderId, name, token, socket, options.requestTimeoutMs ?? 10_000);
  }

  static async instruments(baseUrl: string): Promise<Instrument[]> {
    return (await fetch(`${baseUrl}/api/instruments`)).json() as Promise<Instrument[]>;
  }

  /** Every tournament the gateway knows: upcoming, live, and recently finished. */
  static async tournaments(baseUrl: string): Promise<Tournament[]> {
    const response = await fetch(`${baseUrl}/api/tournaments`);
    if (!response.ok) throw new Error(`tournaments failed: ${response.status}`);
    return response.json() as Promise<Tournament[]>;
  }

  /** A tournament's standings; null if the gateway does not know it (or no longer keeps it). */
  static async leaderboard(baseUrl: string, tournamentId: string): Promise<Leaderboard | null> {
    const response = await fetch(`${baseUrl}/api/tournaments/${encodeURIComponent(tournamentId)}/leaderboard`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`leaderboard failed: ${response.status}`);
    return response.json() as Promise<Leaderboard>;
  }

  /**
   * Enters this trader in a tournament. The gateway resets the account to the
   * tournament's starting cash, so it refuses a trader holding positions or orders.
   */
  async joinTournament(tournamentId: string): Promise<JoinResult> {
    const response = await fetch(`${this.baseUrl}/api/tournaments/${encodeURIComponent(tournamentId)}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: this.token }),
    });
    const body = (await response.json()) as { tournament?: Tournament; queued?: boolean; error?: string; message?: string };
    if (response.ok && body.tournament !== undefined) return { ok: true, tournament: body.tournament, queued: body.queued === true };
    return { ok: false, error: body.error ?? `http_${response.status}`, message: body.message ?? `The gateway answered ${response.status}.` };
  }

  /**
   * Reads a plain-English order ("buy 10 tcs at 4100") into a proposal. It
   * never places anything: show the proposal, and send it yourself only once
   * the user has confirmed it.
   */
  parseOrder(text: string, options: { mode?: ParseMode; signal?: AbortSignal } = {}): Promise<ParseOrderReply> {
    return parsePlainEnglish(this.baseUrl, this.token, text, options);
  }

  /** Whether the gateway reads plain-English orders, and how its model is doing; null when it does not. */
  static async parseOrderStatus(baseUrl: string): Promise<ParseOrderStatus | null> {
    const response = await fetch(`${baseUrl}/api/parse-order`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`parse-order status failed: ${response.status}`);
    return response.json() as Promise<ParseOrderStatus>;
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** Every server message. Returns an unsubscribe function. */
  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called once when the connection closes, for whatever reason. Returns an unsubscribe function. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Messages of one type, typed. Returns an unsubscribe function. */
  on<T extends ServerMessage["type"]>(type: T, listener: (message: MessageOf<T>) => void): () => void {
    return this.onMessage((m) => {
      if (m.type === type) listener(m as MessageOf<T>);
    });
  }

  subscribe(channels: string[]): void {
    this.send({ op: "subscribe", channels });
  }

  unsubscribe(channels: string[]): void {
    this.send({ op: "unsubscribe", channels });
  }

  /** A client order id unique within this client's session. */
  newOrderId(prefix = "o"): string {
    return `${prefix}${Date.now().toString(36)}${(this.nextOrder++).toString(36)}`;
  }

  placeOrder(symbol: string, clientOrderId: string, order: ClientOrder): Promise<RequestResult> {
    return this.request({ op: "order", symbol, clientOrderId, order });
  }

  cancel(symbol: string, clientOrderId: string): Promise<RequestResult> {
    return this.request({ op: "cancel", symbol, clientOrderId });
  }

  amend(symbol: string, clientOrderId: string, changes: { price?: number; quantity?: number }): Promise<RequestResult> {
    return this.request({ op: "amend", symbol, clientOrderId, ...changes });
  }

  close(): void {
    this.socket.close();
  }

  private request(message: DistributiveOmit<Extract<ClientMessage, { reqId: string | number }>, "reqId">): Promise<RequestResult> {
    const reqId = `q${this.nextReq++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ type: "error", reqId, message: "request timed out" });
      }, this.requestTimeoutMs);
      this.pending.set(reqId, { resolve, timer });
      this.send({ ...message, reqId } as ClientMessage);
    });
  }

  private send(message: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private receive(message: ServerMessage): void {
    if ((message.type === "ack" || message.type === "reject" || message.type === "error") && message.reqId !== undefined) {
      const key = String(message.reqId);
      const pending = this.pending.get(key);
      if (pending !== undefined) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
    for (const listener of this.listeners) listener(message);
  }
}

/**
 * POST /api/parse-order as a session. Gateway answers come back as they are
 * (200, and 503 with kind "error"); anything that stopped the request before
 * the parser becomes kind "failed". Rethrows an AbortError: the caller cancelled.
 */
export async function parsePlainEnglish(
  baseUrl: string,
  token: string,
  text: string,
  options: { mode?: ParseMode; signal?: AbortSignal } = {},
): Promise<ParseOrderReply> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/parse-order`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(options.mode === undefined ? { text } : { text, mode: options.mode }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { kind: "failed", status: null, message: "cannot reach the gateway" };
  }
  type Body = { kind?: unknown; error?: unknown; retryAfterMs?: unknown };
  let body = null as Body | null;
  try {
    body = (await response.json()) as Body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // Not JSON (e.g. a proxy's error page): reported by status below.
  }
  if (body !== null && (response.status === 200 || (response.status === 503 && body.kind === "error"))) return body as ParseOrderReply;
  const header = Number(response.headers.get("retry-after"));
  const retryAfterMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
  return {
    kind: "failed",
    status: response.status,
    message: typeof body?.error === "string" ? body.error : `HTTP ${response.status}`,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
