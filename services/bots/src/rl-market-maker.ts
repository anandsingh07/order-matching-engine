import type { Instrument, TradingClient } from "@ome/client";
import type { Quote } from "./quotes.js";
import { QuotingBot } from "./quoting-bot.js";
import { avellanedaStoikov, FlowImbalance, observation, quotesFromAction, REFERENCE_VOL_BPS, type RlPolicy } from "./rl-policy.js";

export interface SingleQuoteParams {
  /** Quantity of one inventory unit: each quote is one unit, as in the training environment. */
  unitQuantity: number;
  /** Inventory limit, in units; the side that would grow it further stops quoting. */
  maxInventory: number;
  maxActionsPerSecond?: number;
}

/**
 * A market maker with one bid and one ask, set as distances from fair value
 * once a second: the setting the RL policy was trained in. Subclasses choose
 * the distances from what the bot can see: its inventory, the gateway's
 * volatility forecast, and the buy/sell imbalance of the public tape.
 */
abstract class SingleQuoteMaker extends QuotingBot {
  protected readonly flow = new FlowImbalance();
  private flowTimer: ReturnType<typeof setInterval> | undefined;
  private readonly offTrade: () => void;

  constructor(
    client: TradingClient,
    instrument: Instrument,
    fair: () => number,
    protected readonly params: SingleQuoteParams,
  ) {
    super(client, instrument, fair, params.maxActionsPerSecond ?? 20, 1_000);
    this.offTrade = client.on("trade", (m) => {
      if (m.symbol === instrument.symbol) this.flow.add(m.trade.side);
    });
  }

  /** Inventory in units of `unitQuantity`. */
  get inventory(): number {
    return Math.round(this.tracker.position / this.params.unitQuantity);
  }

  /** The gateway's 15-minute forecast in bps, or a typical level until there is one. */
  get forecastVolBps(): number {
    return this.sigmaPct === null ? REFERENCE_VOL_BPS : this.sigmaPct * 100;
  }

  /** Runs on its own clock: a step a second. */
  override start(): void {
    this.listen();
    this.flowTimer = setInterval(() => void this.step(), 1_000);
  }

  /** Subscribes to the tape; enough for a caller that drives `step` itself. */
  listen(): void {
    this.client.subscribe([`trades:${this.instrument.symbol}`]);
  }

  /** One second: close the second's tape imbalance, then requote. */
  async step(): Promise<void> {
    this.flow.tick();
    await this.requote();
  }

  override async stop(): Promise<void> {
    clearInterval(this.flowTimer);
    this.offTrade();
    await super.stop();
  }

  /** Distances of the bid and the ask from fair value, in bps. */
  protected abstract distances(): { bidBps: number; askBps: number } | Promise<{ bidBps: number; askBps: number }>;

  protected async desiredQuotes(): Promise<Quote[]> {
    const { bidBps, askBps } = await this.distances();
    const fair = this.fair();
    const tick = this.instrument.tickSize;
    const bid = Math.floor((fair * (1 - bidBps / 10_000)) / tick) * tick;
    let ask = Math.ceil((fair * (1 + askBps / 10_000)) / tick) * tick;
    if (ask <= bid) ask = bid + tick;
    const quotes: Quote[] = [];
    const quantity = this.params.unitQuantity;
    if (this.inventory < this.params.maxInventory && bid > 0) quotes.push({ side: "buy", price: bid, quantity });
    if (this.inventory > -this.params.maxInventory) quotes.push({ side: "sell", price: ask, quantity });
    return quotes;
  }
}

/** Quotes with the PPO policy trained in services/ai/rl. */
export class RlMarketMaker extends SingleQuoteMaker {
  constructor(
    client: TradingClient,
    instrument: Instrument,
    fair: () => number,
    params: SingleQuoteParams,
    private readonly policy: RlPolicy,
  ) {
    super(client, instrument, fair, params);
  }

  protected async distances(): Promise<{ bidBps: number; askBps: number }> {
    const obs = observation(this.inventory, this.params.maxInventory, this.forecastVolBps, this.flow.value);
    return quotesFromAction(await this.policy.act(obs));
  }
}

/** Quotes with the Avellaneda-Stoikov closed form, the baseline the policy is measured against. */
export class AvellanedaStoikovMaker extends SingleQuoteMaker {
  constructor(
    client: TradingClient,
    instrument: Instrument,
    fair: () => number,
    params: SingleQuoteParams,
    private readonly gamma: number,
    private readonly depthDecay: number,
  ) {
    super(client, instrument, fair, params);
  }

  protected distances(): { bidBps: number; askBps: number } {
    return avellanedaStoikov(this.inventory, this.forecastVolBps, this.gamma, this.depthDecay);
  }
}
