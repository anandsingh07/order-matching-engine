import { instrumentKind, TradingClient, type DepthLevel, type Instrument, type PublicTrade, type Settlement } from "@ome/client";
import { Exchange } from "@ome/exchange";
import { DEFAULT_INSTRUMENTS, Gateway } from "@ome/gateway";
import { DEFAULT_DERIVATIVES_MAKER, DerivativesMarketMaker } from "./derivatives-maker.js";
import { MarketMaker } from "./market-maker.js";
import { NoiseTrader } from "./noise-trader.js";
import { annualizedVolatility, greeks, impliedVolatility, noArbitrageBounds, yearsUntil } from "./pricing.js";
import { prng, RandomWalk } from "./random.js";

// Futures and options live, end to end through the real exchange, gateway and
// WebSockets, on a short expiry cycle (one process; the gateway listens on a
// free port). Market makers quote the stocks and their derivatives, noise
// traders trade both, and two retail traders on ordinary accounts buy calls,
// write puts and trade futures in every series. Series expire, are
// cash-settled and relisted, and this measures what the unit tests cannot see
// in a running market:
// - every settlement the gateway reports, checked against its own arithmetic:
//   the price against the stock's VWAP recomputed from the public trade
//   stream, the position against the trader's own fills, and the amount
//   against the contract's terms;
// - every series' settlements net to zero across all traders (cash and contracts);
// - each retail account's cash at the gateway equals an independent ledger of
//   its fills and of those recomputed settlements, to the paisa. The retail
//   traders open, partly close and hold positions in every series, so the
//   ledger covers premiums, realised futures P&L and settlement;
// - how often the options' best quotes sit outside the no-arbitrage bounds at
//   the stock's price of the moment, sampled once a second: the book's (any
//   trader's orders) and the market maker's own;
// - the volatility implied by the market maker's mids, against the volatility it values with.
//
//   pnpm --filter @ome/bots derivatives -- --minutes=3 --cycle=60

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const minutes = arg("minutes", 3);
const cycleMs = arg("cycle", 60) * 1_000;
const seed = arg("seed", 1);
const BOT_KEY = "derivatives-live";
const UNDERLYINGS = ["TCS", "INFY"];
const STARTING_CASH = 1_000_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 2 });
const gateway = await Gateway.create({
  exchange,
  botKey: BOT_KEY,
  // A new series gets at least half a cycle, as with DERIVATIVES_EXPIRY_MS in main.ts.
  derivatives: { expiryMs: cycleMs, minLifeMs: cycleMs / 2 },
});
const url = await gateway.listen(0);
const bot = { botKey: BOT_KEY };
const random = prng(seed);
const isDerivative = (i: Instrument) => instrumentKind(i) !== "spot";

// Every instrument seen, expired series included, and every settlement any trader received.
const catalog = new Map<string, Instrument>();
const remember = (instruments: Instrument[]) => instruments.forEach((i) => catalog.set(i.symbol, i));
remember(await TradingClient.instruments(url));
const settlements: Settlement[] = [];
const trades = { future: 0, option: 0 };

/** Every series' money summed over all traders: premiums, futures P&L realised by fills, and settlements. */
const seriesCash = new Map<string, number>();

/** Each stock's trades as the public trade stream reported them, by engine sequence number. */
const tape = new Map<string, Map<number, PublicTrade>>(UNDERLYINGS.map((u) => [u, new Map()]));

/**
 * A series' final settlement price recomputed from the public trade stream,
 * by the published rule: the stock's VWAP over the minute before expiry, to
 * the tick; with no trade in that minute its last trade before expiry. Null
 * when the stock never traded (the gateway then uses its reference price,
 * which this cannot see).
 */
function expectedSettlementPrice(instrument: Instrument): number | null {
  const expiry = instrument.expiry!;
  const prints = [...tape.get(instrument.underlying!)!.values()].filter((t) => t.time <= expiry).sort((a, b) => a.id - b.id);
  const window = prints.filter((t) => t.time > expiry - 60_000);
  const tick = instrument.tickSize;
  if (window.length > 0) {
    const volume = window.reduce((sum, t) => sum + t.quantity, 0);
    return Math.round(window.reduce((sum, t) => sum + t.price * t.quantity, 0) / volume / tick) * tick;
  }
  const last = prints.at(-1);
  return last === undefined ? null : Math.round(last.price / tick) * tick;
}

