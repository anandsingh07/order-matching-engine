import { useShallow } from "zustand/react/shallow";
import { formatPrice, formatQuantity, formatTime } from "@/lib/format";
import { useInstrument, useTerminal } from "@/lib/store";
import { Panel } from "./panel";

const EMPTY: never[] = [];

export function TradeTape() {
  const instrument = useInstrument();
  const trades = useTerminal(useShallow((s) => (s.trades[s.symbol] ?? EMPTY).slice(0, 40)));
  if (instrument === undefined) return null;

  return (
    <Panel title="Trades" className="flex-1">
      <div className="grid grid-cols-3 px-3 py-1 text-right text-[11px] text-muted">
        <span className="text-left">Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      {trades.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted">No trades yet.</p>}
      {trades.map((t) => (
        <div key={t.id} className="grid grid-cols-3 px-3 py-[3px] text-right text-xs">
          <span className={`num text-left ${t.side === "buy" ? "text-buy" : "text-sell"}`}>{formatPrice(instrument, t.price)}</span>
          <span className="num">{formatQuantity(instrument, t.quantity)}</span>
          <span className="num text-muted">{formatTime(t.time)}</span>
        </div>
      ))}
    </Panel>
  );
}
