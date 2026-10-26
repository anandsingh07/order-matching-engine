import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { SessionLike, Trader } from "../gateway.js";
import type { MarketData, MarketSubscriptions, Subscriber } from "../market-data.js";
import { serialize } from "../outbound.js";
import type { ClientMessage, ServerMessage } from "../protocol.js";
import * as wire from "./wire.js";

// Multi-process mode (GATEWAY_PROCESSES=N): N front-end processes in front of
// this one, the core.
//
//   clients --TCP--> core: accepts each connection, hands it to a front-end
//                    front-end (frontend.ts): WebSocket, HTTP, JSON, zod,
//                      per-connection rate limits, serialization, market-data
//                      fan-out, the socket writes
//                    core <--link (wire.ts)--> each front-end
//                    core: sessions, ids, accounts, risk, market control,
//                      surveillance, volatility, derivatives, tournaments,
//                      the exchange (unchanged Gateway logic)
//
// Profiling the single process put most of its main thread in exactly the
// per-connection work, which parallelises; the stateful work stays in one
// event loop, so ordering, duplicate ids and risk are exactly as before.
// This is how exchanges are built: many session gateways in front of one
// sequencer, reports routed back to the gateway that owns the session, and
// market data fanned out at the edge.
//
// Accepting: Windows has no SO_REUSEPORT, and Node's cluster module there
// put 30 of 30 connections on one worker under its default policy. So the
// core listens itself, with pauseOnConnect, and hands each socket to the
// front-end with the fewest open connections over the child_process channel
// (about 2 ms per connection, measured), which works the same everywhere.

export interface CoreHooks {
  app: FastifyInstance;
  market: MarketData;
  rateLimit: { burst: number; perSecond: number };
  traderFor(token: string): Trader | undefined;
  attach(session: SessionLike): void;
  detach(session: SessionLike): void;
  dispatch(session: SessionLike, message: ClientMessage): Promise<void>;
}

export interface FrontendStats {
  id: number;
  pid: number;
  /** Main-thread CPU since the previous stats call. */
  cpuMs: number;
  /** Event-loop utilisation since the previous stats call, 0-1. */
  elu: number;
  connections: number;
  /** Average records per link frame the front-end sent. */
  recordsPerFrame: number;
}

/** Above this much unsent on a link, market data and account pushes for its front-end are dropped... */
const LINK_SOFT_LIMIT = 8 << 20;
/** ...and above this the front-end is treated as stuck: restarted, its clients disconnected. */
const LINK_HARD_LIMIT = 64 << 20;
/** WebSocket frames larger than this are refused, as in single-process mode. */
const MAX_PAYLOAD = 64 * 1024;
const RESPAWN_MS = 500;

const ALWAYS = { take: () => true };
const bootstrap = fileURLToPath(new URL("./frontend-bootstrap.mjs", import.meta.url));

/** A connection held by a front-end, as the gateway's logic sees it. */
class RemoteSession implements SessionLike {
  readonly bucket = ALWAYS;
  readonly remote = true;
  readonly channels: MarketSubscriptions;

  constructor(
    readonly frontend: Frontend,
    readonly conn: number,
    readonly trader: Trader,
  ) {
    this.channels = frontend.channels;
  }

  deliver(message: ServerMessage, essential: boolean): void {
    const link = this.frontend.usable(essential);
    if (link === null) return;
    if (wire.isBinaryReply(message)) wire.writeReply(link.begin(wire.replyKind(message)), this.conn, message);
    else {
      const w = link.begin(wire.MESSAGE);
      w.u32(this.conn);
      w.u8(essential ? 1 : 0);
      w.str(serialize(message));
    }
  }
}

/**
 * One front-end's view of market data. The front-end subscribes once per
 * channel, however many of its clients want it, so each trade or book
 * update crosses the link once per front-end and is fanned out there. The
 * core keeps which connections want which channel, so a connection gets a
 * channel's state (sendState) and then, in the same turn, is added to the
 * front-end's fan-out set: the link is FIFO, so it sees no gap and no
 * duplicate, exactly as with add-then-send in one process.
 */
class FrontendChannels implements MarketSubscriptions {
  private readonly channels = new Map<string, { proxy: Subscriber; conns: Set<number> }>();

