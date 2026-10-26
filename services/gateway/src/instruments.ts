import type { Instrument } from "@ome/client";

export type { Instrument };

/** Simulated instruments. Prices are illustrative starting points, not live quotes. */
export const DEFAULT_INSTRUMENTS: Instrument[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 290_000 },
  { symbol: "TCS", name: "Tata Consultancy Services", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 410_000 },
  { symbol: "INFY", name: "Infosys", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 185_000 },
  { symbol: "HDFCBANK", name: "HDFC Bank", currency: "INR", priceScale: 100, quantityScale: 1, tickSize: 5, lotSize: 1, referencePrice: 170_000 },
  // Driven by the real Binance BTC/USDT trade feed when the feed bot runs.
  { symbol: "BTCUSDT", name: "Bitcoin / Tether", currency: "USDT", priceScale: 100, quantityScale: 100_000, tickSize: 1, lotSize: 1, referencePrice: 8_000_000 },
];
