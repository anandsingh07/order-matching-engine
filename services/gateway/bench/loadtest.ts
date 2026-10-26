import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Exchange } from "@ome/exchange";
import { DEFAULT_INSTRUMENTS, Gateway } from "../src/index.js";

/**
 * End-to-end load test: many WebSocket clients trading at once. Measures the
 * round trip a client sees (send order -> receive ack or reject), through
 * JSON over TCP, validation, the ring buffer, matching on a worker, and back.
 *
 *   pnpm --filter @ome/gateway loadtest -- --clients=48 --orders=2000 --window=20 --procs=3
 *   pnpm --filter @ome/gateway loadtest -- --flow=ioc            (no fills: the old README flow)
 *   pnpm --filter @ome/gateway loadtest -- --watchers=100        (plus market-data subscribers)
 *   pnpm --filter @ome/gateway loadtest -- --gateway-processes=2 (front-end processes, see src/cluster/;
 *                                       --frontends --gateway-processes=1 measures one, i.e. the link's cost)
 *   pnpm --filter @ome/gateway loadtest -- --pin                 (Windows: pin gateway and load to separate cores)
 *   pnpm --filter @ome/gateway loadtest -- --url=http://127.0.0.1:8080   (an already running gateway)
 *
 * The clients run in `--procs` separate load processes that connect first and
 * start together, so the gateway's event loop is not shared with them.
 *
 * Flows:
 * - `mix` (default): half good-till-cancelled makers, half IOC takers, sides
 *   independent of symbol, prices straddling the reference: about 1 fill per
 *   order (0.96-0.97 measured, both sides of each trade counted, so about 0.5
 *   trades per order), with market data, as in a real market.
 * - `ioc`: every order an IOC limit order on a side fixed by its symbol, so
 *   nothing ever trades (accepted, cancelled, ack). This is the flow the
 *   earlier ~68K orders/sec figure came from.
 *
 * With `--url`, the running gateway's own per-connection rate limit applies
 * (default 200 burst, 100/sec), and refused orders are fast: start it with
 * RATE_LIMIT=off to measure throughput. Throughput counts acks only; rejects
 * are listed by reason, and the run fails (exit code 2) when any were
 * rate_limited, so a throttled run cannot pass as a fast one.
 */

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = (name: string) => process.argv.includes(`--${name}`);
/** Load clients are unlimited accounts, so risk limits do not throttle the test. */
const BOT_KEY = process.env.BOT_KEY ?? "local-dev-bot-key";
const SYMBOLS = ["RELIANCE", "TCS", "INFY", "HDFCBANK"];

interface ChildConfig {
  base: string;
  first: number;
  clients: number;
  orders: number;
  window: number;
  flow: "mix" | "ioc";
  watchers: number;
}

interface ChildResult {
  latencies: number[];
  acks: number;
  rejects: Record<string, number>;
  fills: number;
  received: number;
  watched: number;
  seconds: number;
  cpuMs: number;
}

// ---------------------------------------------------------------- load process

async function connect(base: string, name: string): Promise<WebSocket> {
  const response = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, botKey: BOT_KEY }),
  });
  const { token } = (await response.json()) as { token: string };
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws?token=${token}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  return socket;
}

function runClient(socket: WebSocket, index: number, config: ChildConfig, result: ChildResult): Promise<void> {
  const reference = new Map(DEFAULT_INSTRUMENTS.map((i) => [i.symbol, i.referencePrice]));
  const sentAt = new Map<string, number>();
  let sent = 0;
  let done = 0;
  return new Promise<void>((resolve) => {
    const sendNext = () => {
      while (sent < config.orders && sent - done < config.window) {
        const n = sent++;
        const k = index + n;
        const symbol = SYMBOLS[k % SYMBOLS.length]!;
        // The side changes every 4 orders, independently of the symbol, so every
        // symbol gets buys and sells. (The ioc flow keeps the old coupling: RELIANCE
        // and INFY only ever buy and TCS and HDFCBANK only ever sell, so nothing trades.)
        const side = (config.flow === "mix" ? Math.floor(k / SYMBOLS.length) : k) % 2 === 0 ? "buy" : "sell";
        // Prices straddle the reference, so crossing orders trade and makers rest near the touch.
        const price = reference.get(symbol)! + ((n * 7) % 11) * 5 - 25;
        const timeInForce = config.flow === "mix" && n % 2 === 0 ? "GTC" : "IOC";
        const reqId = `${n}`;
        sentAt.set(reqId, performance.now());
        socket.send(
          JSON.stringify({ op: "order", reqId, symbol, clientOrderId: `c${n}`, order: { type: "limit", side, price, quantity: 1 + (n % 9), timeInForce } }),
        );
      }
    };
    socket.addEventListener("message", (event) => {
      result.received++;
      const message = JSON.parse(String(event.data)) as { type: string; reqId?: string; reason?: string; event?: string };
      if (message.type === "execution" && message.event === "fill") result.fills++;
      if ((message.type !== "ack" && message.type !== "reject") || message.reqId === undefined) return;
      if (message.type === "ack") result.acks++;
      else result.rejects[message.reason ?? "?"] = (result.rejects[message.reason ?? "?"] ?? 0) + 1;
      result.latencies.push(performance.now() - sentAt.get(message.reqId)!);
      sentAt.delete(message.reqId);
      done++;
      if (done === config.orders) resolve();
      else sendNext();
    });
    sendNext();
  });
}

