import {
  applyFill,
  contractMultiplier,
  FLAT,
  instrumentKind,
  type AccountSnapshot,
  type CurrencyBalance,
  type Execution,
  type Instrument,
  type Position,
  type Side,
} from "@ome/client";
import { intrinsicValue } from "./pricing.js";

export interface RiskOptions {
  /** Starting paper cash per currency, in major units (e.g. rupees). */
  startingCash: Record<string, number>;
  /** Maximum exposure as a multiple of equity; 1 means no leverage. */
  leverage: number;
  /** Largest single order per currency, in major units: the fat-finger check. */
  maxOrderValue: Record<string, number>;
  /** Liquidate an account whose exposure exceeds this multiple of its equity (or whose equity is gone). */
  liquidationRatio: number;
  /** Futures and short-option margin rates; see `marginRate`. Defaults to DEFAULT_MARGIN. */
  margin?: MarginSettings;
}

/**
 * Initial margin for futures (and the base of the short-option rule), as a
 * share of the underlying's value: `sigmas` forecast 15-minute moves of the
 * underlying, but at least `minPct`; `defaultPct` before there is a forecast.
 */
export interface MarginSettings {
  defaultPct: number;
  sigmas: number;
  minPct: number;
}

// 6 x the simulated stocks' normal 1.5% is 9%, close to the 10% used before a forecast exists.
export const DEFAULT_MARGIN: MarginSettings = { defaultPct: 10, sigmas: 6, minPct: 5 };

export const DEFAULT_RISK: RiskOptions = {
  startingCash: { INR: 1_000_000, USDT: 100_000 },
  leverage: 1,
  maxOrderValue: { INR: 500_000, USDT: 50_000 },
  liquidationRatio: 1.5,
  margin: DEFAULT_MARGIN,
};

/**
 * The margin rate for an underlying whose forecast 15-minute move is
 * `sigmaPct` percent (null before there is a forecast).
 *
 * Margin is there to cover the loss before a losing position can be closed,
 * so it scales with how far the price can move: like SPAN, a multiple of
 * the forecast move rather than a fixed percentage. The floor stops a
 * too-calm forecast from making leverage almost free.
 */
export function marginRate(sigmaPct: number | null, settings: MarginSettings = DEFAULT_MARGIN): number {
  if (sigmaPct === null) return settings.defaultPct / 100;
  return Math.max(settings.minPct, settings.sigmas * sigmaPct) / 100;
}

interface OpenOrder {
  symbol: string;
  side: Side;
  price: number;
  remaining: number;
  /** Sent but not yet answered by the exchange (see `reserve`); replaced by the real order once it rests. */
  reserved?: boolean;
}

interface Account {
  traderId: string;
  unlimited: boolean;
  /** Major units per currency. */
  cash: Map<string, number>;
  positions: Map<string, Position>;
  /** Resting orders by client order id; they count towards exposure. */
  open: Map<string, OpenOrder>;
  /**
   * Stop orders waiting for their trigger, by client order id. They need no
   * buying power until they trigger (and are checked when sent), but an
   * account holding one is not flat: it can still trade.
   */
  stops: Set<string>;
  liquidated: boolean;
}

export interface Liquidation {
  traderId: string;
  /** Resting orders to cancel first. */
  cancel: { symbol: string; clientOrderId: string }[];
  /** Then close every position at market. */
  close: { symbol: string; side: Side; quantity: number }[];
}

/** One account's position in an expired contract, closed by cash settlement. */
export interface SettledPosition {
  traderId: string;
  /** Contracts; negative for a short. */
  quantity: number;
  /** Cash paid (negative) or received, major units. */
  amount: number;
}