  constructor(
    private readonly market: MarketData,
    private readonly frontend: Frontend,
  ) {}

  subscribe(subscriber: Subscriber, name: string): boolean {
    const session = subscriber as RemoteSession;
    if (this.market.parse(name) === null) return false;
    let entry = this.channels.get(name);
    if (entry === undefined) {
      const proxy: Subscriber = { deliver: (message) => this.frontend.publish(name, message) };
      this.market.subscribe(proxy, name, { initial: false });
      this.channels.set(name, (entry = { proxy, conns: new Set() }));
    }
    this.market.sendState(session, name);
    if (!entry.conns.has(session.conn)) {
      entry.conns.add(session.conn);
      this.frontend.channelRecord(wire.CHANNEL_ADD, session.conn, name);
    }
    return true;
  }

  unsubscribe(subscriber: Subscriber, name: string): void {
    const session = subscriber as RemoteSession;
    const entry = this.channels.get(name);
    if (entry === undefined || !entry.conns.delete(session.conn)) return;
    this.frontend.channelRecord(wire.CHANNEL_REMOVE, session.conn, name);
    this.dropIfEmpty(name, entry);
  }

  /** The connection closed: its front-end has already forgotten it. */
  unsubscribeAll(subscriber: Subscriber): void {
    const session = subscriber as RemoteSession;
    for (const [name, entry] of this.channels) if (entry.conns.delete(session.conn)) this.dropIfEmpty(name, entry);
  }

  /** Channels of a delisted symbol: MarketData has already dropped their subscribers. */
  gone(names: string[]): void {
    for (const name of names) {
      if (!this.channels.delete(name)) continue;
      const link = this.frontend.usable(true);
      if (link !== null) link.begin(wire.CHANNEL_GONE).str(name);
    }
  }

  clear(): void {
    for (const [name, entry] of this.channels) this.market.unsubscribe(entry.proxy, name);
    this.channels.clear();
  }

  private dropIfEmpty(name: string, entry: { proxy: Subscriber; conns: Set<number> }): void {
    if (entry.conns.size > 0) return;
    this.market.unsubscribe(entry.proxy, name);
    this.channels.delete(name);
  }
}

class Frontend {
  link: wire.Link | null = null;
  readonly sessions = new Map<number, RemoteSession>();
  readonly channels: FrontendChannels;
  /** Sockets handed over and not yet closed. */
  connections = 0;
  readonly rpcs = new Map<number, AbortController>();
  readonly secret = randomBytes(32).toString("hex");
  private readonly rpcNonce = randomBytes(12).toString("hex");
  private readonly statsReplies: ((stats: FrontendStats) => void)[] = [];

  constructor(
    readonly id: number,
    readonly child: ChildProcess,
    readonly pool: FrontendPool,
  ) {
    this.channels = new FrontendChannels(pool.hooks.market, this);
    child.on("message", (m: { t: string } & Partial<FrontendStats>) => {
      if (m.t === "gone") this.connections = Math.max(0, this.connections - 1);
      else if (m.t === "stats") {
        this.statsReplies.shift()?.({ ...(m as FrontendStats), id: this.id, pid: child.pid ?? 0 });
      }
    });
  }

  /** The link, if this front-end can take a record now: market data is dropped first when the link backs up. */
  usable(essential: boolean): wire.Link | null {
    const link = this.link;
    if (link === null) return null;
    const unsent = link.socket.writableLength;
    if (unsent > LINK_HARD_LIMIT) {
      this.pool.failed(this, "its link backed up");
      return null;
    }
    return !essential && unsent > LINK_SOFT_LIMIT ? null : link;
  }

  publish(channel: string, message: ServerMessage): void {
    const link = this.usable(false);
    if (link === null) return;
    const w = link.begin(wire.CHANNEL);
    w.str(channel);
    w.str(serialize(message));
  }

  channelRecord(kind: number, conn: number, channel: string): void {
    const link = this.usable(true);
    if (link === null) return;
    const w = link.begin(kind);
    w.u32(conn);
    w.str(channel);
  }