async function loadProcess(config: ChildConfig): Promise<void> {
  const result: ChildResult = { latencies: [], acks: 0, rejects: {}, fills: 0, received: 0, watched: 0, seconds: 0, cpuMs: 0 };
  const watchers = await Promise.all(Array.from({ length: config.watchers }, (_, i) => connect(config.base, `watch${config.first + i}`)));
  for (const w of watchers) {
    w.addEventListener("message", (e) => {
      result.watched++;
      JSON.parse(String(e.data));
    });
    w.send(JSON.stringify({ op: "subscribe", channels: SYMBOLS.flatMap((s) => [`trades:${s}`, `book:${s}`, `candles:${s}:5s`]) }));
  }
  const sockets = await Promise.all(Array.from({ length: config.clients }, (_, i) => connect(config.base, `load${config.first + i}`)));
  process.send!({ ready: true });
  await once(process, "message");
  const start = performance.now();
  const cpu = process.cpuUsage();
  await Promise.all(sockets.map((s, i) => runClient(s, config.first + i, config, result)));
  result.seconds = (performance.now() - start) / 1000;
  const used = process.cpuUsage(cpu);
  result.cpuMs = (used.user + used.system) / 1000;
  for (const s of [...sockets, ...watchers]) s.close();
  process.send!(result, () => process.exit(0));
}

// ---------------------------------------------------------------- coordinator

/** Windows only: sets a process's CPU affinity mask (children inherit it) and raises its priority. */
function pin(pid: number, mask: number): void {
  if (process.platform !== "win32") return;
  spawnSync("powershell", ["-NoProfile", "-Command", `$p = Get-Process -Id ${pid}; $p.ProcessorAffinity = ${mask}; $p.PriorityClass = 'AboveNormal'`], {
    stdio: "ignore",
  });
}

