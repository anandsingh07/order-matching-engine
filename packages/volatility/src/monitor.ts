import { MinuteBars } from "./bars.js";
import { VolatilityForecaster, type Forecast, type VolatilityManifest } from "./forecaster.js";

/** Live volatility forecasts for every symbol, fed by the trades as they print. */
export class VolatilityMonitor {
  private readonly symbols = new Map<string, { bars: MinuteBars; forecaster: VolatilityForecaster }>();

  constructor(
    readonly manifest: VolatilityManifest,
    symbols: Iterable<string>,
    options: { model?: string; barMs?: number } = {},
  ) {
    for (const symbol of symbols) {
      this.symbols.set(symbol, { bars: new MinuteBars(options.barMs), forecaster: new VolatilityForecaster(manifest, options.model) });
    }
  }

  /** Records a trade; true if it completed a bar, so the forecast changed. */
  trade(symbol: string, price: number, time: number): boolean {
    const s = this.symbols.get(symbol);
    if (s === undefined) return false;
    const done = s.bars.trade(price, time);
    for (const bar of done) s.forecaster.push(bar);
    return done.length > 0;
  }

  /** Closes minutes that ended without a trade; returns the symbols whose forecast changed. */
  roll(now: number): string[] {
    const changed: string[] = [];
    for (const [symbol, s] of this.symbols) {
      const done = s.bars.roll(now);
      for (const bar of done) s.forecaster.push(bar);
      if (done.length > 0) changed.push(symbol);
    }
    return changed;
  }

  forecast(symbol: string): Forecast | null {
    return this.symbols.get(symbol)?.forecaster.forecast() ?? null;
  }
}
