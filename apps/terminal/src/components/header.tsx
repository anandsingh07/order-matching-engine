import Link from "next/link";
import { useShallow } from "zustand/react/shallow";
import { isDerivative } from "@/lib/derivatives";
import { formatChange, formatPrice } from "@/lib/format";
import { useTerminal } from "@/lib/store";
import { PhaseBadge } from "./market-status";

export function Header() {
  const { instruments, symbol, lastPrice, statuses, trader, selectSymbol, disconnect } = useTerminal(
    useShallow((s) => ({
      instruments: s.instruments,
      symbol: s.symbol,
      lastPrice: s.lastPrice,
      statuses: s.statuses,
      trader: s.trader,
      selectSymbol: s.selectSymbol,
      disconnect: s.disconnect,
    })),
  );

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b-[3px] border-line bg-panel px-3">
      <span className="shrink-0 rounded border-2 border-ink bg-accent px-1.5 py-px font-display text-sm shadow-brutal-sm">OME.terminal</span>

      {/* Stocks and coins; their futures and options are in the bar below and the option chain. */}
      <nav aria-label="Instruments" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {instruments.filter((i) => !isDerivative(i)).map((i) => {
          const last = lastPrice[i.symbol];
          const up = last === undefined || last >= i.referencePrice;
          const active = i.symbol === symbol;
          return (
            <button
              key={i.symbol}
              onClick={() => selectSymbol(i.symbol)}
              aria-pressed={active}
              title={i.name}
              className={`flex shrink-0 items-baseline gap-2 rounded border-2 px-2.5 py-0.5 text-xs ${
                active ? "border-ink bg-accent text-ink shadow-brutal-sm" : "border-transparent text-muted hover:border-ink hover:bg-raised hover:text-text"
              }`}
            >
              <span className="font-semibold">{i.symbol}</span>
              <PhaseBadge status={statuses[i.symbol]} />
              {last !== undefined && (
                <>
                  <span className="num">{formatPrice(i, last)}</span>
                  <span className={`num ${up ? "text-buy" : "text-sell"}`}>{formatChange(last, i.referencePrice)}</span>
                </>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-3 text-xs font-semibold text-text">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border-2 border-ink bg-buy-fill" aria-hidden />
          Live
        </span>
        {/* Same tab, client-side: the session (and its WebSocket) carries over, so the page can join and highlight you. */}
        <Link href="/leaderboard" className="underline-offset-2 hover:underline">
          Leaderboard
        </Link>
        <a href="/surveillance" target="_blank" rel="noreferrer" className="hidden underline-offset-2 hover:underline md:inline">
          Surveillance
        </a>
        <span className="hidden font-normal text-muted sm:inline">
          {trader?.name} <span className="num">({trader?.id})</span>
        </span>
        <button onClick={disconnect} className="btn rounded bg-panel px-2 py-0.5 hover:bg-sell-fill">
          Disconnect
        </button>
      </div>
    </header>
  );
}
