import { TradingClient, type Instrument } from "@ome/client";
import { Exchange } from "@ome/exchange";
import { DEFAULT_INSTRUMENTS, Gateway } from "@ome/gateway";
import { beforeAll, describe, expect, it } from "vitest";
import { avellanedaStoikov, FlowImbalance, NoiseTrader, observation, prng, quotesFromAction, RlMarketMaker, RlPolicy } from "../src/index.js";

let policy: RlPolicy;
beforeAll(async () => {
  policy = await RlPolicy.load();
});

describe("parity with the Python training environment", () => {
  it("builds the same observations, takes the same actions and sets the same quotes", async () => {
    const max = policy.manifest.environment.max_inventory;
    for (const g of policy.manifest.golden) {
      // The golden cases record the observation; recover the raw inputs from it and rebuild it here.
      const [inv, logVol, imbalance] = g.obs as [number, number, number];
      expect(observation(Math.round(inv * max), max, 20 * Math.exp(logVol), imbalance).map((v) => Math.fround(v))).toEqual(
        g.obs.map((v) => expect.closeTo(v, 6)),
      );
      const action = await policy.act(g.obs);
      action.forEach((v, j) => expect(v).toBeCloseTo(g.action[j]!, 5));
      const { bidBps, askBps } = quotesFromAction(g.action);
      expect(bidBps).toBeCloseTo(g.quotes[0], 9);
      expect(askBps).toBeCloseTo(g.quotes[1], 9);
    }
  });

  it("maps actions to quotes like the environment", () => {
    expect(quotesFromAction([-1, 0])).toEqual({ bidBps: expect.closeTo(0.25), askBps: expect.closeTo(0.25) });
    expect(quotesFromAction([1, 0])).toEqual({ bidBps: expect.closeTo(25), askBps: expect.closeTo(25) });
    expect(quotesFromAction([0, 0])).toEqual({ bidBps: expect.closeTo(2.5), askBps: expect.closeTo(2.5) }); // geometric middle
    expect(quotesFromAction([0, 1])).toEqual({ bidBps: expect.closeTo(12.5), askBps: 0 }); // leaning to sell, ask at the mid
    expect(quotesFromAction([5, -5])).toEqual(quotesFromAction([1, -1])); // clipped
  });

  it("computes the tape imbalance as the environment does", () => {
    const flow = new FlowImbalance();
    expect(flow.value).toBe(0);
    flow.add("buy");
    flow.add("buy");
    flow.add("sell");
    flow.tick(); // buys 0.2, sells 0.1
    expect(flow.value).toBeCloseTo(1 / 3);
    flow.tick(); // both decay alike
    expect(flow.value).toBeCloseTo(1 / 3);
  });
});

describe("Avellaneda-Stoikov", () => {
  it("widens with volatility and shifts quotes against inventory", () => {
    const flat = avellanedaStoikov(0, 20, 0.03, 0.5);
    expect(flat.bidBps).toBeCloseTo(flat.askBps);
    // Half spread = gamma sigma^2 T / 2 + ln(1 + gamma / k) / gamma, with sigma per second = 20 / sqrt(900).
    expect(flat.bidBps).toBeCloseTo((0.5 * 0.03 * (20 / 30) ** 2 * 60) + Math.log(1 + 0.03 / 0.5) / 0.03);
    expect(avellanedaStoikov(0, 60, 0.03, 0.5).bidBps).toBeGreaterThan(flat.bidBps);
    const long = avellanedaStoikov(5, 20, 0.03, 0.5);
    expect(long.askBps).toBeLessThan(flat.askBps); // keen to sell
    expect(long.bidBps).toBeGreaterThan(flat.bidBps); // reluctant to buy
  });
});

describe("the trained policy", () => {
  const quotes = async (inventory: number, vol: number, imbalance: number) =>
    quotesFromAction(await policy.act(observation(inventory, policy.manifest.environment.max_inventory, vol, imbalance)));

  it("learned inventory control: when long it quotes to sell, when short to buy", async () => {
    const long = await quotes(8, 20, 0);
    const short = await quotes(-8, 20, 0);
    expect(long.askBps).toBeLessThan(short.askBps);
    expect(long.bidBps).toBeGreaterThan(short.bidBps);
  });

  it("learned to read the tape: buyers dominating moves both quotes up (away from being short into a rise)", async () => {
    const buyers = await quotes(0, 20, 0.6);
    const sellers = await quotes(0, 20, -0.6);
    expect(buyers.askBps).toBeGreaterThan(sellers.askBps);
    expect(buyers.bidBps).toBeLessThan(sellers.bidBps);
  });

  it("quotes a valid two-sided market on a real gateway", async () => {
    const exchange = Exchange.start({ symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol), workers: 1 });
    const gateway = await Gateway.create({ exchange, bookIntervalMs: 20, botKey: "k" });
    const url = await gateway.listen(0);
    const btc = DEFAULT_INSTRUMENTS.find((i) => i.symbol === "BTCUSDT") as Instrument;
    try {
      const client = await TradingClient.connect(url, "rl", { botKey: "k" });
      const maker = new RlMarketMaker(client, btc, () => btc.referencePrice, { unitQuantity: 2_000, maxInventory: 10 }, policy);
      maker.listen();
      const noiseClient = await TradingClient.connect(url, "noise", { botKey: "k" });
      const noise = new NoiseTrader(noiseClient, [btc], prng(3), { meanIntervalMs: 20, maxLots: 1, marketShare: 1, restMs: 100, lotMultiplier: { BTCUSDT: 2_000 } });
      noise.start();
      for (let i = 0; i < 20; i++) {
        await maker.step();
        await new Promise((r) => setTimeout(r, 50));
      }
      noise.stop();
      const book = (await (await fetch(`${url}/api/book/BTCUSDT`)).json()) as { bids: { price: number }[]; asks: { price: number }[] };
      expect(maker.tracker.fills).toBeGreaterThan(0);
      expect(Math.abs(maker.tracker.position)).toBeLessThanOrEqual(10 * 2_000 + 2_000);
      if (book.bids[0] !== undefined && book.asks[0] !== undefined) expect(book.bids[0].price).toBeLessThan(book.asks[0].price);
      expect([...maker.rejectCounts.keys()].filter((r) => r !== "unknown_order")).toEqual([]);
      await maker.stop();
      client.close();
      noiseClient.close();
    } finally {
      await gateway.close();
      await exchange.stop();
    }
  }, 30_000);
});