async function coordinator(): Promise<void> {
  const procs = Number(arg("procs", "3"));
  const clients = Number(arg("clients", "48"));
  const orders = Number(arg("orders", "2000"));
  const window = Number(arg("window", "20"));
  const flow = arg("flow", "mix") === "ioc" ? "ioc" : "mix";
  const watchers = Number(arg("watchers", "0"));
  const processes = Number(arg("gateway-processes", "1"));
  const externalUrl = arg("url", "") || undefined;
  // Default masks for a 4 P-core / 8 E-core laptop: gateway core on two P-cores, front-ends on the other
  // two, load processes on the E-cores. Override with --core-mask= / --fe-masks=a,b / --load-mask=.
  const pinning = flag("pin");
  const coreMask = Number(arg("core-mask", "0xC03"));
  const feMasks = arg("fe-masks", "0x3000,0xC000").split(",").map(Number);
  const loadMask = Number(arg("load-mask", "0x3FC"));

  let base = externalUrl;
  let stop = async () => {};
  let gateway: Gateway | null = null;
  if (base === undefined) {
    if (pinning) pin(process.pid, coreMask);
    const exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: Number(arg("workers", "2")) });
    gateway = await Gateway.create({ exchange, rateLimit: { burst: 1e9, perSecond: 1e9 }, botKey: BOT_KEY });
    base = processes >= 2 || flag("frontends") ? await gateway.listenFrontends({ port: 0, processes }) : await gateway.listen(0);
    if (pinning) gateway.frontendPids().forEach((pid, i) => pin(pid, feMasks[i % feMasks.length]!));
    const g = gateway;
    stop = async () => {
      await g.close();
      await exchange.stop();
    };
  } else {
    // A gateway started by main.ts opens with a call auction, which refuses IOC orders.
    for (let i = 0; i < 120; i++) {
      const status = (await (await fetch(`${base}/api/status`)).json()) as { symbol: string; phase: string }[];
      if (status.filter((s) => SYMBOLS.includes(s.symbol)).every((s) => s.phase === "continuous")) break;
      if (i === 0) console.log("Waiting for the opening auction to end...");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const self = fileURLToPath(import.meta.url);
  const share = (k: number) => Math.floor(clients / procs) + (k < clients % procs ? 1 : 0);
  const children: ChildProcess[] = [];
  let first = 0;
  for (let k = 0; k < procs; k++) {
    const config: ChildConfig = { base, first, clients: share(k), orders, window, flow, watchers: Math.floor(watchers / procs) + (k < watchers % procs ? 1 : 0) };
    first += config.clients + config.watchers;
    const child = fork(self, ["--load-process", JSON.stringify(config)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    if (pinning) pin(child.pid!, loadMask);
    children.push(child);
  }
  await Promise.all(children.map((c) => once(c, "message")));

  const cpu0 = process.threadCpuUsage();
  const elu0 = performance.eventLoopUtilization();
  await gateway?.frontendStats(); // starts the front-ends' own measurement window
  const results = children.map((c) => once(c, "message").then(([m]) => m as ChildResult));
  const start = performance.now();
  for (const c of children) c.send("go");
  const done = await Promise.all(results);
  const seconds = (performance.now() - start) / 1000;
  const cpu = process.threadCpuUsage(cpu0);
  const elu = performance.eventLoopUtilization(elu0).utilization;
  const fe = (await gateway?.frontendStats()) ?? [];
  await Promise.all(children.map((c) => (c.exitCode === null ? once(c, "exit") : null)));
  await stop();

  const latencies = done.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const sum = (f: (r: ChildResult) => number) => done.reduce((a, r) => a + f(r), 0);
  const acks = sum((r) => r.acks);
  const rejects: Record<string, number> = {};
  for (const r of done) for (const [reason, n] of Object.entries(r.rejects)) rejects[reason] = (rejects[reason] ?? 0) + n;
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!.toFixed(2);
  const mode = externalUrl !== undefined ? `against ${externalUrl}` : processes >= 2 || flag("frontends") ? `${processes} front-end process(es) + core` : "single process";
  console.log(`\n${clients} clients x ${orders} orders, ${window} in flight per client, ${procs} load processes, flow ${flow}, ${mode}${pinning ? ", pinned" : ""}`);
  console.log(`Throughput  ${Math.round(acks / seconds).toLocaleString("en-US")} orders/sec acknowledged end to end (${seconds.toFixed(2)} s)`);
  console.log(`Round trip  p50 ${p(0.5)} ms | p90 ${p(0.9)} ms | p99 ${p(0.99)} ms | max ${latencies.at(-1)!.toFixed(2)} ms`);
  console.log(`Per order   ${(sum((r) => r.fills) / latencies.length).toFixed(2)} fills, ${(sum((r) => r.received) / latencies.length).toFixed(2)} messages`);
  if (watchers > 0) console.log(`Watchers    ${watchers} received ${Math.round(sum((r) => r.watched) / seconds).toLocaleString("en-US")} market-data messages/sec`);
  if (Object.keys(rejects).length > 0) console.log(`Rejects     ${JSON.stringify(rejects)}`);
  if (gateway !== null) {
    const ms = (cpu.user + cpu.system) / 1000;
    console.log(`Gateway     main thread ${((ms * 1000) / latencies.length).toFixed(1)} us CPU per order, event loop ${(elu * 100).toFixed(0)}% busy`);
    for (const f of fe) {
      console.log(`  front-end ${f.id}: ${((f.cpuMs * 1000) / latencies.length).toFixed(1)} us CPU per order, event loop ${(f.elu * 100).toFixed(0)}% busy, ${f.connections} connections`);
    }
  }
  console.log(`Load        ${done.map((r) => `${((r.cpuMs / 1000 / r.seconds) * 100).toFixed(0)}%`).join(" ")} CPU per load process (${os.cpus().length} logical CPUs on the machine)\n`);
  if ((rejects.rate_limited ?? 0) > 0) {
    console.error(`${rejects.rate_limited} orders were refused by the gateway's rate limit: this run measured rejects, not trading. Start the gateway with RATE_LIMIT=off.`);
    process.exitCode = 2;
  }
}

const childAt = process.argv.indexOf("--load-process");
if (childAt !== -1) await loadProcess(JSON.parse(process.argv[childAt + 1]!) as ChildConfig);
else await coordinator();
