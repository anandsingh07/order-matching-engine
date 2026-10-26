import type { Instrument, MarketStatus } from "@ome/client";
import { useEffect, useState } from "react";
import { formatPrice, formatQuantity } from "@/lib/format";

/** A small tag for symbols that are not trading continuously. */
export function PhaseBadge({ status }: { status: MarketStatus | undefined }) {
  if (status === undefined || status.phase === "continuous") return null;
  const halted = status.reason === "circuit_breaker";
  return (
    <span className={`rounded border border-ink px-1 text-[10px] font-bold text-ink ${halted ? "bg-sell-fill" : "bg-accent"}`}>
      {halted ? "HALTED" : "AUCTION"}
    </span>
  );
}

/** 0.21%, 2.5%, 10%: two decimals below 1%, otherwise one, without a trailing zero. */
const pct = (v: number) => `${Number(v.toFixed(v < 1 ? 2 : 1))}%`;

/**
 * The gateway's volatility forecast and the limits it sets: the typical move
 * over the next 15 minutes, the price band, and the circuit-breaker trigger.
 */
export function VolatilityReadout({ status, instrument }: { status: MarketStatus | undefined; instrument: Instrument }) {
  if (status === undefined) return null;
  const v = status.volatility;
  const limits = `band ±${pct(status.bandPct)}${status.breakerPct === null ? "" : ` · halt on ${pct(status.breakerPct)} in 1m`}`;
  if (v === null) {
    return (
      <p aria-label="Volatility forecast" className="ml-auto truncate text-muted" title="The forecast starts after 15 minutes of trading">
        Volatility forecast warming up · {limits}
      </p>
    );
  }
  const move = Math.round((status.referencePrice * v.sigmaPct) / 100);
  return (
    <p
      aria-label="Volatility forecast"
      className="ml-auto truncate text-muted"
      title={`Forecast by the ${v.model.toUpperCase()} model from 1-minute bars. Price bands and the circuit breaker tighten with it in calm markets.`}
    >
      Expected {v.horizonMinutes}m move <span className="num text-text">±{pct(v.sigmaPct)}</span>{" "}
      <span className="num">({formatPrice(instrument, move)})</span> · {limits}
    </p>
  );
}

/**
 * For a future or option: the price band in force, and the forecast for its
 * underlying that values it. A derivative's band comes from its underlying's
 * (for an option, every value it could have with the underlying anywhere in
 * its band and volatility from half to double the forecast), so it is shown
 * as prices, not as a percentage of the contract's own price.
 */
export function ContractReadout({ status, underlying, instrument }: { status: MarketStatus | undefined; underlying: MarketStatus | undefined; instrument: Instrument }) {
  const band = status?.band;
  const v = underlying?.volatility ?? null;
  return (
    <p
      aria-label="Contract limits"
      className="ml-auto truncate text-muted"
      title={`Prices outside the band are refused. It follows ${instrument.underlying}'s price and volatility forecast.`}
    >
      {band !== undefined && (
        <>
          band{" "}
          <span className="num text-text">
            {formatPrice(instrument, band.low)}–{formatPrice(instrument, band.high)}
          </span>{" "}
          ·{" "}
        </>
      )}
      {v === null ? (
        `${instrument.underlying} volatility forecast warming up`
      ) : (
        <>
          {instrument.underlying} expected {v.horizonMinutes}m move <span className="num text-text">±{pct(v.sigmaPct)}</span>
        </>
      )}
    </p>
  );
}

/** Explains why a future or option cannot trade: its underlying is in an auction. */
export function UnderlyingAuctionBanner({ underlying, symbol }: { underlying: MarketStatus | undefined; symbol: string }) {
  const seconds = useSecondsUntil(underlying?.until ?? null);
  if (underlying === undefined || underlying.phase === "continuous") return null;
  const halted = underlying.reason === "circuit_breaker";
  return (
    <div role="status" className={`border-b-2 border-line px-3 py-2 text-xs ${halted ? "bg-sell-soft" : "bg-accent/40"}`}>
      <p className="font-semibold">
        {underlying.symbol} is {halted ? "halted by its circuit breaker" : "in its opening auction"}, so {symbol} cannot trade.{" "}
        <span className="font-normal text-muted">
          With no price for {underlying.symbol} nobody can value its futures and options; orders are accepted again when it reopens
          {seconds !== null ? `, in ${seconds}s` : ""}. Resting orders can still be cancelled.
        </span>
      </p>
    </div>
  );
}

function useSecondsUntil(until: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [until]);
  return until === null ? null : Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * Explains an auction in progress: why it is running, when it ends, and the
 * price it would open at if it ended now.
 */
export function AuctionBanner({ status, instrument }: { status: MarketStatus | undefined; instrument: Instrument }) {
  const seconds = useSecondsUntil(status?.until ?? null);
  if (status === undefined || status.phase === "continuous") return null;
  const halted = status.reason === "circuit_breaker";
  const indicative = status.indicative;
  return (
    <div role="status" className={`border-b-2 border-line px-3 py-2 text-xs ${halted ? "bg-sell-soft" : "bg-accent/40"}`}>
      <p className="font-semibold">
        {halted ? "Trading halted: the price moved too far, too fast." : "Opening auction in progress."}{" "}
        <span className="font-normal text-muted">
          Orders collect without trading{seconds !== null ? `; everything that can trade opens at one price in ${seconds}s` : ""}.
          Only limit (GTC) and stop orders are accepted.
        </span>
      </p>
      <p className="num mt-1 text-muted">
        Indicative price{" "}
        <span className="text-text">{indicative === null ? "— (nothing crosses yet)" : formatPrice(instrument, indicative.price)}</span>
        {indicative !== null && (
          <>
            {" · "}volume <span className="text-text">{formatQuantity(instrument, indicative.volume)}</span>
            {indicative.imbalance !== 0 && (
              <>
                {" · "}
                {indicative.imbalance > 0 ? "excess buying" : "excess selling"}{" "}
                <span className="text-text">{formatQuantity(instrument, Math.abs(indicative.imbalance))}</span>
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}
