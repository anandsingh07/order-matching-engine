export {
  aggTradesCsv,
  BINANCE_HOSTS,
  BTCUSDT,
  downloadAggTrades,
  downloadKlines,
  klinesCsv,
  loadMarketData,
  MINUTE_MS,
  parseKlines,
  parseTrades,
  siblingKlines,
  tapeBars,
  trimDecimal,
} from "./data.js";
export type { AggTrade, FetchOptions, Kline } from "./data.js";
export { DEFAULT_CONFIG, runBacktest } from "./engine.js";
export type { BacktestRun, RunOptions } from "./engine.js";
export { BAR_MARKOUT_HORIZONS_MS, MARKOUT_HORIZONS_MS, markouts, maxDrawdown, MINUTES_PER_YEAR, NEAR_TOUCH_BPS, quantile, quotePlacement, sharpe } from "./metrics.js";
export { htmlReport, quotesTable, summaryTable, windowsTable } from "./report.js";
export { compareWindows, meanWithCi, splitWindows, tQuantile975 } from "./windows.js";
export type { WindowComparison } from "./windows.js";
export {
  ActionBudget,
  avellanedaStoikovMaker,
  createStrategy,
  HELD_TAG,
  LADDER_PARAMS,
  ladderMaker,
  movingAverageCrossover,
  NEEDS_TAPE,
  readPolicyManifest,
  REFERENCE_VOL_BPS,
  requote,
  rlMaker,
  STRATEGY_LABELS,
  STRATEGY_NAMES,
  UNIT_QUANTITY,
} from "./strategies.js";
export type { Crossing, CrossoverOptions, SingleQuoteOptions, StrategyName } from "./strategies.js";
export type * from "./types.js";
