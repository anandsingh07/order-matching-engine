//! WebAssembly exports for the Rust matching engine.
//!
//! One wasm instance is one order book. The boundary is shaped for speed:
//! the wrapper writes a command into a fixed area of linear memory (`Io.cmd`)
//! and calls `apply()` with no arguments; the engine leaves its events in a
//! buffer and publishes where it is in `Io`. Nothing is allocated per call on
//! the JavaScript side except the event objects the API returns.

mod book;
mod protocol;

use std::cell::UnsafeCell;

use book::{Command, Engine};
use protocol::{BUY, CMD_WORDS, SELL};

/// Shared with the wrapper, which finds it with `io_ptr()`.
#[repr(C)]
pub struct Io {
    /// One command, written by the wrapper before `apply()`.
    cmd: [f64; CMD_WORDS],
    /// Where the latest call left its output, in bytes and in elements.
    out_ptr: u32,
    out_len: u32,
    freed_ptr: u32,
    freed_len: u32,
}

struct Global<T>(UnsafeCell<T>);

// SAFETY: a wasm instance runs on one thread, and no export calls back into
// JavaScript, so at most one export (and one borrow of each global) is live.
unsafe impl<T> Sync for Global<T> {}

static ENGINE: Global<Engine> = Global(UnsafeCell::new(Engine::new()));
static IO: Global<Io> = Global(UnsafeCell::new(Io { cmd: [0.0; CMD_WORDS], out_ptr: 0, out_len: 0, freed_ptr: 0, freed_len: 0 }));
/// Pre-encoded commands for `run_batch` and `step` (benchmarks).
static BATCH: Global<Vec<f64>> = Global(UnsafeCell::new(Vec::new()));

fn engine() -> &'static mut Engine {
    // SAFETY: see `Global`.
    unsafe { &mut *ENGINE.0.get() }
}

fn io() -> &'static mut Io {
    // SAFETY: see `Global`.
    unsafe { &mut *IO.0.get() }
}

fn batch() -> &'static mut Vec<f64> {
    // SAFETY: see `Global`.
    unsafe { &mut *BATCH.0.get() }
}

/// Tells the wrapper where the output is. The buffers can move when they
/// grow, so this runs after every call that writes them.
fn publish(e: &Engine) -> u32 {
    let io = io();
    io.out_ptr = e.out.as_ptr() as u32;
    io.out_len = e.out.len() as u32;
    io.freed_ptr = e.freed.as_ptr() as u32;
    io.freed_len = e.freed.len() as u32;
    io.out_len
}

#[unsafe(no_mangle)]
pub extern "C" fn io_ptr() -> *const Io {
    IO.0.get()
}

/// Runs the command in `Io.cmd`; returns the number of event words.
#[unsafe(no_mangle)]
pub extern "C" fn apply() -> u32 {
    let command = Command::decode(&io().cmd);
    let e = engine();
    e.apply(&command);
    publish(e)
}

/// Makes room for `count` pre-encoded commands and returns where to write them.
#[unsafe(no_mangle)]
pub extern "C" fn batch_buffer(count: u32) -> *mut f64 {
    let b = batch();
    b.clear();
    b.resize(count as usize * CMD_WORDS, 0.0);
    b.as_mut_ptr()
}

/// Runs the first `count` batch commands in one call, discarding events and
/// freed handles (the batch's handles are never reused). Returns the number
/// of trades. This is the engine alone, without the boundary.
#[unsafe(no_mangle)]
pub extern "C" fn run_batch(count: u32) -> f64 {
    let e = engine();
    let before = e.trades;
    for command in batch().chunks_exact(CMD_WORDS).take(count as usize) {
        e.apply(&Command::decode(command));
    }
    publish(e);
    (e.trades - before) as f64
}

/// Runs batch command `i` on its own; returns the trades it made.
#[unsafe(no_mangle)]
pub extern "C" fn step(i: u32) -> u32 {
    let e = engine();
    let before = e.trades;
    let start = i as usize * CMD_WORDS;
    e.apply(&Command::decode(&batch()[start..start + CMD_WORDS]));
    (e.trades - before) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn best_bid() -> f64 {
    engine().best_price(BUY)
}

#[unsafe(no_mangle)]
pub extern "C" fn best_ask() -> f64 {
    engine().best_price(SELL)
}

#[unsafe(no_mangle)]
pub extern "C" fn last_price() -> f64 {
    engine().last_trade_price()
}

#[unsafe(no_mangle)]
pub extern "C" fn phase() -> u32 {
    engine().phase() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn resting_count() -> u32 {
    engine().resting_count()
}

#[unsafe(no_mangle)]
pub extern "C" fn stop_count() -> u32 {
    engine().stop_count()
}

#[unsafe(no_mangle)]
pub extern "C" fn depth(levels: f64) -> u32 {
    let e = engine();
    e.depth(levels);
    publish(e)
}

#[unsafe(no_mangle)]
pub extern "C" fn snapshot() -> u32 {
    let e = engine();
    e.snapshot();
    publish(e)
}

/// 1 and `[price, volume, imbalance]` in the output if an uncross would trade, else 0.
#[unsafe(no_mangle)]
pub extern "C" fn indicative_auction() -> u32 {
    let e = engine();
    let result = e.indicative_auction();
    e.out.clear();
    if let Some(r) = result {
        e.out.extend_from_slice(&[r.price, r.volume, r.imbalance]);
    }
    publish(e);
    result.is_some() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn order_info(handle: u32) -> u32 {
    let e = engine();
    let found = e.order_info(handle);
    publish(e);
    found as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn stop_info(handle: u32) -> u32 {
    let e = engine();
    let found = e.stop_info(handle);
    publish(e);
    found as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn restore_state(phase: u32, seq: f64, arrival: f64, last_price: f64) {
    engine().restore_state(phase as u8, seq, arrival, last_price);
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn restore_order(
    handle: u32,
    trader: u32,
    side: u32,
    price: f64,
    visible: f64,
    hidden: f64,
    display: f64,
    self_trade: u32,
) {
    engine().insert_resting(handle, trader, side as u8, price, visible, hidden, display, self_trade as u8);
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn restore_stop(
    handle: u32,
    trader: u32,
    side: u32,
    stop_price: f64,
    limit_price: f64,
    quantity: f64,
    tif: u32,
    self_trade: u32,
    arrival: f64,
) {
    engine().restore_stop(handle, trader, side as u8, stop_price, limit_price, quantity, tif as u8, self_trade as u8, arrival);
}