/**
 * Paper-trading accounts with pre-trade risk, kept up to date from the same
 * execution reports traders receive.
 *
 * Money is held per currency in major units. Equity is cash plus positions at
 * the mark price; exposure is the absolute value of positions plus resting
 * orders. An order is accepted only if exposure after it stays within
 * `leverage x equity`, except orders that only reduce a position, which never
 * need buying power (otherwise an account at its limit could not get out).
 * An order reduces only as far as the position is not already being closed
 * by the trader's other orders on that side: a holder of one contract who
 * sends thirty one-contract sells is opening a short of 29, and needs the
 * margin for it.
 *
 * Futures and options fit the same rule through their margin (`exposure`
 * counts `leverage x margin` for them, so margin must be covered by equity
 * whatever the leverage on shares):
 * - A future costs nothing to enter. Its equity is the variation P&L,
 *   quantity x (mark - average price) x multiplier, which moves into cash when
 *   the position is closed or settles. Its margin is `marginRate` x notional.
 * - An option buyer pays the premium, and a long option is fully paid: its
 *   value counts as margin, so it cannot be borrowed against.
 * - An option writer receives the premium (it is in cash, and the option's
 *   value is a liability in equity) and posts margin by the standard
 *   CBOE-style rule for uncovered options, with the futures rate in place of
 *   the fixed 20%: rate x underlying - out-of-the-money amount, but at least
 *   half the rate x underlying (calls) or x strike (puts).
 * Every position is margined on its own: spreads and covered calls get no
 * offset, which overstates the margin of hedged books but never understates it.
 */
export class Accounts {
  private readonly accounts = new Map<string, Account>();

  constructor(
    private readonly instruments: ReadonlyMap<string, Instrument>,
    /** Mark price in ticks for P&L and exposure: the last trade, or the reference price; for options a model value. */
    private readonly mark: (symbol: string) => number,
    private readonly risk: RiskOptions,
    /** Margin rate (a fraction) for futures and short options on an underlying. Defaults to the settings' rate before any forecast. */
    private readonly rate: (underlying: string) => number = () => marginRate(null, risk.margin),
  ) {}

  /**
   * Major-unit value of a price (in ticks) times a quantity (in units), times
   * the contract multiplier for derivatives. Multiplying the integers first
   * leaves a single rounding.
   */
  static value(instrument: Instrument, price: number, quantity: number): number {
    return (price * quantity * contractMultiplier(instrument)) / (instrument.priceScale * instrument.quantityScale);
  }

  open(traderId: string, unlimited: boolean): void {
    this.accounts.set(traderId, {
      traderId,
      unlimited,
      cash: new Map(Object.entries(this.risk.startingCash)),
      positions: new Map(),
      open: new Map(),
      stops: new Set(),
      liquidated: false,
    });
  }

  /** Whether the account holds no position, no resting or pending order, and no order in flight. */
  isFlat(traderId: string): boolean {
    const account = this.accounts.get(traderId);
    if (account === undefined) return false;
    return account.open.size === 0 && account.stops.size === 0 && [...account.positions.values()].every((p) => p.quantity === 0);
  }

  isUnlimited(traderId: string): boolean {
    return this.accounts.get(traderId)?.unlimited === true;
  }

  /**
   * Starts a flat account again with `cash` (major units per currency), as a
   * fresh account would: realised P&L and the liquidation flag are cleared.
   * Refused (false) unless the account is flat, because dropping a position
   * or an order would create or destroy value out of nothing.
   */
  reset(traderId: string, cash: Record<string, number>): boolean {
    const account = this.accounts.get(traderId);
    if (account === undefined || !this.isFlat(traderId)) return false;
    account.cash = new Map(Object.entries(cash));
    account.positions.clear();
    account.liquidated = false;
    return true;
  }

  /** Why a new order must be refused, or null if it may go ahead. */
  checkOrder(traderId: string, instrument: Instrument, side: Side, quantity: number, estimatedPrice: number): string | null {
    const account = this.accounts.get(traderId);
    if (account === undefined || account.unlimited) return null;
    // Notional for futures, premium for options: the fat-finger check is on what the order is worth.
    const value = Accounts.value(instrument, estimatedPrice, quantity);
    const cap = this.risk.maxOrderValue[instrument.currency];
    if (cap !== undefined && value > cap) return "order_too_large";
    if (this.reducible(account, instrument.symbol, side) >= quantity) return null;
    const { equity, exposure } = this.balance(account, instrument.currency);
    return exposure + this.orderExposure(instrument, side, estimatedPrice, quantity) > this.risk.leverage * equity ? "insufficient_buying_power" : null;
  }