  stats(): Promise<FrontendStats> {
    return new Promise((resolve) => {
      // The front-end answers in order, so overlapping calls each get their own reply.
      this.statsReplies.push(resolve);
      this.child.send({ t: "stats" });
    });
  }

  /**
   * Runs a core hook for one record. The record is already read, so a hook
   * that throws is a bug in that one message, not a corrupt link: it is
   * logged, and the front-end and its other clients carry on.
   */
  private guard(what: string, run: () => void | Promise<void>): void {
    const failed = (error: unknown) => console.error(`Gateway front-end ${this.id}: ${what} failed:`, error);
    try {
      const running = run();
      if (running instanceof Promise) running.catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /** Called with each record from the front-end once it has said HELLO. */
  receive(r: wire.Reader, kind: number): void {
    const hooks = this.pool.hooks;
    switch (kind) {
      case wire.ATTACH: {
        const conn = r.u32();
        const trader = hooks.traderFor(r.str());
        if (trader !== undefined) {
          const session = new RemoteSession(this, conn, trader);
          this.sessions.set(conn, session);
          // Before ATTACHED, so welcome, status and account precede the front-end's own
          // replies (pong, validation errors) to messages it held until now, as in one process.
          this.guard("attach", () => hooks.attach(session));
        }
        const w = this.link!.begin(wire.ATTACHED);
        w.u32(conn);
        w.u8(trader === undefined ? 0 : 1);
        return;
      }
      case wire.DETACH: {
        const session = this.sessions.get(r.u32());
        if (session === undefined) return;
        this.sessions.delete(session.conn);
        this.guard("detach", () => hooks.detach(session));
        return;
      }
      case wire.ORDER:
      case wire.CANCEL:
      case wire.AMEND: {
        const { conn, message } = wire.readTrade(r, kind);
        const session = this.sessions.get(conn);
        if (session !== undefined) this.guard(message.op, () => hooks.dispatch(session, message));
        return;
      }
      case wire.SUBSCRIBE:
      case wire.UNSUBSCRIBE: {
        const session = this.sessions.get(r.u32());
        const channels: string[] = [];
        for (let n = r.u32(); n > 0; n--) channels.push(r.str());
        if (session !== undefined) this.guard("subscription", () => hooks.dispatch(session, { op: kind === wire.SUBSCRIBE ? "subscribe" : "unsubscribe", channels }));
        return;
      }
      case wire.HTTP: {
        const id = r.u32();
        const method = r.str();
        const url = r.str();
        const headers = JSON.parse(r.str()) as Record<string, string>;
        const body = r.u8() === 0 ? undefined : r.str();
        this.inject(id, method, url, headers, body);
        return;
      }
      case wire.HTTP_ABORT:
        this.rpcs.get(r.u32())?.abort();
        return;
      default:
        throw new Error(`unexpected link record ${kind}`);
    }
  }

  /** REST: every route keeps its one implementation, in the core's Fastify app (~0.1 ms per request through inject). */
  private inject(id: number, method: string, url: string, headers: Record<string, string>, body: string | undefined): void {
    const controller = new AbortController();
    this.rpcs.set(id, controller);
    // Tags the request so forwardLinkAborts can find it; replaces any such header a client sent.
    const key = `${this.rpcNonce}:${id}`;
    linkRpcs.set(key, controller.signal);
    headers[LINK_RPC_HEADER] = key;
    const reply = (status: number, replyHeaders: object, text: string) => {
      this.rpcs.delete(id);
      linkRpcs.delete(key);
      // Aborted: the front-end has forgotten the request already.
      if (controller.signal.aborted) return;
      const link = this.usable(true);
      if (link === null) return;
      const w = link.begin(wire.HTTP_REPLY);
      w.u32(id);
      w.u32(status);
      w.str(JSON.stringify(replyHeaders));
      w.str(text);
    };
    this.pool.hooks.app
      .inject({
        method: method as "GET",
        url,
        headers,
        ...(body === undefined ? {} : { payload: body }),
      })
      .then(
        (res) => reply(res.statusCode, res.headers, res.body),
        () => reply(502, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "request failed" })),
      );
  }

