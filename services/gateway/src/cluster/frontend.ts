import net from "node:net";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import websocket, { type WebSocket } from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { sendCorked } from "../outbound.js";
import { parseClientMessage } from "../protocol.js";
import { TokenBucket } from "../rate-limit.js";
import * as wire from "./wire.js";

// A front-end process (see pool.ts): it terminates WebSocket and HTTP
// connections the core hands it, validates and rate-limits what clients
// send, forwards it to the core as binary records, and writes what comes
// back. It holds no trading state, so it can be killed and restarted at any
// time; its clients reconnect with the same token, as after any disconnect.
//
// Differences from single-process mode, all at the edge:
// - pong times and the rate limit use this process's clock, not an injected
//   `now` (tests that inject a clock use single-process mode);
// - authentication takes one round trip to the core before the welcome;
//   messages sent meanwhile are held and processed in order once it answers.

interface Config {
  id: number;
  pipe: string;
  secret: string;
  rateLimit: { burst: number; perSecond: number };
  maxPayload: number;
}

interface Conn {
  id: number;
  socket: WebSocket;
  bucket: TokenBucket;
  /** Messages that arrived before the core accepted the token; null once it has. */
  early: string[] | null;
  channels: Set<string>;
}

/** Market data is dropped for a client whose socket has this much unsent data... */
const SOFT_BUFFER_LIMIT = 1 << 20;
/** ...and the client is disconnected if even essential messages back up this far. */
const HARD_BUFFER_LIMIT = 16 << 20;
/** A client may send this many messages before its token is checked. */
const MAX_EARLY = 256;
/** Above this much unsent to the core, client sockets stop being read until the link drains. */
const LINK_PAUSE_LIMIT = 4 << 20;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "date"]);

// Ctrl+C in a Windows console reaches every process in it: the core decides when this one stops.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const [config] = (await once(process, "message")) as [Config & { t: string }];
const conns = new Map<number, Conn>();
/** Connections by channel: the fan-out sets the core keeps up to date. */
const subscribers = new Map<string, Set<Conn>>();
const rpcs = new Map<number, (reply: { status: number; headers: Record<string, string | string[]>; body: string }) => void>();
let nextConn = 1;
let nextRpc = 1;
let paused = false;

function rawSocket(c: Conn): net.Socket | undefined {
  return (c.socket as unknown as { _socket?: net.Socket })._socket;
}

function send(c: Conn, text: string, essential: boolean): void {
  const socket = c.socket;
  if (socket.readyState !== socket.OPEN) return;
  const buffered = socket.bufferedAmount;
  if (buffered > HARD_BUFFER_LIMIT) {
    socket.close(4008, "slow consumer");
    return;
  }
  if (!essential && buffered > SOFT_BUFFER_LIMIT) return;
  sendCorked(socket, text);
}

const linkSocket = net.connect(config.pipe);
await once(linkSocket, "connect");
const link = new wire.Link(linkSocket, (r, kind) => receive(r, kind), (error) => {
  console.error(`Gateway front-end ${config.id}: ${error.message}`);
  process.exit(1);
});
// No core, no point: this process only ever serves it.
linkSocket.on("close", () => process.exit(0));
linkSocket.on("error", () => {});
process.on("disconnect", () => process.exit(0));

/** TCP flow control pushes back on clients while the core is behind. */
function checkLink(): void {
  if (paused || linkSocket.writableLength <= LINK_PAUSE_LIMIT) return;
  paused = true;
  for (const c of conns.values()) rawSocket(c)?.pause();
  linkSocket.once("drain", () => {
    paused = false;
    for (const c of conns.values()) rawSocket(c)?.resume();
  });
}

function receive(r: wire.Reader, kind: number): void {
  switch (kind) {
    case wire.ATTACHED: {
      const c = conns.get(r.u32());
      const ok = r.u8() === 1;
      if (c === undefined) return;
      if (!ok) {
        c.socket.close(4001, "unauthorized: create a session with POST /api/session");
        return;
      }
      const early = c.early ?? [];
      c.early = null;
      for (const text of early) handle(c, text);
      return;
    }
    case wire.ACK:
    case wire.REJECT:
    case wire.EXECUTION: {
      const { conn, message } = wire.readReply(r, kind);
      const c = conns.get(conn);
      if (c !== undefined) send(c, JSON.stringify(message), true);
      return;
    }
    case wire.MESSAGE: {
      const c = conns.get(r.u32());
      const essential = r.u8() === 1;
      const text = r.str();
      if (c !== undefined) send(c, text, essential);
      return;
    }
    case wire.ALL: {
      const essential = r.u8() === 1;
      const text = r.str();
      for (const c of conns.values()) if (c.early === null) send(c, text, essential);
      return;
    }
    case wire.CHANNEL: {
      const set = subscribers.get(r.str());
      const text = r.str();
      if (set !== undefined) for (const c of set) send(c, text, false);
      return;
    }
    case wire.CHANNEL_ADD:
    case wire.CHANNEL_REMOVE: {
      const c = conns.get(r.u32());
      const channel = r.str();
      if (c === undefined) return;
      let set = subscribers.get(channel);
      if (kind === wire.CHANNEL_ADD) {
        if (set === undefined) subscribers.set(channel, (set = new Set()));
        set.add(c);
        c.channels.add(channel);
      } else {
        set?.delete(c);
        if (set?.size === 0) subscribers.delete(channel);
        c.channels.delete(channel);
      }
      return;
    }
    case wire.CHANNEL_GONE: {
      const channel = r.str();
      for (const c of subscribers.get(channel) ?? []) c.channels.delete(channel);
      subscribers.delete(channel);
      return;
    }
    case wire.HTTP_REPLY: {
      const id = r.u32();
      const status = r.u32();
      const headers = JSON.parse(r.str()) as Record<string, string | string[]>;
      const body = r.str();
      rpcs.get(id)?.({ status, headers, body });
      rpcs.delete(id);
      return;
    }
    default:
      throw new Error(`unexpected link record ${kind}`);
  }
}

