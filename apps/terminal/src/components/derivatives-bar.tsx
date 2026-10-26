import { contractName, instrumentKind } from "@ome/client";
import { useShallow } from "zustand/react/shallow";
import { isDerivative } from "@/lib/derivatives";
import { formatChange, formatPrice, formatTime } from "@/lib/format";
import { useTerminal } from "@/lib/store";
import { Countdown } from "./countdown";
import { PhaseBadge } from "./market-status";

/**
 * The futures and options listed now, under the stocks in the header. Each
 * underlying's future is a button like a stock's; options are picked from
 * the option chain, and the selected one shows here too. The countdown runs
 * to the expiry, when trading stops and every position is cash-settled; a
 * new series is listed straight after.
 */
export function DerivativesBar() {
  const { instruments, symbol, lastPrice, statuses, selectSymbol } = useTerminal(
    useShallow((s) => ({
      instruments: s.instruments,
      symbol: s.symbol,
      lastPrice: s.lastPrice,
      statuses: s.statuses,
      selectSymbol: s.selectSymbol,
    })),
  );
  const derivatives = instruments.filter(isDerivative);
  if (derivatives.length === 0) return null;
  const futures = derivatives.filter((i) => instrumentKind(i) === "future");
  const option = derivatives.find((i) => i.symbol === symbol && instrumentKind(i) === "option");
  const shown = option === undefined ? futures : [...futures, option];
  const expiry = Math.min(...derivatives.map((i) => i.expiry ?? Number.POSITIVE_INFINITY));

  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b-2 border-line bg-panel px-3 text-xs">
      <span className="hidden shrink-0 font-semibold text-text sm:inline">Futures &amp; options</span>
      <nav aria-label="Futures and options" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {shown.map((i) => {
          const last = lastPrice[i.symbol];
          const active = i.symbol === symbol;
          return (
            <button
              key={i.symbol}
              onClick={() => selectSymbol(i.symbol)}
              aria-pressed={active}
              title={`${i.symbol}: ${i.name}`}
              className={`flex shrink-0 items-baseline gap-2 rounded border-2 px-2.5 ${
                active ? "border-ink bg-accent text-ink shadow-brutal-sm" : "border-transparent text-muted hover:border-ink hover:bg-raised hover:text-text"
              }`}
            >
              <span className="font-semibold">{contractName(i)}</span>
              {/* A derivative stops trading while its underlying is in an auction. */}
              <PhaseBadge status={i.underlying === undefined ? undefined : statuses[i.underlying]} />
              {last !== undefined && (
                <>
                  <span className="num">{formatPrice(i, last)}</span>
                  <span className={`num ${last >= i.referencePrice ? "text-buy" : "text-sell"}`}>{formatChange(last, i.referencePrice)}</span>
                </>
              )}
            </button>
          );
        })}
      </nav>
      {Number.isFinite(expiry) && (
        <span className="shrink-0 text-muted">
          Expires <span className="num">{formatTime(expiry)}</span> · <Countdown until={expiry} />
        </span>
      )}
    </div>
  );
}