  /** Forgets everything this front-end held: its connections are gone. */
  reset(): void {
    this.link?.socket.destroy();
    this.link = null;
    for (const session of this.sessions.values()) this.pool.hooks.detach(session);
    this.sessions.clear();
    this.channels.clear();
    for (const controller of this.rpcs.values()) controller.abort();
    this.rpcs.clear();
    this.connections = 0;
    for (const resolve of this.statsReplies.splice(0)) resolve({ id: this.id, pid: this.child.pid ?? 0, cpuMs: 0, elu: 0, connections: 0, recordsPerFrame: 0 });
  }
}

/**
 * Requests injected for a front-end, by the LINK_RPC_HEADER value they carry.
 * A client that gives up mid-request (a plain-English parse waiting on the
 * model, say) must stop the route's work in the core as it would in one
 * process. Aborting app.inject's own `signal` does not: light-my-request
 * ignores it once the body has been read, and the reply's "close", which
 * routes such as /api/parse-order watch, fires only after the answer.
 */
const LINK_RPC_HEADER = "x-ome-link-rpc";
const linkRpcs = new Map<string, AbortSignal>();

/**
 * Registered on the core's app (Gateway.create): when the front-end forwards
 * an abort, the injected reply is destroyed, so its "close" fires before an
 * answer was written, exactly as when a real client's connection drops.
 */
export function forwardLinkAborts(app: FastifyInstance): void {
  app.addHook("onRequest", (request, reply, done) => {
    const key = request.headers[LINK_RPC_HEADER];
    if (key !== undefined) {
      delete request.headers[LINK_RPC_HEADER];
      const signal = typeof key === "string" ? linkRpcs.get(key) : undefined;
      signal?.addEventListener("abort", () => reply.raw.writableEnded || reply.raw.destroy(), { once: true });
    }
    done();
  });
}

export class FrontendPool {
  private readonly frontends: (Frontend | null)[] = [];
  private readonly ready = new Map<number, () => void>();
  private linkServer: net.Server | null = null;
  private acceptServer: net.Server | null = null;
  private pipe = "";
  private closing = false;
  private readonly respawns = new Set<NodeJS.Timeout>();

  constructor(readonly hooks: CoreHooks) {}

  /** Starts the front-ends, then listens on `port`; returns the base URL. */
  async start(options: { port: number; host: string; processes: number }): Promise<string> {
    if (!(options.processes >= 1) || !Number.isInteger(options.processes)) throw new Error(`front-end processes must be a whole number >= 1, got ${options.processes}`);
    const name = `ome-gw-${process.pid}-${randomBytes(6).toString("hex")}`;
    // A named pipe on Windows, a Unix socket elsewhere. Other local processes can reach either, hence the HELLO secret.
    this.pipe = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
    const linkServer = (this.linkServer = net.createServer((socket) => this.onLink(socket)));
    linkServer.listen(this.pipe);
    await once(linkServer, "listening");
    try {
      await Promise.all(Array.from({ length: options.processes }, (_, id) => this.spawn(id)));
    } catch (error) {
      // No restarts and no orphans: the front-end that failed would otherwise be respawned, the others left running.
      await this.close();
      throw error;
    }

    const acceptServer = (this.acceptServer = net.createServer({ pauseOnConnect: true }, (socket) => this.handOff(socket)));
    acceptServer.listen(options.port, options.host);
    await once(acceptServer, "listening");
    const { port } = acceptServer.address() as net.AddressInfo;
    return `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${port}`;
  }

  frontendsOf(traderId: string): number[] {
    const out: number[] = [];
    for (const f of this.frontends) {
      if (f === null) continue;
      for (const session of f.sessions.values()) if (session.trader.id === traderId) out.push(f.id);
    }
    return out;
  }

  pids(): number[] {
    return this.frontends.flatMap((f) => (f?.child.pid === undefined ? [] : [f.child.pid]));
  }

  async stats(): Promise<FrontendStats[]> {
    return Promise.all(this.frontends.filter((f): f is Frontend => f?.link !== null && f !== null).map((f) => f.stats()));
  }

  /** Gateway.broadcast: one record per front-end, which sends it to every connection it holds. */
  broadcast(message: ServerMessage): void {
    for (const f of this.frontends) {
      const link = f?.usable(true) ?? null;
      if (link === null) continue;
      const w = link.begin(wire.ALL);
      w.u8(1);
      w.str(serialize(message));
    }
  }

