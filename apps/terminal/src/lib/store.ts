import {
  TradingClient,
  type AccountSnapshot,
  type Candle,
  type ClientOrder,
  type DepthLevel,
  type Instrument,
  type MarketStatus,
  type PublicTrade,
  type ServerMessage,
  type Settlement,
  type Side,
} from "@ome/client";
import { create } from "zustand";
import { chunks, marketChannels, underlyingOf } from "./derivatives";
import type { OrderForm } from "./order-form";
import { applyExecution, newOrder, type MyOrder } from "./orders";

export type Interval = "5s" | "1m";

export interface Fill {
  key: string;
  symbol: string;
  clientOrderId: string;
  side: Side;
  price: number;
  quantity: number;
  liquidity: "maker" | "taker";
  time: number;
}

export interface Notice {
  id: number;
  kind: "error" | "info";
  text: string;
}

interface TerminalState {
  url: string;
  status: "idle" | "connecting" | "connected" | "closed" | "error";
  error: string | null;
  client: TradingClient | null;
  trader: { id: string; name: string } | null;
  /** What trades now: the stocks, and the futures and options series currently listed. */
  instruments: Instrument[];
  /**
   * Every instrument seen this session, expired series included, so orders,
   * fills and settlements on a series that has gone still display.
   */
  catalog: Record<string, Instrument>;
  symbol: string;
  interval: Interval;
  books: Record<string, { bids: DepthLevel[]; asks: DepthLevel[] }>;
  /** Newest first. */
  trades: Record<string, PublicTrade[]>;
  /** Keyed by "<symbol>:<interval>". Subscribed channels only, each absent until the gateway's history for it arrives. */
  candles: Record<string, Candle[]>;
  lastPrice: Record<string, number>;
  orders: Record<string, MyOrder>;
  /** Newest first. */
  fills: Fill[];
  /** The gateway's authoritative account: cash, positions and P&L. */
  account: AccountSnapshot | null;
  /** Trading phase per symbol (continuous, or an auction and why). */
  statuses: Record<string, MarketStatus>;
  notices: Notice[];
  /** Futures and options this trader held at expiry and how they were cash-settled. Newest first. */
  settlements: (Settlement & { key: string })[];
  /**
   * Set when a book row or an option-chain quote is clicked (a price and side),
   * or a typed order is confirmed (the whole form); the order form for `symbol` copies it.
   */
  prefill: Prefill | null;

  connect(name: string): Promise<void>;
  disconnect(): void;
  selectSymbol(symbol: string): void;
  selectInterval(interval: Interval): void;
  placeOrder(symbol: string, order: ClientOrder): Promise<boolean>;
  cancelOrder(order: MyOrder): Promise<void>;
  prefillFromBook(price: number, side: Side): void;
  /** Selects a contract from the option chain, and fills in the ticket to trade at `price` when one is given. */
  pickContract(symbol: string, price: number | null, side: Side): void;
  /** Selects `symbol` and fills in its whole ticket, from a confirmed plain-English order. Sends nothing. */
  prefillTicket(symbol: string, form: OrderForm): void;
  notify(kind: Notice["kind"], text: string): void;
  dismiss(id: number): void;
}

export type Prefill = { symbol: string; nonce: number } & ({ from: "book"; price: number; side: Side } | { from: "text"; form: OrderForm });

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8080";
const MAX_TRADES = 100;
const MAX_FILLS = 200;
const MAX_SETTLEMENTS = 100;
let nextNotice = 1;
/** Prefills are told apart by this, so two clicks in the same millisecond still both apply. */
let nextPrefill = 1;

const bySymbol = (instruments: Instrument[]) => Object.fromEntries(instruments.map((i) => [i.symbol, i]));

