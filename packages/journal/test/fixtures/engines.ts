import { OrderBook } from "@ome/core";
import { RustOrderBook } from "@ome/engine-rs";
import type { EngineClass } from "../../src/index.js";

/** Every engine the journal must recover, by the names the exchange's `engine` option uses. */
export const ENGINES = { ts: OrderBook, rust: RustOrderBook } satisfies Record<string, EngineClass>;

export type EngineName = keyof typeof ENGINES;
