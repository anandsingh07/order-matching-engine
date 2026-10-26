import { readFileSync } from "node:fs";

// The WebAssembly JS API is a global in Node, but its types live in
// TypeScript's DOM lib, which this repo does not load. This is the part we use.
declare const WebAssembly: {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { readonly exports: object };
};

/** The functions rust/src/lib.rs exports. */
export interface EngineExports {
  readonly memory: { readonly buffer: ArrayBuffer };
  io_ptr(): number;
  apply(): number;
  batch_buffer(count: number): number;
  run_batch(count: number): number;
  step(index: number): number;
  best_bid(): number;
  best_ask(): number;
  last_price(): number;
  phase(): number;
  resting_count(): number;
  stop_count(): number;
  depth(levels: number): number;
  snapshot(): number;
  indicative_auction(): number;
  order_info(handle: number): number;
  stop_info(handle: number): number;
  restore_state(phase: number, seq: number, arrival: number, lastPrice: number): void;
  restore_order(
    handle: number,
    trader: number,
    side: number,
    price: number,
    visible: number,
    hidden: number,
    display: number,
    selfTrade: number,
  ): void;
  restore_stop(
    handle: number,
    trader: number,
    side: number,
    stopPrice: number,
    limitPrice: number,
    quantity: number,
    timeInForce: number,
    selfTrade: number,
    arrival: number,
  ): void;
}

let compiled: object | undefined;

/**
 * A fresh engine: one wasm instance (with its own memory) per order book.
 * The module is compiled once and shared, so each new book costs only an
 * instantiation. The built engine.wasm is committed, so using the package
 * needs no Rust toolchain.
 */
export function instantiate(): EngineExports {
  compiled ??= new WebAssembly.Module(readFileSync(new URL("../wasm/engine.wasm", import.meta.url)));
  return new WebAssembly.Instance(compiled, {}).exports as unknown as EngineExports;
}