  /**
   * Counts an order that passed `checkOrder` as resting, at the price it was
   * checked at, until the exchange has answered and `release` is called.
   * Execution reports only arrive with that answer, so without this a burst
   * of orders on one connection would each be checked against an account
   * that had not seen the others: every one "reducing" the same position, or
   * every one within the same buying power. Its fills count against it, and
   * a "rested" report replaces it with the real order. False if there is
   * nothing to track (no account, or an unlimited one).
   */
  reserve(traderId: string, clientOrderId: string, symbol: string, side: Side, price: number, quantity: number): boolean {
    const account = this.accounts.get(traderId);
    if (account === undefined || account.unlimited) return false;
    account.open.set(clientOrderId, { symbol, side, price, remaining: quantity, reserved: true });
    return true;
  }

  /** Drops a reservation the exchange has answered: if the order rested, it is no longer a reservation. */
  release(traderId: string, clientOrderId: string): void {
    const account = this.accounts.get(traderId);
    if (account?.open.get(clientOrderId)?.reserved === true) account.open.delete(clientOrderId);
  }

  /** Risk check for an amend: only the increase in the order's value needs buying power. */
  checkAmend(traderId: string, instrument: Instrument, clientOrderId: string, price?: number, quantity?: number): string | null {
    const account = this.accounts.get(traderId);
    const order = account?.open.get(clientOrderId);
    if (account === undefined || account.unlimited || order === undefined) return null;
    const before = this.orderExposure(instrument, order.side, order.price, order.remaining);
    const after = this.orderExposure(instrument, order.side, price ?? order.price, quantity ?? order.remaining);
    if (after <= before) return null;
    const cap = this.risk.maxOrderValue[instrument.currency];
    if (cap !== undefined && Accounts.value(instrument, price ?? order.price, quantity ?? order.remaining) > cap) return "order_too_large";
    // An order that, amended, still only closes what is not already being closed needs no buying power, as in checkOrder.
    if (this.reducible(account, instrument.symbol, order.side, clientOrderId) >= (quantity ?? order.remaining)) return null;
    const { equity, exposure } = this.balance(account, instrument.currency);
    return exposure + (after - before) > this.risk.leverage * equity ? "insufficient_buying_power" : null;
  }

