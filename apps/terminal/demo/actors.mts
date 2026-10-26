// Background actors for the demo recording, run by demo.spec.ts with tsx (cwd services/bots):
//
//   node --import tsx apps/terminal/demo/actors.mts --url=http://127.0.0.1:18290 \
//     --tournament=<id> --manipulators=HDFCBANK --manipulators-at=<epoch ms>
//
// - Two scripted tournament entrants ("carol" and "dave") on ordinary (limited) accounts: they join
//   the tournament and now and then trade a few shares at market, so the leaderboard has a field.
// - The five manipulator bots from the surveillance simulator (the same agents `pnpm bots -- --cheaters`
//   runs), started only at --manipulators-at, after surveillance shadow mode has calibrated on honest traffic.
//   `--cheaters` in services/bots would also start a second set of market makers and noise traders.
//
// It imports the repo's own source through computed URLs, so the terminal's type check does not
// follow it into other packages.

const here = new URL(".", import.meta.url);
const repo = new URL("../../../", here);

interface Client {
  traderId: string;
  open: boolean;
  newOrderId(prefix?: string): string;
  placeOrder(symbol: string, id: string, order: Record<string, unknown>): Promise<{ type: string; reason?: string }>;
  joinTournament(id: string): Promise<{ ok: boolean; message?: string }>;
  close(): void;
}
interface ClientClass {
  connect(url: string, name: string, options?: { botKey?: string }): Promise<Client>;
  instruments(url: string): Promise<{ symbol: string; lotSize: number }[]>;
}
type AgentCtor = new (id: string, intensity: number, ms: number) => { id: string };

const { TradingClient } = (await import(new URL("packages/client/src/index.ts", repo).href)) as { TradingClient: ClientClass };

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const url = arg("url") ?? "http://127.0.0.1:8080";
const tournament = arg("tournament");
const cheaterSymbol = arg("manipulators");
const cheatersAt = Number(arg("manipulators-at") ?? 0);
const botKey = process.env.BOT_KEY ?? "local-dev-bot-key";
const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);

const stoppers: (() => void)[] = [];

// Seeded, so a re-recording gets the same field.
let seed = 4242;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

async function entrant(name: string, symbols: string[], meanMs: number): Promise<void> {
  const client = await TradingClient.connect(url, name);
  if (tournament !== undefined) {
    const joined = await client.joinTournament(tournament);
    log(`${name} (${client.traderId}) ${joined.ok ? "joined" : `could not join: ${joined.message}`}`);
  }
  const position = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const act = async () => {
    const symbol = symbols[Math.floor(random() * symbols.length)]!;
    const held = position.get(symbol) ?? 0;
    // Mostly buying, sometimes taking profit, never more than 120 shares of one stock.
    const side = held >= 120 || (held > 0 && random() < 0.35) ? "sell" : "buy";
    const quantity = side === "sell" ? Math.min(held, 5 + Math.floor(random() * 25)) : 5 + Math.floor(random() * 25);
    if (quantity > 0 && client.open) {
      const r = await client.placeOrder(symbol, client.newOrderId("d"), { type: "market", side, quantity });
      if (r.type === "ack") position.set(symbol, held + (side === "buy" ? quantity : -quantity));
    }
    timer = setTimeout(() => void act(), meanMs * (0.5 + random()));
  };
  timer = setTimeout(() => void act(), 3_000 + random() * 5_000);
  stoppers.push(() => {
    clearTimeout(timer);
    client.close();
  });
}

async function manipulators(symbol: string): Promise<void> {
  const s = (await import(new URL("packages/surveillance/src/index.ts", repo).href)) as Record<string, AgentCtor> & {
    WashTraderAgent: AgentCtor & { pair(a: string, b: string, intensity: number, ms: number): { id: string }[] };
  };
  const { LiveMarket } = (await import(new URL("services/bots/src/live-market.ts", repo).href)) as {
    LiveMarket: new (instrument: unknown, agents: unknown[], clients: Map<string, Client>, random: () => number) => { start(): void; stop(): void };
  };
  const { prng } = (await import(new URL("services/bots/src/random.ts", repo).href)) as { prng: (seed: number) => () => number };
  const instrument = (await TradingClient.instruments(url)).find((i) => i.symbol === symbol);
  if (instrument === undefined) throw new Error(`unknown symbol ${symbol}`);
  const agents = [
    new s.SpooferAgent!("spoofer", 0.7, 2_500),
    new s.LayeringAgent!("layerer", 0.7, 2_500),
    new s.PumpAndDumpAgent!("pumper", 0.7, 2_500),
    ...s.WashTraderAgent.pair("wash-a", "wash-b", 0.7, 2_500),
  ];
  const clients = new Map<string, Client>();
  for (const agent of agents) clients.set(agent.id, await TradingClient.connect(url, agent.id, { botKey }));
  const live = new LiveMarket(instrument, agents, clients, prng(99));
  live.start();
  log(`manipulators trading ${symbol}: ${agents.map((a) => a.id).join(", ")}`);
  stoppers.push(() => {
    live.stop();
    for (const c of clients.values()) c.close();
  });
}

if (tournament !== undefined) {
  await entrant("carol", ["RELIANCE", "INFY"], 9_000);
  await entrant("dave", ["TCS", "RELIANCE"], 12_000);
}
if (cheaterSymbol !== undefined) {
  const wait = Math.max(0, cheatersAt - Date.now());
  log(`manipulators start on ${cheaterSymbol} in ${Math.round(wait / 1000)} s`);
  setTimeout(() => void manipulators(cheaterSymbol).catch((e: unknown) => log(`manipulators failed: ${String(e)}`)), wait);
}

const stop = () => {
  for (const s of stoppers) s();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
