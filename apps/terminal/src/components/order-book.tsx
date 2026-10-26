import type { Instrument, Side } from "@ome/client";
import { useShallow } from "zustand/react/shallow";
import { ladder, type LadderRow } from "@/lib/depth";
import { formatPrice, formatQuantity } from "@/lib/format";
import { useInstrument, useTerminal } from "@/lib/store";
import { Panel } from "./panel";

const LEVELS = 12;

function Row({ row, side, instrument, onPick }: { row: LadderRow; side: Side; instrument: Instrument; onPick: () => void }) {
  const sell = side === "sell";
  return (
    <button
      onClick={onPick}
      // Clicking a level prepares the opposite order: lift an offer, or hit a bid.
      aria-label={`${sell ? "Buy" : "Sell"} at ${formatPrice(instrument, row.price)}, ${formatQuantity(instrument, row.quantity)} available`}
      className="relative grid w-full grid-cols-3 px-3 py-[3px] text-right text-xs hover:bg-raised"
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 right-0 ${sell ? "bg-sell-soft" : "bg-buy-soft"}`}
        style={{ width: `${row.share * 100}%` }}
      />
      <span className={`num relative text-left ${sell ? "text-sell" : "text-buy"}`}>{formatPrice(instrument, row.price)}</span>
      <span className="num relative">{formatQuantity(instrument, row.quantity)}</span>
      <span className="num relative text-muted">{formatQuantity(instrument, row.total)}</span>
    </button>
  );
}

export function OrderBook() {
  const instrument = useInstrument();
  const { book, last, prefill } = useTerminal(
    useShallow((s) => ({ book: s.books[s.symbol], last: s.lastPrice[s.symbol], prefill: s.prefillFromBook })),
  );
  if (instrument === undefined) return null;
  const l = ladder(book?.bids ?? [], book?.asks ?? [], LEVELS);
  const empty = l.bids.length === 0 && l.asks.length === 0;

  return (
    <Panel
      title="Order book"
      aside={l.spread !== null && <span className="num">Spread {formatPrice(instrument, l.spread)}</span>}
    >
      <div className="grid grid-cols-3 px-3 py-1 text-right text-[11px] text-muted">
        <span className="text-left">Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>
      {empty ? (
        <p className="px-3 py-6 text-center text-xs text-muted">
          No quotes yet. Start the bots with <code className="num text-text">pnpm bots</code>.
        </p>
      ) : (
        <>
          {/* Asks run upwards from the best price, so the spread sits in the middle. */}
          <div className="flex flex-col-reverse">
            {l.asks.map((row) => (
              <Row key={row.price} row={row} side="sell" instrument={instrument} onPick={() => prefill(row.price, "buy")} />
            ))}
          </div>
          <div className="flex items-baseline justify-between border-y-2 border-line bg-accent px-3 py-1">
            <span className="num text-sm font-semibold">{last === undefined ? "—" : formatPrice(instrument, last)}</span>
            <span className="text-[11px] font-semibold text-ink">last trade</span>
          </div>
          {l.bids.map((row) => (
            <Row key={row.price} row={row} side="buy" instrument={instrument} onPick={() => prefill(row.price, "sell")} />
          ))}
        </>
      )}
    </Panel>
  );
}