  /** Applies an execution report for one of the trader's orders. */
  onExecution(traderId: string, clientOrderId: string, symbol: string, execution: Execution): void {
    const account = this.accounts.get(traderId);
    const instrument = this.instruments.get(symbol);
    if (account === undefined || instrument === undefined) return;
    switch (execution.event) {
      case "rested":
        account.open.set(clientOrderId, { symbol, side: execution.side, price: execution.price, remaining: execution.quantity });
        break;
      case "amended": {
        const order = account.open.get(clientOrderId);
        if (order !== undefined) {
          order.price = execution.price;
          order.remaining = execution.quantity;
        }
        break;
      }
      case "stop_pending":
        account.stops.add(clientOrderId);
        break;
      case "triggered":
        // From here it is an ordinary order: it rests (and is tracked as open) or fills.
        account.stops.delete(clientOrderId);
        break;
      case "cancelled":
      case "rejected":
        account.open.delete(clientOrderId);
        account.stops.delete(clientOrderId);
        break;
      case "fill": {
        const before = account.positions.get(symbol) ?? FLAT;
        const after = applyFill(before, execution.side, execution.price, execution.quantity);
        account.positions.set(symbol, after);
        const cash = account.cash.get(instrument.currency) ?? 0;
        if (instrumentKind(instrument) === "future") {
          // No money changes hands for a future, except the P&L a fill realises.
          account.cash.set(instrument.currency, cash + Accounts.value(instrument, after.realized - before.realized, 1));
        } else {
          const signed = execution.side === "buy" ? 1 : -1;
          account.cash.set(instrument.currency, cash - signed * Accounts.value(instrument, execution.price, execution.quantity));
        }
        const order = account.open.get(clientOrderId);
        if (order !== undefined) {
          order.remaining -= execution.quantity;
          if (order.remaining <= 0) account.open.delete(clientOrderId);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Cash-settles every position in an expired future or option at the final
   * `price` of the underlying (in ticks), and removes the positions. A future
   * pays its variation since the average price; an option pays its intrinsic
   * value, from the writer to the holder. Resting orders must already have
   * been cancelled; any left are dropped.
   */
  settle(symbol: string, price: number): SettledPosition[] {
    const instrument = this.instruments.get(symbol);
    if (instrument === undefined) return [];
    const out: SettledPosition[] = [];
    for (const account of this.accounts.values()) {
      for (const [id, order] of account.open) if (order.symbol === symbol) account.open.delete(id);
      const position = account.positions.get(symbol);
      if (position === undefined) continue;
      account.positions.delete(symbol);
      if (position.quantity === 0) continue;
      const owed =
        instrumentKind(instrument) === "future"
          ? Accounts.value(instrument, price - position.averagePrice, position.quantity)
          : Accounts.value(instrument, intrinsicValue(instrument.right ?? "call", price, instrument.strike ?? 0), position.quantity);
      // A worthless option written short would otherwise owe -0.
      const amount = owed === 0 ? 0 : owed;
      account.cash.set(instrument.currency, (account.cash.get(instrument.currency) ?? 0) + amount);
      out.push({ traderId: account.traderId, quantity: position.quantity, amount });
    }
    return out;
  }

  snapshot(traderId: string): AccountSnapshot | undefined {
    const account = this.accounts.get(traderId);
    if (account === undefined) return undefined;
    const currencies = new Set([...account.cash.keys(), ...[...account.positions.keys()].map((s) => this.instruments.get(s)!.currency)]);
    const balances: CurrencyBalance[] = [...currencies].map((currency) => {
      const { cash, equity, exposure, margin } = this.balance(account, currency);
      return { currency, cash, equity, exposure, buyingPower: Math.max(0, this.risk.leverage * equity - exposure), margin };
    });
    const positions = [...account.positions].flatMap(([symbol, p]) => {
      if (p.quantity === 0 && p.realized === 0) return [];
      const instrument = this.instruments.get(symbol)!;
      const mark = this.mark(symbol);
      const scale = (instrument.priceScale * instrument.quantityScale) / contractMultiplier(instrument);
      return [
        {
          symbol,
          quantity: p.quantity,
          averagePrice: p.averagePrice,
          realized: p.realized / scale,
          unrealized: p.quantity === 0 ? 0 : (p.quantity * (mark - p.averagePrice)) / scale,
          markPrice: mark,
        },
      ];
    });
    return { traderId, unlimited: account.unlimited, balances, positions, liquidated: account.liquidated };
  }

  /**
   * Standard accounts in breach of margin: equity gone while still exposed, or
   * exposure above `liquidationRatio x equity` in any currency. Each comes
   * with the orders to cancel and the positions to close.
   *
   * For a futures position at leverage 1 this is the maintenance margin: the
   * account is closed out once its equity falls below 1 / liquidationRatio
   * (two thirds, by default) of the initial margin.
   */
  breaches(): Liquidation[] {
    const out: Liquidation[] = [];
    for (const account of this.accounts.values()) {
      if (account.unlimited) continue;
      const currencies = new Set([...account.positions.keys()].map((s) => this.instruments.get(s)!.currency));
      const breached = [...currencies].some((currency) => {
        const { equity, exposure } = this.balance(account, currency);
        return exposure > 0 && (equity <= 0 || exposure > this.risk.liquidationRatio * equity);
      });
      if (!breached) continue;
      out.push({
        traderId: account.traderId,
        cancel: [...account.open].map(([clientOrderId, o]) => ({ symbol: o.symbol, clientOrderId })),
        close: [...account.positions]
          .filter(([, p]) => p.quantity !== 0)
          .map(([symbol, p]) => ({ symbol, side: p.quantity > 0 ? ("sell" as const) : ("buy" as const), quantity: Math.abs(p.quantity) })),
      });
    }
    return out;
  }

  markLiquidated(traderId: string): void {
    const account = this.accounts.get(traderId);
    if (account !== undefined) account.liquidated = true;
  }

  /**
   * How much of a position an order on `side` can still close: the position
   * held on the other side, less what the trader's open orders on this side
   * would already close (so no one-contract order is "reducing" a position
   * that thirty others are closing too).
   */
  private reducible(account: Account, symbol: string, side: Side, except?: string): number {
    const held = account.positions.get(symbol)?.quantity ?? 0;
    let pending = 0;
    for (const [id, order] of account.open) if (id !== except && order.symbol === symbol && order.side === side) pending += order.remaining;
    return (side === "sell" ? held : -held) - pending;
  }

  /** Futures initial margin for `quantity` contracts at `price`, major units. */
  private futuresMargin(instrument: Instrument, price: number, quantity: number): number {
    return this.rate(instrument.underlying ?? instrument.symbol) * Accounts.value(instrument, price, quantity);
  }

  /** Margin for writing `quantity` uncovered options, at the underlying's current price; major units. */
  private shortOptionMargin(instrument: Instrument, quantity: number): number {
    const underlying = this.mark(instrument.underlying ?? instrument.symbol);
    const strike = instrument.strike ?? 0;
    const call = instrument.right !== "put";
    const rate = this.rate(instrument.underlying ?? instrument.symbol);
    const outOfTheMoney = Math.max(0, call ? strike - underlying : underlying - strike);
    const perUnit = Math.max(rate * underlying - outOfTheMoney, (rate / 2) * (call ? underlying : strike));
    return Accounts.value(instrument, perUnit, quantity);
  }

  /** The margin a derivatives order needs if it all fills: futures margin, an option's premium, or writing margin. */
  private orderMargin(instrument: Instrument, side: Side, price: number, quantity: number): number {
    if (instrumentKind(instrument) === "future") return this.futuresMargin(instrument, price, quantity);
    return side === "buy" ? Accounts.value(instrument, price, quantity) : this.shortOptionMargin(instrument, quantity);
  }

  /** What a resting or new order adds to exposure if it all fills. */
  private orderExposure(instrument: Instrument, side: Side, price: number, quantity: number): number {
    if (instrumentKind(instrument) === "spot") return Accounts.value(instrument, price, quantity);
    return this.risk.leverage * this.orderMargin(instrument, side, price, quantity);
  }

  private balance(account: Account, currency: string): { cash: number; equity: number; exposure: number; margin: number } {
    const cash = account.cash.get(currency) ?? 0;
    let equity = cash;
    let exposure = 0;
    let margin = 0;
    for (const [symbol, position] of account.positions) {
      const instrument = this.instruments.get(symbol)!;
      if (instrument.currency !== currency || position.quantity === 0) continue;
      const mark = this.mark(symbol);
      switch (instrumentKind(instrument)) {
        case "spot": {
          const value = Accounts.value(instrument, mark, position.quantity);
          equity += value;
          exposure += Math.abs(value);
          break;
        }
        case "future":
          equity += Accounts.value(instrument, mark - position.averagePrice, position.quantity);
          margin += this.futuresMargin(instrument, mark, Math.abs(position.quantity));
          break;
        case "option": {
          const value = Accounts.value(instrument, mark, position.quantity);
          equity += value;
          margin += position.quantity > 0 ? value : this.shortOptionMargin(instrument, -position.quantity);
          break;
        }
      }
    }
    for (const order of account.open.values()) {
      const instrument = this.instruments.get(order.symbol);
      // Settlement drops a series' orders before it is delisted, so this should never happen; but one stray
      // order must not make every balance throw, which would stop account updates and liquidation for everyone.
      if (instrument === undefined || instrument.currency !== currency) continue;
      if (instrumentKind(instrument) === "spot") exposure += Accounts.value(instrument, order.price, order.remaining);
      else margin += this.orderMargin(instrument, order.side, order.price, order.remaining);
    }
    exposure += this.risk.leverage * margin;
    return { cash, equity, exposure, margin };
  }
}
