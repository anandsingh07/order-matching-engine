import { contractName, formatStrike, type DepthLevel, type Instrument, type Side } from "@ome/client";
import { useShallow } from "zustand/react/shallow";
import {
  atTheMoney,
  forecastVolatility,
  formatDelta,
  formatVolatility,
  inTheMoney,
  optionChains,
  underlyingPrice,
  type ChainQuote,
} from "@/lib/chain";
import { underlyingOf } from "@/lib/derivatives";
import { formatPrice, formatTime } from "@/lib/format";
import { useTerminal } from "@/lib/store";
import { Countdown, useNow } from "./countdown";
import { Panel } from "./panel";

/**
 * A best bid or offer as a button: clicking it selects the contract and fills
 * in the ticket to trade against it, as clicking a level in the order book
 * does (hit the bid to sell, lift the offer to buy). With no quote it just
 * selects the contract.
 */
function QuoteButton({ instrument, price, side, selected }: { instrument: Instrument; price: number | null; side: "bid" | "ask"; selected: boolean }) {
  const pickContract = useTerminal((s) => s.pickContract);
  const name = contractName(instrument);
  const trade: Side = side === "bid" ? "sell" : "buy";
  return (
    <button
      onClick={() => pickContract(instrument.symbol, price, trade)}
      aria-label={price === null ? `Select ${name}, no ${side === "bid" ? "bid" : "offer"}` : `${trade === "buy" ? "Buy" : "Sell"} ${name} at ${formatPrice(instrument, price)}`}
      className={`num w-full rounded px-1 py-0.5 text-right font-semibold hover:bg-accent ${side === "bid" ? "text-buy" : "text-sell"} ${selected ? "bg-accent ring-2 ring-ink" : ""}`}
    >
      {price === null ? <span className="text-muted">—</span> : formatPrice(instrument, price)}
    </button>
  );
}

/**
 * One side of a strike's row. The quotes sit next to the strike on both
 * sides, with the analytics outside them: calls read delta, IV, bid, offer
 * and puts bid, offer, IV, delta.
 */
function Cells({ quote, spot, symbol, side }: { quote: ChainQuote | null; spot: number; symbol: string; side: "call" | "put" }) {
  if (quote === null) return <td colSpan={4} />;
  const i = quote.instrument;
  const shade = inTheMoney(side, i.strike ?? 0, spot) ? "bg-raised" : "";
  const selected = i.symbol === symbol;
  const delta = (
    <td key="delta" className={`num px-2 py-0.5 text-right text-muted ${shade}`}>
      {formatDelta(quote.delta)}
    </td>
  );
  const iv = (
    <td key="iv" className={`num px-2 py-0.5 text-right ${shade}`}>
      {formatVolatility(quote.iv)}
    </td>
  );
  const quotes = [
    <td key="bid" className={`px-1 py-0.5 ${shade}`}>
      <QuoteButton instrument={i} price={quote.bid} side="bid" selected={selected} />
    </td>,
    <td key="ask" className={`px-1 py-0.5 ${shade}`}>
      <QuoteButton instrument={i} price={quote.ask} side="ask" selected={selected} />
    </td>,
  ];
  return <>{side === "call" ? [delta, iv, ...quotes] : [...quotes, iv, delta]}</>;
}

const EMPTY_LEVELS: { bids: DepthLevel[]; asks: DepthLevel[] } = { bids: [], asks: [] };

/**
 * The option chain on the selected symbol's underlying: every strike's call
 * and put with the best bid and offer, the volatility the mid implies, and
 * delta at that volatility. Shown for a stock with listed options and for any
 * of its futures and options, so moving between them keeps the chain in view.
 *
 * Implied volatility is annualised, the unit the forecast is shown in above
 * the table: a market maker quoting around Black-Scholes value with the
 * forecast should imply about the forecast.
 */
