import type { Candle, Instrument } from "@ome/client";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { openingRange } from "@/lib/chart-view";
import { isDerivative } from "@/lib/derivatives";
import { useInstrument, useTerminal, type Interval } from "@/lib/store";
import { AuctionBanner, ContractReadout, UnderlyingAuctionBanner, VolatilityReadout } from "./market-status";

const INTERVALS: Interval[] = ["5s", "1m"];

/**
 * The chart library labels its time axis in UTC. Shifting each timestamp by
 * the local offset makes the axis read in local time, matching the trade tape.
 */
const chartTime = (ms: number) => ((ms - new Date(ms).getTimezoneOffset() * 60_000) / 1000) as UTCTimestamp;

const toBar = (c: Candle, i: Instrument) => ({
  time: chartTime(c.time),
  open: c.open / i.priceScale,
  high: c.high / i.priceScale,
  low: c.low / i.priceScale,
  close: c.close / i.priceScale,
});

/**
 * The chart draws on a canvas, out of reach of CSS, so it takes the theme's
 * colours from the same tokens as the rest of the terminal (globals.css).
 */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(`--color-${name}`).trim() || fallback;
  return {
    ink: token("ink", "#111111"),
    muted: token("muted", "#4a4a4a"),
    up: token("buy-fill", "#2bd97c"),
    down: token("sell-fill", "#ff5a5f"),
    upVolume: token("buy-soft", "rgb(43 217 124 / 0.3)"),
    downVolume: token("sell-soft", "rgb(255 90 95 / 0.25)"),
  };
}
type ThemeColors = ReturnType<typeof themeColors>;

const toVolume = (c: Candle, i: Instrument, colors: ThemeColors) => ({
  time: chartTime(c.time),
  value: c.volume / i.quantityScale,
  color: c.close >= c.open ? colors.upVolume : colors.downVolume,
});

export function PriceChart() {
  const container = useRef<HTMLDivElement>(null);
  const instrument = useInstrument();
  const { symbol, interval, selectInterval, status, underlying } = useTerminal(
    useShallow((s) => ({
      symbol: s.symbol,
      interval: s.interval,
      selectInterval: s.selectInterval,
      status: s.statuses[s.symbol],
      // A future's or option's limits and trading follow its underlying.
      underlying: instrument?.underlying === undefined ? undefined : s.statuses[instrument.underlying],
    })),
  );
  const derivative = instrument !== undefined && isDerivative(instrument);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const colors = themeColors();
    const chart = createChart(element, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.ink, fontSize: 11 },
      // Faint ink grid; solid ink axes, like the panel outlines.
      grid: { vertLines: { color: "rgb(17 17 17 / 0.08)" }, horzLines: { color: "rgb(17 17 17 / 0.08)" } },
      rightPriceScale: { borderColor: colors.ink },
      timeScale: { borderColor: colors.ink, timeVisible: true, secondsVisible: true },
      crosshair: { mode: 0, vertLine: { color: colors.muted }, horzLine: { color: colors.muted } },
    });
    // Flat fills with ink outlines and wicks: green up, red down.
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.ink,
      borderDownColor: colors.ink,
      wickUpColor: colors.ink,
      wickDownColor: colors.ink,
    });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" } });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    // Read the store directly instead of re-rendering React on every candle:
    // a full reload when the symbol or interval changes or a history arrives,
    // cheap updates otherwise.
    let loadedKey = "";
    let loadedCount = 0;
    // Set until the shown series' history has loaded and the view has opened on it.
    let opening = true;
    const render = (state: ReturnType<typeof useTerminal.getState>) => {
      const instrument = state.instruments.find((i) => i.symbol === state.symbol);
      if (instrument === undefined) return;
      const key = `${state.symbol}:${state.interval}`;
      // Undefined until the gateway's history for the channel arrives, a round trip after subscribing.
      const history = state.candles[key];
      const list = history ?? [];
      if (key !== loadedKey || history === undefined) opening = true;
      const last = list.at(-1);
      if (key !== loadedKey || list.length < loadedCount || list.length > loadedCount + 1) {
        const decimals = Math.round(Math.log10(instrument.priceScale));
        candles.applyOptions({ priceFormat: { type: "price", precision: decimals, minMove: instrument.tickSize / instrument.priceScale } });
        candles.setData(list.map((c) => toBar(c, instrument)));
        volume.setData(list.map((c) => toVolume(c, instrument, colors)));
        loadedKey = key;
      } else if (last !== undefined) {
        candles.update(toBar(last, instrument));
        volume.update(toVolume(last, instrument, colors));
      }
      loadedCount = list.length;
      // Open the view on the history, not on the key change: fitted before the history
      // arrived, or to a young series' first two bars, the chart kept that bar width as
      // candles appended and showed only the newest couple for the rest of the session.
      const range = opening && history !== undefined ? openingRange(list.length) : null;
      if (range !== null) {
        chart.timeScale().setVisibleLogicalRange(range);
        opening = false;
      }
    };
    render(useTerminal.getState());
    const unsubscribe = useTerminal.subscribe(render);
    return () => {
      unsubscribe();
      chart.remove();
    };
  }, []);

  return (
    <section className="flex min-h-[320px] flex-1 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b-2 border-line px-3 text-xs">
        <h2 className="text-text">{symbol}</h2>
        <div role="group" aria-label="Candle interval" className="flex gap-1">
          {INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => selectInterval(i)}
              aria-pressed={i === interval}
              className={`rounded px-2 ${i === interval ? "btn bg-accent text-ink" : "border-2 border-transparent text-muted hover:border-ink hover:text-text"}`}
            >
              {i}
            </button>
          ))}
        </div>
        {instrument !== undefined &&
          (derivative ? (
            <ContractReadout status={status} underlying={underlying} instrument={instrument} />
          ) : (
            <VolatilityReadout status={status} instrument={instrument} />
          ))}
      </div>
      {instrument !== undefined &&
        (derivative ? <UnderlyingAuctionBanner underlying={underlying} symbol={symbol} /> : <AuctionBanner status={status} instrument={instrument} />)}
      <div ref={container} className="min-h-0 flex-1" />
    </section>
  );
}