/** A position by average cost, in contracts and ticks: kept here rather than borrowed from @ome/client, which the gateway's accounts use. */
interface Holding {
  quantity: number;
  average: number;
}

/** A settlement as reported, with the position this trader's own fills say it held. */
interface Reported {
  message: Settlement;
  held: Holding;
}

const settlementChecks = { checked: 0, priceUnchecked: 0, priceMismatches: 0, quantityMismatches: 0, amountMismatches: 0, largestAmountDifference: 0 };

/**
 * One trader's ledger of futures and options cash, built from its own
 * execution reports, independently of the gateway's accounts. An option fill
 * moves the premium; a future fill only the P&L it realises (average cost);
 * a settlement what the contract's terms say it pays at the recomputed price,
 * not the amount the gateway reports. Summed over every trader a series must
 * come to zero: every rupee one side receives, the other pays.
 */
class Ledger {
  /** Futures and options cash only, major units. */
  cash = 0;
  private readonly positions = new Map<string, Holding>();
  private readonly reported: Reported[] = [];

  constructor(client: TradingClient) {
    client.on("execution", (m) => {
      const instrument = catalog.get(m.symbol);
      if (m.event !== "fill" || instrument === undefined || !isDerivative(instrument)) return;
      const units = instrument.priceScale * instrument.quantityScale;
      const multiplier = instrument.multiplier ?? 1;
      const held = this.positions.get(m.symbol) ?? { quantity: 0, average: 0 };
      const signed = m.side === "buy" ? m.quantity : -m.quantity;
      let realized = 0;
      if (held.quantity === 0 || Math.sign(held.quantity) === Math.sign(signed)) {
        held.average = (held.average * Math.abs(held.quantity) + m.price * m.quantity) / (Math.abs(held.quantity) + m.quantity);
        held.quantity += signed;
      } else {
        realized = Math.min(m.quantity, Math.abs(held.quantity)) * (m.price - held.average) * Math.sign(held.quantity);
        const after = held.quantity + signed;
        // Closed out: no average left. Turned through zero: the rest opened at this price.
        if (after === 0) held.average = 0;
        else if (Math.sign(after) !== Math.sign(held.quantity)) held.average = m.price;
        held.quantity = after;
      }
      this.positions.set(m.symbol, held);
      const amount = instrumentKind(instrument) === "future" ? (realized * multiplier) / units : (-signed * m.price * multiplier) / units;
      this.add(m.symbol, amount);
    });
    client.on("settlement", (m) => {
      settlements.push(m);
      // Checked once the run is over: the stock's last trades come over another connection, which may be behind.
      this.reported.push({ message: m, held: this.positions.get(m.symbol) ?? { quantity: 0, average: 0 } });
      this.positions.delete(m.symbol);
    });
  }

  /** Recomputes and books every settlement this trader received, counting the checks in `settlementChecks`. */
  settle(): void {
    for (const { message: m, held } of this.reported) {
      const instrument = catalog.get(m.symbol)!;
      const expected = expectedSettlementPrice(instrument);
      settlementChecks.checked++;
      if (expected === null) settlementChecks.priceUnchecked++;
      else if (expected !== m.price) settlementChecks.priceMismatches++;
      if (held.quantity !== m.quantity) settlementChecks.quantityMismatches++;
      const price = expected ?? m.price;
      const strike = instrument.strike ?? 0;
      const perShare =
        instrumentKind(instrument) === "future"
          ? price - held.average
          : Math.max(0, instrument.right === "call" ? price - strike : strike - price);
      const amount = (perShare * held.quantity * (instrument.multiplier ?? 1)) / (instrument.priceScale * instrument.quantityScale);
      const difference = Math.abs(amount - m.amount);
      if (difference > 1e-6) settlementChecks.amountMismatches++;
      settlementChecks.largestAmountDifference = Math.max(settlementChecks.largestAmountDifference, difference);
      this.add(m.symbol, amount);
    }
    this.reported.length = 0;
  }

  private add(symbol: string, amount: number): void {
    this.cash += amount;
    seriesCash.set(symbol, (seriesCash.get(symbol) ?? 0) + amount);
  }
}