/** One client frame: validated here, then forwarded (the core trusts what it gets from a front-end). */
function handle(c: Conn, text: string): void {
  const parsed = parseClientMessage(text);
  if ("error" in parsed) {
    send(c, JSON.stringify(parsed.error), true);
    return;
  }
  const message = parsed.message;
  switch (message.op) {
    case "ping":
      send(c, JSON.stringify({ type: "pong", ...(message.reqId === undefined ? {} : { reqId: message.reqId }), time: Date.now() }), true);
      return;
    case "subscribe":
    case "unsubscribe": {
      const w = link.begin(message.op === "subscribe" ? wire.SUBSCRIBE : wire.UNSUBSCRIBE);
      w.u32(c.id);
      w.u32(message.channels.length);
      for (const channel of message.channels) w.str(channel);
      break;
    }
    default:
      if (!c.bucket.take()) {
        send(c, JSON.stringify({ type: "reject", reqId: message.reqId, clientOrderId: message.clientOrderId, reason: "rate_limited" }), true);
        return;
      }
      wire.writeTrade(link.begin(message.op === "order" ? wire.ORDER : message.op === "cancel" ? wire.CANCEL : wire.AMEND), c.id, message);
  }
  checkLink();
}

const app = Fastify({ logger: false });
await app.register(websocket, { options: { maxPayload: config.maxPayload } });
// Bodies go to the core untouched; its routes parse and check them.
app.removeAllContentTypeParsers();
app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));

app.get("/ws", { websocket: true }, (socket, request) => {
  const c: Conn = {
    id: nextConn++,
    socket,
    bucket: new TokenBucket(config.rateLimit.burst, config.rateLimit.perSecond, Date.now),
    early: [],
    channels: new Set(),
  };
  conns.set(c.id, c);
  if (paused) rawSocket(c)?.pause();
  const w = link.begin(wire.ATTACH);
  w.u32(c.id);
  w.str((request.query as { token?: string }).token ?? "");
  socket.on("message", (data: Buffer) => {
    const text = data.toString();
    if (c.early === null) handle(c, text);
    else if (c.early.push(text) > MAX_EARLY) socket.close(1008, "too many messages before authentication");
  });
  socket.on("close", () => {
    conns.delete(c.id);
    for (const channel of c.channels) {
      const set = subscribers.get(channel);
      set?.delete(c);
      if (set?.size === 0) subscribers.delete(channel);
    }
    link.begin(wire.DETACH).u32(c.id);
  });
});

/** Every other request is served by the core's Fastify app, so each route has one implementation. */
async function proxy(request: FastifyRequest, reply: FastifyReply) {
  const id = nextRpc++;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  const w = link.begin(wire.HTTP);
  w.u32(id);
  w.str(request.method);
  w.str(request.url);
  w.str(JSON.stringify(headers));
  if (typeof request.body === "string") {
    w.u8(1);
    w.str(request.body);
  } else w.u8(0);
  // The client went away before the answer: the core stops waiting too (a plain-English parse, say).
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded && rpcs.delete(id)) link.begin(wire.HTTP_ABORT).u32(id);
  });
  const answer = await new Promise<{ status: number; headers: Record<string, string | string[]>; body: string }>((resolve) => rpcs.set(id, resolve));
  reply.code(answer.status);
  for (const [name, value] of Object.entries(answer.headers)) if (!HOP_BY_HOP.has(name)) reply.header(name, value);
  return reply.send(answer.body);
}
app.all("/*", proxy);
await app.ready();

let cpu = process.threadCpuUsage();
let elu = performance.eventLoopUtilization();
let frames = link.framesOut;
let records = link.recordsOut;

process.on("message", (m: { t: string }, handle?: net.Socket) => {
  if (m.t === "conn" && handle !== undefined) {
    handle.once("close", () => process.send?.({ t: "gone" }));
    app.server.emit("connection", handle);
    handle.resume();
  } else if (m.t === "stats") {
    const used = process.threadCpuUsage(cpu);
    const loop = performance.eventLoopUtilization(elu);
    const out = {
      t: "stats",
      cpuMs: (used.user + used.system) / 1000,
      elu: loop.utilization,
      connections: conns.size,
      recordsPerFrame: (link.recordsOut - records) / Math.max(1, link.framesOut - frames),
    };
    cpu = process.threadCpuUsage();
    elu = performance.eventLoopUtilization();
    frames = link.framesOut;
    records = link.recordsOut;
    process.send?.(out);
  } else if (m.t === "exit") {
    for (const c of conns.values()) c.socket.close(1001, "gateway shutting down");
    link.flush();
    setTimeout(() => process.exit(0), 100);
  }
});

// Ready: the core starts handing over connections once it has this.
const hello = link.begin(wire.HELLO);
hello.u32(config.id);
hello.str(config.secret);
