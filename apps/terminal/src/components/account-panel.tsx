import { contractMultiplier, contractName, type Instrument } from "@ome/client";
import { useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { isDerivative } from "@/lib/derivatives";
import { formatAmount, formatPrice, formatQuantity, formatTime, humanize } from "@/lib/format";
import { averageFillPrice, isActive, type MyOrder } from "@/lib/orders";
import { useInstrument, useTerminal } from "@/lib/store";
import { Countdown } from "./countdown";

type Tab = "open" | "history" | "fills" | "positions" | "settlements";

/** How each kind of final settlement price was set, in words. */
const BASIS = { vwap: "1-minute average", last_trade: "last trade", reference: "reference price" } as const;

/** A position's symbol, with a future's or option's terms under it: what it is, its size and how long it has left. */
function ContractCell({ instrument }: { instrument: Instrument }) {
  if (!isDerivative(instrument)) return <>{instrument.symbol}</>;
  return (
    <span title={instrument.name}>
      {instrument.symbol}
      <span className="block text-[10px] text-muted">
        {contractName(instrument)} · ×{contractMultiplier(instrument)}
        {instrument.expiry !== undefined && (
          <>
            {" "}
            · <Countdown until={instrument.expiry} /> left
          </>
        )}
      </span>
    </span>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="px-3 py-6 text-center text-xs text-muted">{empty}</p>;
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-panel text-[11px] text-muted">
        <tr>
          {head.map((h, i) => (
            <th key={h} className={`px-3 py-1.5 font-normal ${i === 0 ? "text-left" : "text-right"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, r) => (
          <tr key={r} className="border-t border-line/15 hover:bg-raised/50">
            {cells.map((c, i) => (
              <td key={i} className={`num px-3 py-1.5 ${i === 0 ? "text-left" : "text-right"}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const sideCell = (side: "buy" | "sell") => <span className={side === "buy" ? "text-buy" : "text-sell"}>{side.toUpperCase()}</span>;

export function AccountPanel() {
  const [tab, setTab] = useState<Tab>("open");
  const { orders, fills, account, catalog, settlements, derivatives, cancelOrder } = useTerminal(
    useShallow((s) => ({
      orders: s.orders,
      fills: s.fills,
      account: s.account,
      catalog: s.catalog,
      settlements: s.settlements,
      derivatives: s.instruments.some(isDerivative),
      cancelOrder: s.cancelOrder,
    })),
  );
  // Expired series stay in the catalog, so their orders, fills and settlements still format.
  const instrument = new Map(Object.entries(catalog));
  const all = Object.values(orders).sort((a, b) => b.updatedAt - a.updatedAt);
  const open = all.filter(isActive);
  const done = all.filter((o) => !isActive(o));
  const held = account?.positions ?? [];

  const priceOf = (i: Instrument, o: MyOrder) =>
    o.price !== undefined ? formatPrice(i, o.price) : o.stopPrice !== undefined ? `stop ${formatPrice(i, o.stopPrice)}` : "market";

  const tabs: { id: Tab; label: string }[] = [
    { id: "open", label: `Open orders (${open.length})` },
    { id: "history", label: "Order history" },
    { id: "fills", label: `Fills (${fills.length})` },
    { id: "positions", label: "Positions" },
    ...(derivatives || settlements.length > 0 ? [{ id: "settlements" as const, label: `Settlements (${settlements.length})` }] : []),
  ];

  let content: ReactNode;
  if (tab === "open") {
    content = (
      <Table
        head={["Symbol", "Side", "Type", "Price", "Filled / Qty", "Status", ""]}
        empty="No open orders."
        rows={open.map((o) => {
          const i = instrument.get(o.symbol)!;
          return [
            o.symbol,
            sideCell(o.side),
            o.type,
            priceOf(i, o),
            `${formatQuantity(i, o.filled)} / ${formatQuantity(i, o.quantity)}`,
            humanize(o.status),
            <button key="cancel" onClick={() => void cancelOrder(o)} className="btn rounded bg-panel px-2 text-ink hover:bg-sell-fill">
              Cancel
            </button>,
          ];
        })}
      />
    );
  } else if (tab === "history") {
    content = (
      <Table
        head={["Time", "Symbol", "Side", "Type", "Price", "Avg fill", "Filled / Qty", "Status"]}
        empty="No finished orders yet."
        rows={done.map((o) => {
          const i = instrument.get(o.symbol)!;
          const avg = averageFillPrice(o);
          return [
            formatTime(o.updatedAt),
            o.symbol,
            sideCell(o.side),
            o.type,
            priceOf(i, o),
            avg === null ? "—" : formatPrice(i, Math.round(avg)),
            `${formatQuantity(i, o.filled)} / ${formatQuantity(i, o.quantity)}`,
            <span key="s" title={o.reason}>
              {humanize(o.status)}
              {o.reason !== undefined && o.reason !== "user" && <span className="text-muted"> · {humanize(o.reason).toLowerCase()}</span>}
            </span>,
          ];
        })}
      />
    );
  } else if (tab === "fills") {
    content = (
      <Table
        head={["Time", "Symbol", "Side", "Price", "Qty", "Liquidity"]}
        empty="No fills yet."
        rows={fills.map((f) => {
          const i = instrument.get(f.symbol)!;
          return [formatTime(f.time), f.symbol, sideCell(f.side), formatPrice(i, f.price), formatQuantity(i, f.quantity), f.liquidity];
        })}
      />
    );
  } else if (tab === "settlements") {
    content = (
      <Table
        head={["Time", "Symbol", "Contracts", "Settlement price", "Set by", "Cash"]}
        empty="Futures and options you hold at expiry are settled in cash, and listed here."
        rows={settlements.map((t) => {
          const i = instrument.get(t.symbol)!;
          return [
            formatTime(t.time),
            <span key="s" title={i.name}>
              {t.symbol}
              <span className="block text-[10px] text-muted">{contractName(i)}</span>
            </span>,
            <span key="q" className={t.quantity > 0 ? "text-buy" : t.quantity < 0 ? "text-sell" : ""}>
              {t.quantity}
            </span>,
            formatPrice(i, t.price),
            t.basis === undefined ? "—" : BASIS[t.basis],
            <span key="c" className={t.amount > 0 ? "text-buy" : t.amount < 0 ? "text-sell" : ""}>
              {formatAmount(t.amount)} {t.currency}
            </span>,
          ];
        })}
      />
    );
  } else {
    content = (
      <Table
        head={["Symbol", "Position", "Avg price", "Mark", "Unrealized P&L", "Realized P&L"]}
        empty="No positions. Trades you make appear here."
        rows={held.map((p) => {
          const i = instrument.get(p.symbol)!;
          const pnl = (v: number) => <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{formatAmount(v)}</span>;
          return [
            <ContractCell key="c" instrument={i} />,
            <span key="q" className={p.quantity > 0 ? "text-buy" : p.quantity < 0 ? "text-sell" : ""}>
              {formatQuantity(i, p.quantity)}
            </span>,
            p.quantity === 0 ? "—" : formatPrice(i, Math.round(p.averagePrice)),
            formatPrice(i, p.markPrice),
            pnl(p.unrealized),
            pnl(p.realized),
          ];
        })}
      />
    );
  }

  return (
    <section className="flex min-h-[220px] flex-1 flex-col bg-panel">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 border-b-2 border-line px-3">
        <div role="tablist" aria-label="Account" className="flex h-9 items-center gap-1.5 overflow-x-auto text-xs">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`shrink-0 rounded border-2 px-2 ${tab === t.id ? "border-ink bg-accent font-semibold text-ink shadow-brutal-sm" : "border-transparent text-muted hover:border-ink hover:text-text"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <AccountSummary />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{content}</div>
    </section>
  );
}

/** Balances in the selected instrument's currency. */
function AccountSummary() {
  const instrument = useInstrument();
  const account = useTerminal((s) => s.account);
  const balance = account?.balances.find((b) => b.currency === instrument?.currency);
  if (account === null || balance === undefined) return null;
  const item = (label: string, value: ReactNode) => (
    <span>
      {label} <span className="num text-text">{value}</span>
    </span>
  );
  return (
    <div aria-label="Account balance" className="flex flex-wrap gap-x-4 py-1 text-[11px] text-muted">
      {item("Cash", `${formatAmount(balance.cash)} ${balance.currency}`)}
      {item("Equity", formatAmount(balance.equity))}
      {item("Exposure", formatAmount(balance.exposure))}
      {/* Futures and options: initial margin, writing margin, and long options' value, all within exposure. */}
      {balance.margin !== undefined && balance.margin > 0 && item("Margin", formatAmount(balance.margin))}
      {item("Buying power", account.unlimited ? "Unlimited" : formatAmount(balance.buyingPower))}
    </div>
  );
}