// Every trader gets a ledger from its first message on: between them they see every fill and settlement there is.
const clients: TradingClient[] = [];
const ledgers = new Map<TradingClient, Ledger>();
const connect = async (name: string, options = {}) => {
  const c = await TradingClient.connect(url, name, options);
  clients.push(c);
  ledgers.set(c, new Ledger(c));
  return c;
};

// Counts every future and option trade, following the series as they are listed.
const observer = await connect("observer", bot);
const watched = new Set<string>();
const watch = (instruments: Instrument[]) => {
  const fresh = instruments.filter((i) => instrumentKind(i) !== "spot" && !watched.has(i.symbol));
  for (const i of fresh) watched.add(i.symbol);
  if (fresh.length > 0) observer.subscribe(fresh.map((i) => `trades:${i.symbol}`));
};
observer.on("trade", (m) => {
  tape.get(m.symbol)?.set(m.trade.id, m.trade);
  const kind = instrumentKind(catalog.get(m.symbol) ?? { kind: "spot" });
  if (kind !== "spot") trades[kind]++;
});
// The stocks' trades too, for recomputing settlement prices; the subscription's snapshot fills in any already made.
observer.on("trades", (m) => {
  for (const t of m.trades) tape.get(m.symbol)?.set(t.id, t);
});
observer.subscribe(UNDERLYINGS.map((u) => `trades:${u}`));
observer.on("instruments", (m) => {
  remember(m.instruments);
  watch(m.instruments);
});
watch([...catalog.values()]);

const stoppers: (() => void | Promise<void>)[] = [];
const stocks = DEFAULT_INSTRUMENTS.filter((i) => UNDERLYINGS.includes(i.symbol));
for (const stock of stocks) {
  const walk = new RandomWalk(stock.referencePrice, 0.0005, random, stock.tickSize * 10);
  let last = performance.now();
  const fair = () => {
    const now = performance.now();
    walk.step((now - last) / 1000);
    last = now;
    return walk.current;
  };
  const maker = new MarketMaker(await connect(`mm-${stock.symbol}`, bot), stock, fair, { levels: 5, halfSpreadBps: 4, stepBps: 3, size: 25, maxPosition: 500, skewBps: 8 });
  maker.start();
  stoppers.push(() => maker.stop());
}
for (let i = 0; i < 2; i++) {
  const noise = new NoiseTrader(await connect(`noise-${i + 1}`, bot), stocks, prng(seed + i + 1), { meanIntervalMs: 150, maxLots: 20, marketShare: 0.3, restMs: 4_000 });
  noise.start();
  stoppers.push(() => noise.stop());
}
const desks: DerivativesMarketMaker[] = [];
for (const stock of stocks) {
  const desk = new DerivativesMarketMaker(await connect(`deriv-mm-${stock.symbol}`, bot), stock);
  await desk.start([...catalog.values()]);
  desks.push(desk);
  stoppers.push(() => desk.stop());
}
const derivativeNoise = await connect("noise-derivatives", bot);
const noise = new NoiseTrader(derivativeNoise, [...catalog.values()].filter(isDerivative), prng(seed + 50), { meanIntervalMs: 500, maxLots: 5, marketShare: 0.3, restMs: 4_000 });
derivativeNoise.on("instruments", (m) => noise.setInstruments(m.instruments.filter(isDerivative)));
noise.start();
stoppers.push(() => noise.stop());

/** A retail trader on an ordinary account: its cash at the gateway must equal the starting cash plus its ledger. */
class Retail {
  gatewayCash: number | null = null;
  readonly rejects: string[] = [];

  constructor(
    readonly client: TradingClient,
    readonly ledger: Ledger,
  ) {
    client.on("account", (m) => {
      this.gatewayCash = m.balances.find((b) => b.currency === "INR")?.cash ?? null;
    });
  }

  async market(symbol: string, side: "buy" | "sell", quantity: number): Promise<void> {
    const result = await this.client.placeOrder(symbol, this.client.newOrderId("r"), { type: "market", side, quantity });
    if (result.type !== "ack") this.rejects.push(result.type === "reject" ? result.reason : result.message);
  }
}

const aliceClient = await connect("alice");
const bobClient = await connect("bob");
const alice = new Retail(aliceClient, ledgers.get(aliceClient)!);
const bob = new Retail(bobClient, ledgers.get(bobClient)!);