  channelsGone(names: string[]): void {
    for (const f of this.frontends) f?.channels.gone(names);
  }

  /** A front-end crashed or stuck: drop its connections and start a fresh one. */
  failed(frontend: Frontend, why: string): void {
    if (this.frontends[frontend.id] !== frontend) return;
    this.frontends[frontend.id] = null;
    frontend.reset();
    frontend.child.kill();
    if (this.closing) return;
    console.warn(`Gateway front-end ${frontend.id} stopped (${why}); restarting it`);
    const timer = setTimeout(() => {
      this.respawns.delete(timer);
      void this.spawn(frontend.id).catch((error: unknown) => console.error(`Gateway front-end ${frontend.id} did not restart:`, error));
    }, RESPAWN_MS);
    this.respawns.add(timer);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.respawns) clearTimeout(timer);
    this.acceptServer?.close();
    const exits = this.frontends.map(async (f) => {
      if (f === null) return;
      const child = f.child;
      if (child.exitCode === null && child.signalCode === null) {
        // The front-end closes its clients' sockets (1001) and exits; it ignores SIGINT,
        // which Ctrl+C sends to every process in a Windows console.
        const exited = once(child, "exit");
        if (child.connected) child.send({ t: "exit" });
        const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        await exited;
        clearTimeout(timer);
      }
      f.reset();
    });
    await Promise.all(exits);
    this.frontends.length = 0;
    await new Promise<void>((resolve) => (this.linkServer === null ? resolve() : this.linkServer.close(() => resolve())));
  }

  private spawn(id: number): Promise<void> {
    // A plain node process: the bootstrap registers the TypeScript loader, as exchange workers do.
    const child = fork(bootstrap, [], { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const frontend = new Frontend(id, child, this);
    this.frontends[id] = frontend;
    const ready = new Promise<void>((resolve, reject) => {
      this.ready.set(id, resolve);
      child.once("exit", (code) => reject(new Error(`front-end ${id} exited with code ${code} before starting`)));
    });
    child.on("exit", (code, signal) => this.failed(frontend, `exit code ${code ?? signal}`));
    child.send({ t: "config", id, pipe: this.pipe, secret: frontend.secret, rateLimit: this.hooks.rateLimit, maxPayload: MAX_PAYLOAD });
    return ready;
  }

  /** A front-end connecting its link: the first record must be HELLO with the secret it was given. */
  private onLink(socket: net.Socket): void {
    let frontend: Frontend | null = null;
    const link = new wire.Link(
      socket,
      (r, kind) => {
        if (frontend !== null) return frontend.receive(r, kind);
        if (kind !== wire.HELLO) throw new Error("link did not start with HELLO");
        const id = r.u32();
        const secret = r.str();
        const candidate = this.frontends[id];
        if (candidate === null || candidate === undefined || candidate.secret !== secret || candidate.link !== null) throw new Error("bad HELLO");
        frontend = candidate;
        frontend.link = link;
        this.ready.get(id)?.();
        this.ready.delete(id);
      },
      (error) => {
        socket.destroy();
        if (frontend !== null) this.failed(frontend, error.message);
      },
    );
    socket.on("error", () => {});
    socket.on("close", () => {
      if (frontend !== null && frontend.link === link) this.failed(frontend, "its link closed");
    });
  }

  /** Gives an accepted connection to the front-end with the fewest open ones (ties at random). */
  private handOff(socket: net.Socket): void {
    let fewest: Frontend[] = [];
    for (const f of this.frontends) {
      if (f === null || f.link === null || !f.child.connected) continue;
      if (fewest.length === 0 || f.connections < fewest[0]!.connections) fewest = [f];
      else if (f.connections === fewest[0]!.connections) fewest.push(f);
    }
    const best = fewest[Math.floor(Math.random() * fewest.length)];
    if (best === undefined) {
      socket.destroy();
      return;
    }
    best.connections++;
    const chosen = best;
    chosen.child.send({ t: "conn" }, socket, (error) => {
      if (error === null) return;
      chosen.connections = Math.max(0, chosen.connections - 1);
      socket.destroy();
    });
  }
}