export function OptionChain() {
  const { instruments, symbol, books, lastPrice, statuses } = useTerminal(
    useShallow((s) => ({ instruments: s.instruments, symbol: s.symbol, books: s.books, lastPrice: s.lastPrice, statuses: s.statuses })),
  );
  // Time to expiry moves implied volatility as well as the countdown.
  const now = useNow();
  const selected = instruments.find((i) => i.symbol === symbol);
  if (selected === undefined) return null;
  const underlying = underlyingOf(selected);
  const stock = instruments.find((i) => i.symbol === underlying);
  const spot = underlyingPrice(lastPrice[underlying], statuses[underlying], stock);
  if (spot === null || stock === undefined) return null;
  const chain = optionChains(instruments, underlying, books, spot, now)[0];
  if (chain === undefined) return null;
  const atm = atTheMoney(chain.rows, spot);
  const forecast = forecastVolatility(statuses[underlying]);
  const v = statuses[underlying]?.volatility ?? null;
  const future = chain.future;
  const futureBook = future === null ? EMPTY_LEVELS : (books[future.symbol] ?? EMPTY_LEVELS);
  const head = "px-2 py-1 text-right font-normal";

  return (
    <Panel
      fill={false}
      className="min-h-[140px] border-t-[3px] border-line"
      title={`Option chain · ${underlying}`}
      aside={
        <span>
          Expires <span className="num">{formatTime(chain.expiry)}</span> · <Countdown until={chain.expiry} /> left
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-1.5 text-[11px] text-muted">
        <span>
          {underlying} <span className="num text-text">{formatPrice(stock, Math.round(spot))}</span>
        </span>
        {future !== null && (
          <span className="flex items-center gap-1">
            Future
            <span className="w-20">
              <QuoteButton instrument={future} price={futureBook.bids[0]?.price ?? null} side="bid" selected={future.symbol === symbol} />
            </span>
            <span className="w-20">
              <QuoteButton instrument={future} price={futureBook.asks[0]?.price ?? null} side="ask" selected={future.symbol === symbol} />
            </span>
          </span>
        )}
        <span title="The gateway's volatility forecast for the underlying, annualised like implied volatility">
          Forecast volatility{" "}
          {v === null || forecast === null ? (
            "warming up"
          ) : (
            <>
              <span className="num text-text">{formatVolatility(forecast)}</span> a year (±{Number(v.sigmaPct.toFixed(2))}% per {v.horizonMinutes}m)
            </>
          )}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <caption className="sr-only">
            Calls and puts on {underlying} by strike: delta, implied volatility, best bid and best offer
          </caption>
          <thead className="text-[11px] text-muted">
            <tr>
              <th colSpan={4} className="px-2 text-center font-semibold">
                Calls
              </th>
              <th />
              <th colSpan={4} className="px-2 text-center font-semibold">
                Puts
              </th>
            </tr>
            <tr>
              <th className={head}>
                <abbr title="delta, at the implied volatility">Δ</abbr>
              </th>
              <th className={head}>
                <abbr title="implied volatility of the mid, annualised">IV</abbr>
              </th>
              <th className={head}>Bid</th>
              <th className={head}>Offer</th>
              <th className="px-2 py-1 text-center font-normal">Strike</th>
              <th className={head}>Bid</th>
              <th className={head}>Offer</th>
              <th className={head}>
                <abbr title="implied volatility of the mid, annualised">IV</abbr>
              </th>
              <th className={head}>
                <abbr title="delta, at the implied volatility">Δ</abbr>
              </th>
            </tr>
          </thead>
          <tbody>
            {chain.rows.map((row) => (
              <tr key={row.strike} className="border-t border-line/15">
                <Cells quote={row.call} spot={spot} symbol={symbol} side="call" />
                <th scope="row" className={`num px-2 py-0.5 text-center ${row.strike === atm ? "bg-accent font-bold text-ink" : "font-normal text-muted"}`}>
                  {formatStrike({ priceScale: stock.priceScale, strike: row.strike })}
                </th>
                <Cells quote={row.put} spot={spot} symbol={symbol} side="put" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-1.5 text-[11px] text-muted">
        IV is implied by the mid of the best bid and offer, and Δ is at that IV. Shaded: in the money. Click a bid to sell, an offer to buy.
      </p>
    </Panel>
  );
}