/**
 * In each series, in three steps over its life, so the ledger sees premiums,
 * realised futures P&L on successive partial closes, and settlement:
 * - when it is listed, Alice buys 2 at-the-money calls and 3 futures; Bob writes 2 at-the-money puts and sells 3 futures;
 * - about a third of the way through, Alice sells 1 call and 1 future; Bob buys back 1 put and 1 future;
 * - about two thirds through, each closes one more future. The rest is held to expiry.
 */
const rounds = new Map<string, { step: number; listedAt: number; call: string; put: string; future: string }>();
async function retailRound(): Promise<void> {
  const now = Date.now();
  const live = [...catalog.values()].filter((i) => isDerivative(i) && i.expiry! - now > 8_000);
  for (const underlying of UNDERLYINGS) {
    const series = live.filter((i) => i.underlying === underlying);
    const expiry = series[0]?.expiry;
    if (expiry === undefined) continue;
    const key = `${underlying}:${expiry}`;
    let round = rounds.get(key);
    if (round === undefined) {
      const spot = await mid(underlying);
      const options = series.filter((i) => i.kind === "option");
      const atm = (right: "call" | "put") =>
        options.filter((i) => i.right === right).reduce((a, b) => (Math.abs(a.strike! - spot) <= Math.abs(b.strike! - spot) ? a : b)).symbol;
      round = { step: 0, listedAt: now, call: atm("call"), put: atm("put"), future: series.find((i) => i.kind === "future")!.symbol };
      rounds.set(key, round);
      await alice.market(round.call, "buy", 2);
      await alice.market(round.future, "buy", 3);
      await bob.market(round.put, "sell", 2);
      await bob.market(round.future, "sell", 3);
      continue;
    }
    const elapsed = (now - round.listedAt) / (expiry - round.listedAt);
    if (round.step === 0 && elapsed > 1 / 3) {
      round.step = 1;
      await alice.market(round.call, "sell", 1);
      await alice.market(round.future, "sell", 1);
      await bob.market(round.put, "buy", 1);
      await bob.market(round.future, "buy", 1);
    } else if (round.step === 1 && elapsed > 2 / 3) {
      round.step = 2;
      await alice.market(round.future, "sell", 1);
      await bob.market(round.future, "buy", 1);
    }
  }
}

async function top(symbol: string): Promise<{ bid?: number; ask?: number }> {
  const book = (await (await fetch(`${url}/api/book/${symbol}?levels=1`)).json()) as { bids: DepthLevel[]; asks: DepthLevel[] };
  return { bid: book.bids[0]?.price, ask: book.asks[0]?.price };
}

async function mid(symbol: string): Promise<number> {
  const { bid, ask } = await top(symbol);
  return bid !== undefined && ask !== undefined ? (bid + ask) / 2 : catalog.get(symbol)!.referencePrice;
}