export const useTerminal = create<TerminalState>()((set, get) => {
  /** Book and candle channels this connection is subscribed to (trades are subscribed for every symbol). */
  let subscribed = new Set<string>();

  /**
   * Brings the subscriptions in line with the selection: the selected
   * symbol's book and candles, and every book its option chain shows.
   * Only the difference is sent, so a book both need is never dropped.
   */
  function resubscribe(): void {
    const { client, instruments, symbol, interval } = get();
    if (client === null) return;
    const wanted = new Set(marketChannels(instruments, symbol, interval));
    const stale = [...subscribed].filter((c) => !wanted.has(c));
    if (stale.length > 0) client.unsubscribe(stale);
    for (const part of chunks([...wanted].filter((c) => !subscribed.has(c)))) client.subscribe(part);
    subscribed = wanted;
    // Candles go with their subscription: kept, they would go stale, and the
    // chart tells a history that is still on its way by its absence.
    const { candles } = get();
    const kept = Object.keys(candles).filter((key) => wanted.has(`candles:${key}`));
    if (kept.length < Object.keys(candles).length) set({ candles: Object.fromEntries(kept.map((key) => [key, candles[key]!])) });
  }

  /**
   * The gateway listed or expired futures and options. New series need their
   * trades; if the selected series expired, the terminal moves to its
   * underlying rather than showing a market that no longer exists.
   */
  function relist(instruments: Instrument[]): void {
    const { client, instruments: before, symbol, catalog } = get();
    const known = new Set(before.map((i) => i.symbol));
    const added = instruments.filter((i) => !known.has(i.symbol));
    for (const part of chunks(added.map((i) => `trades:${i.symbol}`))) client?.subscribe(part);
    const listed = new Set(instruments.map((i) => i.symbol));
    // The gateway drops a delisted symbol's channels itself.
    for (const channel of subscribed) if (!listed.has(channel.split(":")[1]!)) subscribed.delete(channel);
    // An expired series' book and tape are gone for good; a long session would otherwise keep them all.
    const live = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([symbol]) => listed.has(symbol)));
    set((s) => ({ instruments, catalog: { ...catalog, ...bySymbol(instruments) }, books: live(s.books), trades: live(s.trades) }));
    if (symbol !== "" && !listed.has(symbol)) {
      const old = catalog[symbol];
      const next = old !== undefined && listed.has(underlyingOf(old)) ? underlyingOf(old) : (instruments[0]?.symbol ?? "");
      set({ symbol: next, prefill: null });
      get().notify("info", `${symbol} has expired; showing ${next}.`);
    }
    resubscribe();
  }

  /** Folds one server message into state. */
  function receive(m: ServerMessage): void {
    switch (m.type) {
      case "book":
        set((s) => ({ books: { ...s.books, [m.symbol]: { bids: m.bids, asks: m.asks } } }));
        break;
      case "trades":
        set((s) => ({
          trades: { ...s.trades, [m.symbol]: [...m.trades].reverse().slice(0, MAX_TRADES) },
          ...(m.trades.length > 0 ? { lastPrice: { ...s.lastPrice, [m.symbol]: m.trades.at(-1)!.price } } : {}),
        }));
        break;
      case "trade":
        set((s) => ({
          trades: { ...s.trades, [m.symbol]: [m.trade, ...(s.trades[m.symbol] ?? [])].slice(0, MAX_TRADES) },
          lastPrice: { ...s.lastPrice, [m.symbol]: m.trade.price },
        }));
        break;
      case "candles":
        // Late messages for a channel just unsubscribed would bring back candles that no longer update.
        if (!subscribed.has(`candles:${m.symbol}:${m.interval}`)) break;
        set((s) => ({ candles: { ...s.candles, [`${m.symbol}:${m.interval}`]: m.candles } }));
        break;
      case "candle":
        if (!subscribed.has(`candles:${m.symbol}:${m.interval}`)) break;
        set((s) => {
          const key = `${m.symbol}:${m.interval}`;
          const list = s.candles[key] ?? [];
          const last = list.at(-1);
          const next = last !== undefined && last.time === m.candle.time ? [...list.slice(0, -1), m.candle] : [...list, m.candle];
          return { candles: { ...s.candles, [key]: next.slice(-1_000) } };
        });
        break;
      case "execution":
        set((s) => {
          const orders = { ...s.orders, [m.clientOrderId]: applyExecution(s.orders[m.clientOrderId], m) };
          if (m.event !== "fill") return { orders };
          const fill: Fill = {
            key: `${m.clientOrderId}:${m.time}:${s.fills.length}`,
            symbol: m.symbol,
            clientOrderId: m.clientOrderId,
            side: m.side,
            price: m.price,
            quantity: m.quantity,
            liquidity: m.liquidity,
            time: m.time,
          };
          return { orders, fills: [fill, ...s.fills].slice(0, MAX_FILLS) };
        });
        break;
      case "account":
        set({ account: { traderId: m.traderId, unlimited: m.unlimited, balances: m.balances, positions: m.positions, liquidated: m.liquidated } });
        break;
      case "status": {
        const status: MarketStatus = {
          symbol: m.symbol,
          phase: m.phase,
          reason: m.reason,
          until: m.until,
          referencePrice: m.referencePrice,
          indicative: m.indicative,
          bandPct: m.bandPct,
          breakerPct: m.breakerPct,
          volatility: m.volatility,
          // Derivatives: the band as prices (an option's is not symmetric around its reference).
          ...(m.band === undefined ? {} : { band: m.band }),
        };
        set((s) => ({ statuses: { ...s.statuses, [m.symbol]: status } }));
        break;
      }
      case "instruments":
        relist(m.instruments);
        break;
      case "settlement": {
        const settlement = {
          key: `${m.symbol}:${m.time}`,
          symbol: m.symbol,
          price: m.price,
          ...(m.basis === undefined ? {} : { basis: m.basis }),
          quantity: m.quantity,
          amount: m.amount,
          currency: m.currency,
          time: m.time,
        };
        set((s) => ({ settlements: [settlement, ...s.settlements].slice(0, MAX_SETTLEMENTS) }));
        break;
      }
      case "notice":
        get().notify(m.level === "warning" ? "error" : "info", m.text);
        break;
      case "error":
        if (m.reqId === undefined) get().notify("error", m.message);
        break;
      default:
        break;
    }
  }

  return {
    url: GATEWAY_URL,
    status: "idle",
    error: null,
    client: null,
    trader: null,
    instruments: [],
    catalog: {},
    symbol: "",
    interval: "5s",
    books: {},
    trades: {},
    candles: {},
    lastPrice: {},
    orders: {},
    fills: [],
    account: null,
    statuses: {},
    notices: [],
    settlements: [],
    prefill: null,

    async connect(name) {
      set({ status: "connecting", error: null });
      try {
        const instruments = await TradingClient.instruments(GATEWAY_URL);
        // Clear these before connecting, not after: the gateway sends the
        // account and market statuses straight after the welcome.
        set({ account: null, statuses: {} });
        const client = await TradingClient.connect(GATEWAY_URL, name);
        // A series selected in an earlier session may have expired since.
        const previous = get().symbol;
        const symbol = instruments.some((i) => i.symbol === previous) ? previous : (instruments[0]?.symbol ?? "");
        client.onMessage(receive);
        // Closing a socket we replaced or disconnected on purpose is not an error.
        client.onClose(() => {
          if (get().client === client) set({ status: "closed", client: null, error: "Connection to the gateway was lost." });
        });
        set({
          client,
          instruments,
          catalog: { ...get().catalog, ...bySymbol(instruments) },
          symbol,
          status: "connected",
          trader: { id: client.traderId, name },
          // A new session is a new trader: start with a clean slate.
          candles: {},
          orders: {},
          fills: [],
          settlements: [],
          prefill: null,
        });
        subscribed = new Set();
        for (const part of chunks(instruments.map((i) => `trades:${i.symbol}`))) client.subscribe(part);
        resubscribe();
      } catch (error) {
        set({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    },

    disconnect() {
      const client = get().client;
      set({ client: null, status: "idle", error: null });
      client?.close();
    },

    selectSymbol(symbol) {
      if (symbol === get().symbol) return;
      set({ symbol, prefill: null });
      resubscribe();
    },

    selectInterval(interval) {
      if (interval === get().interval) return;
      set({ interval });
      resubscribe();
    },

    async placeOrder(symbol, order) {
      const client = get().client;
      if (client === null) return false;
      const id = client.newOrderId("w");
      set((s) => ({ orders: { ...s.orders, [id]: newOrder(symbol, id, order, Date.now()) } }));
      const result = await client.placeOrder(symbol, id, order);
      if (result.type === "ack") return true;
      const reason = result.type === "reject" ? result.reason : result.message;
      set((s) => ({ orders: { ...s.orders, [id]: { ...s.orders[id]!, status: "rejected", reason } } }));
      get().notify("error", `Order rejected: ${reason.replaceAll("_", " ")}`);
      return false;
    },

    async cancelOrder(order) {
      const result = await get().client?.cancel(order.symbol, order.clientOrderId);
      if (result !== undefined && result.type !== "ack") {
        get().notify("error", `Cancel failed: ${(result.type === "reject" ? result.reason : result.message).replaceAll("_", " ")}`);
      }
    },

    prefillFromBook(price, side) {
      set({ prefill: { symbol: get().symbol, from: "book", price, side, nonce: nextPrefill++ } });
    },

    pickContract(symbol, price, side) {
      get().selectSymbol(symbol);
      // After selecting: a new symbol clears the prefill.
      if (price !== null) set({ prefill: { symbol, from: "book", price, side, nonce: nextPrefill++ } });
    },

    prefillTicket(symbol, form) {
      get().selectSymbol(symbol);
      set({ prefill: { symbol, from: "text", form, nonce: nextPrefill++ } });
    },

    notify(kind, text) {
      const id = nextNotice++;
      set((s) => ({ notices: [...s.notices, { id, kind, text }].slice(-4) }));
      setTimeout(() => get().dismiss(id), 4_000);
    },

    dismiss(id) {
      set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
    },
  };
});

export function useInstrument(): Instrument | undefined {
  return useTerminal((s) => s.instruments.find((i) => i.symbol === s.symbol));
}