// Once a second: every live option's best quotes against the no-arbitrage bounds, and the volatility its mid implies.
// The bounds are checked twice. At the stock's mid, which is strict: a stale quote counts the moment the
// stock moves past it. And against the stock's own quotes, which is what an arbitrage needs: buying a
// call below intrinsic value pays only if the stock can be sold above strike + ask, at its bid.
const quotes = { samples: 0, outsideBoundsAtMid: 0, executableArbitrage: 0, twoSided: 0 };
const makerQuotes = { samples: 0, outsideBoundsAtMid: 0, executableArbitrage: 0, twoSided: 0 };
// How often the contracts people trade most have a bid and an offer: the at-the-money call and put, and the future.
const liquidity = { atTheMoney: { samples: 0, twoSided: 0 }, future: { samples: 0, twoSided: 0 } };
const ivErrors: number[] = [];
const deskDelta: number[] = [];
const modelVolatility = annualizedVolatility(DEFAULT_DERIVATIVES_MAKER.defaultSigmaPct, 15);
async function sample(): Promise<void> {
  const now = Date.now();
  for (const desk of desks) deskDelta.push(Math.abs(desk.exposure().delta));
  for (const underlying of UNDERLYINGS) {
    const stock = await top(underlying);
    if (stock.bid === undefined || stock.ask === undefined) continue;
    const spot = (stock.bid + stock.ask) / 2;
    const live = [...catalog.values()].filter((i) => i.underlying === underlying && i.expiry! - now > DEFAULT_DERIVATIVES_MAKER.stopBeforeExpiryMs + 1_000);
    const strikes = live.filter((i) => i.kind === "option").map((i) => i.strike!);
    const atm = strikes.reduce((a, b) => (Math.abs(a - spot) <= Math.abs(b - spot) ? a : b), strikes[0] ?? 0);
    for (const i of live) {
      if (i.kind === "future") {
        const { bid, ask } = await top(i.symbol);
        liquidity.future.samples++;
        if (bid !== undefined && ask !== undefined) liquidity.future.twoSided++;
        continue;
      }
      const inputs = { right: i.right!, spot, strike: i.strike!, time: yearsUntil(i.expiry!, now) };
      const { lower, upper } = noArbitrageBounds(inputs);
      const { bid, ask } = await top(i.symbol);
      if (i.strike === atm) {
        liquidity.atTheMoney.samples++;
        if (bid !== undefined && ask !== undefined) liquidity.atTheMoney.twoSided++;
      }
      // With the rate at zero: a call's floor is S - K and ceiling S; a put's floor K - S and ceiling K.
      const call = i.right === "call";
      const strike = i.strike!;
      const check = (count: typeof quotes, best: { bid?: number; ask?: number }) => {
        for (const price of [best.bid, best.ask]) {
          if (price === undefined) continue;
          count.samples++;
          if (price < lower || price > upper) count.outsideBoundsAtMid++;
        }
        if (best.ask !== undefined && (call ? best.ask < stock.bid! - strike : best.ask < strike - stock.ask!)) count.executableArbitrage++;
        if (best.bid !== undefined && (call ? best.bid > stock.ask! : best.bid > strike)) count.executableArbitrage++;
      };
      // The book's best quotes, whoever posted them (noise traders' limit orders rest for seconds
      // and go stale as the stock moves), and the market maker's own best quotes alone.
      check(quotes, { bid, ask });
      const own = [...(desks.find((d) => d.underlying.symbol === underlying)?.trackers.find((t) => t.symbol === i.symbol)?.open.values() ?? [])];
      const ownBids = own.filter((o) => o.side === "buy").map((o) => o.price);
      const ownAsks = own.filter((o) => o.side === "sell").map((o) => o.price);
      const ownBid = ownBids.length > 0 ? Math.max(...ownBids) : undefined;
      const ownAsk = ownAsks.length > 0 ? Math.min(...ownAsks) : undefined;
      check(makerQuotes, { ...(ownBid === undefined ? {} : { bid: ownBid }), ...(ownAsk === undefined ? {} : { ask: ownAsk }) });
      if (bid !== undefined && ask !== undefined) quotes.twoSided++;
      if (ownBid === undefined || ownAsk === undefined) continue;
      makerQuotes.twoSided++;
      // The maker's own mid: other traders' orders in the book are not what the maker values with.
      const iv = impliedVolatility((ownBid + ownAsk) / 2, inputs);
      // Implied volatility is pinned down only where the price depends on it: near the money.
      if (iv === null) continue;
      const delta = Math.abs(greeks({ ...inputs, volatility: iv }).delta);
      if (delta >= 0.15 && delta <= 0.85) ivErrors.push(Math.abs(iv - modelVolatility) / modelVolatility);
    }
  }
}

const started = Date.now();
const end = started + minutes * 60_000;
console.log(`derivatives live check: ${minutes} min, ${cycleMs / 1000}s expiry cycle, gateway ${url}`);
await pause(3_000); // the makers' first quotes
while (Date.now() < end) {
  await retailRound();
  await sample();
  await pause(1_000);
}
// Let the last pushes arrive: accounts are sent every 250 ms when they change.
await pause(1_500);
const finalDelta = desks.map((d) => ({ underlying: d.underlying.symbol, hedgePosition: d.hedge.position, delta: Number(d.exposure().delta.toFixed(1)) }));
for (const stop of stoppers.reverse()) await stop();
await pause(500);
for (const ledger of ledgers.values()) ledger.settle();

const bySeries = new Map<string, { cash: number; contracts: number; holders: number }>();
for (const s of settlements) {
  const entry = bySeries.get(s.symbol) ?? { cash: 0, contracts: 0, holders: 0 };
  entry.cash += s.amount;
  entry.contracts += s.quantity;
  entry.holders++;
  bySeries.set(s.symbol, entry);
}
// How each expiry's price was set, from the public tape: a settlement off the VWAP basis means the stock
// did not trade in the minute before expiry, and the stock's largest gap between trades says when it stopped.
const expiryPrices = [
  ...new Map(
    settlements.map((s) => {
      const i = catalog.get(s.symbol)!;
      const prints = [...tape.get(i.underlying!)!.values()].filter((t) => t.time <= i.expiry!);
      const last = Math.max(...prints.map((t) => t.time));
      const entry = {
        underlying: i.underlying,
        expirySecondsIntoRun: Math.round((i.expiry! - started) / 1000),
        basis: s.basis,
        windowPrints: prints.filter((t) => t.time > i.expiry! - 60_000).length,
        lastPrintSecondsBeforeExpiry: prints.length === 0 ? null : (i.expiry! - last) / 1000,
      };
      return [`${i.underlying}@${i.expiry}`, entry] as const;
    }),
  ).values(),
];
const tapeGaps = Object.fromEntries(
  UNDERLYINGS.map((u) => {
    const times = [...tape.get(u)!.values()].map((t) => t.time).sort((a, b) => a - b);
    let gap = { seconds: 0, startsSecondsIntoRun: 0 };
    for (let k = 1; k < times.length; k++) {
      if (times[k]! - times[k - 1]! > gap.seconds * 1000) gap = { seconds: (times[k]! - times[k - 1]!) / 1000, startsSecondsIntoRun: Math.round((times[k - 1]! - started) / 1000) };
    }
    return [u, { trades: times.length, largestGap: gap }];
  }),
);
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))] ?? null;
const otherRejects = desks.flatMap((d) => [...d.rejectCounts].filter(([reason]) => reason !== "unknown_order"));
const summary = {
  minutes,
  cycleSeconds: cycleMs / 1000,
  expiriesSettled: new Set([...bySeries.keys()].map((s) => catalog.get(s)!.expiry)).size,
  seriesSettled: bySeries.size,
  trades,
  settlementMessages: settlements.length,
  settlementBasis: Object.fromEntries(["vwap", "last_trade", "reference"].map((b) => [b, settlements.filter((s) => s.basis === b).length])),
  // Every settlement message against the price recomputed from the trade stream, the trader's own position and the contract's terms.
  settlementChecks,
  expiryPrices,
  tapeGaps,
  // How many series the retail traders opened, partly closed once, and twice.
  retailRounds: { opened: rounds.size, firstClose: [...rounds.values()].filter((r) => r.step >= 1).length, secondClose: [...rounds.values()].filter((r) => r.step >= 2).length },
  // Zero-sum, for every settled series over all traders: premiums, realised futures P&L and settlements.
  largestNetCashPerSeries: Math.max(0, ...[...bySeries.keys()].map((s) => Math.abs(seriesCash.get(s) ?? 0))),
  // Every contract settled had a long and a short.
  largestNetContractsPerSeries: Math.max(0, ...[...bySeries.values()].map((e) => Math.abs(e.contracts))),
  // Option settlements alone net to zero too (intrinsic value x contracts); futures pay each side against its own average price.
  largestNetOptionSettlement: Math.max(0, ...[...bySeries].filter(([s]) => catalog.get(s)!.kind === "option").map(([, e]) => Math.abs(e.cash))),
  retail: Object.fromEntries(
    [alice, bob].map((r) => {
      const ledger = STARTING_CASH + r.ledger.cash;
      return [r.client.name, { ledgerCash: Number(ledger.toFixed(4)), gatewayCash: r.gatewayCash, difference: r.gatewayCash === null ? null : Math.abs(r.gatewayCash - ledger), rejects: r.rejects }];
    }),
  ),
  liquidity,
  makerOptionQuotes: makerQuotes,
  optionQuotes: { ...quotes,modelVolatility: Number(modelVolatility.toFixed(4)), ivRelativeErrorMedian: percentile(ivErrors, 0.5), ivRelativeErrorP90: percentile(ivErrors, 0.9), ivSamples: ivErrors.length },
  // The stock held to hedge and the delta left at the end, and |delta| sampled each second (the hedge threshold is 100 shares).
  desks: finalDelta,
  deskAbsDeltaMedian: percentile(deskDelta, 0.5),
  deskAbsDeltaMax: Math.max(0, ...deskDelta),
  deskRejectsOtherThanUnknownOrder: otherRejects,
};
console.log(JSON.stringify(summary, null, 2));
for (const c of clients) c.close();
await gateway.close();
await exchange.stop();
process.exit(0);
