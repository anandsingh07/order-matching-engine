//! The matching engine: a port of `packages/core/src/order-book.ts`.
//!
//! The port is deliberately literal. Every rule, check and tie-break happens
//! in the same order as in TypeScript, because the point is that both engines
//! produce identical events for identical commands, and the differential
//! tests compare them event by event.
//!
//! Prices and quantities are `f64` holding integers, exactly like the
//! TypeScript engine's `Float64Array` columns. Integer types would be the
//! natural choice in a fresh design, but with `f64` every sum and difference
//! rounds the same way as in TypeScript, so parity does not end where totals
//! pass 2^53.
//!
//! Order and trader ids are strings in TypeScript; here they are integer
//! handles that the TypeScript wrapper hands out, so no string ever crosses
//! the WebAssembly boundary.

use std::collections::BTreeMap;

use crate::protocol::*;

/// No order or level: the end of a list, or an empty level.
pub const NONE: u32 = u32::MAX;

// What `loc[handle]` holds: a pool slot, a stop index tagged with STOP, or DEAD.
const STOP: u32 = 1 << 31;
const DEAD: u32 = u32::MAX;
/// Marks a handle already queued in `freed` during `finish`, so it is reported once.
const REPORTED: u32 = u32::MAX - 1;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Number.isSafeInteger(n) && n > 0`.
fn is_positive_integer(n: f64) -> bool {
    n > 0.0 && n <= MAX_SAFE_INTEGER && n == n.trunc()
}

/// `Math.min` for the non-NaN values the engine works with.
fn min(a: f64, b: f64) -> f64 {
    if a < b { a } else { b }
}

/// Whether a taker with this limit (None = market) may trade at the maker's price.
fn crosses(taker_side: u8, maker_price: f64, limit: Option<f64>) -> bool {
    match limit {
        None => true,
        Some(limit) => {
            if taker_side == BUY {
                maker_price <= limit
            } else {
                maker_price >= limit
            }
        }
    }
}

// Price levels and stop queues live in B-trees keyed so that the first key is
// always the one to act on next, like the TypeScript AVL trees' comparators:
// bids by -price (highest first), asks by price (lowest first), buy stops by
// stop price (lowest triggers first), sell stops by -stop price.
fn book_key(side: u8, price: f64) -> i64 {
    if side == BUY { -(price as i64) } else { price as i64 }
}

fn stop_key(side: u8, stop_price: f64) -> i64 {
    if side == BUY { stop_price as i64 } else { -(stop_price as i64) }
}

/// A resting order. One struct per order (array of structs): Rust has no
/// garbage collector to hide pointers from, so the TypeScript pool's
/// column-per-field layout would only cost locality here.
#[derive(Clone, Copy)]
struct Order {
    price: f64,
    /// Quantity shown on the book and available to the next fill.
    visible: f64,
    /// Iceberg reserve, shown slice by slice. Zero for normal orders.
    hidden: f64,
    /// Iceberg slice size, or -1 for a normal order.
    display: f64,
    handle: u32,
    trader: u32,
    level: u32,
    prev: u32,
    next: u32,
    side: u8,
    self_trade: u8,
}

/// All resting orders at one price, oldest first: a doubly-linked list
/// threaded through the orders' prev/next fields.
#[derive(Clone, Copy)]
struct Level {
    price: f64,
    /// Visible quantity, as shown in market depth.
    total: f64,
    hidden: f64,
    head: u32,
    tail: u32,
    count: u32,
}

#[derive(Clone, Copy)]
struct Stop {
    stop_price: f64,
    limit_price: Option<f64>,
    quantity: f64,
    /// Submission order, used to sequence stops that trigger together.
    arrival: f64,
    handle: u32,
    trader: u32,
    side: u8,
    tif: u8,
    self_trade: u8,
}

/// The incoming (aggressive) side of a match.
struct Taker {
    handle: u32,
    trader: u32,
    side: u8,
    remaining: f64,
    self_trade: u8,
}

#[derive(Clone, Copy)]
pub struct Auction {
    pub price: f64,
    pub volume: f64,
    /// Unmatched quantity at that price: positive is excess demand, negative excess supply.
    pub imbalance: f64,
}

/// A decoded command (see `protocol.rs` for the wire layout).
pub struct Command {
    pub op: u32,
    pub kind: u8,
    pub side: u8,
    pub tif: u8,
    pub self_trade: u8,
    pub flags: u32,
    pub handle: u32,
    pub trader: u32,
    pub quantity: f64,
    pub price: f64,
    pub limit_price: f64,
    pub display: f64,
}

impl Command {
    pub fn decode(w: &[f64]) -> Command {
        let header = w[0] as u32;
        Command {
            op: header & 0xF,
            kind: ((header >> 4) & 0xF) as u8,
            side: ((header >> 8) & 0xF) as u8,
            tif: ((header >> 12) & 0xF) as u8,
            self_trade: ((header >> 16) & 0xF) as u8,
            flags: header >> 20,
            handle: w[1] as u32,
            trader: w[2] as u32,
            quantity: w[3],
            price: w[4],
            limit_price: w[5],
            display: w[6],
        }
    }
}

pub struct Engine {
    bids: BTreeMap<i64, u32>,
    asks: BTreeMap<i64, u32>,
    orders: Vec<Order>,
    free_orders: Vec<u32>,
    /// Price levels by id (an order's `level` points here), with ids of removed levels for reuse.
    levels: Vec<Level>,
    free_levels: Vec<u32>,
    buy_stops: BTreeMap<i64, Vec<u32>>,
    sell_stops: BTreeMap<i64, Vec<u32>>,
    stops: Vec<Stop>,
    free_stops: Vec<u32>,
    /// Handle -> where that order lives now (pool slot, STOP | stop index, or DEAD).
    loc: Vec<u32>,
    /// Trader -> whether they ever had a resting order. The TypeScript pool
    /// only numbers traders that have, and the FOK check branches on that.
    has_number: Vec<bool>,
    resting: u32,
    pending_stops: u32,
    last_price: Option<f64>,
    arrival: f64,
    seq: f64,
    phase: u8,
    /// Trades emitted so far, so a batch run can count them without decoding events.
    pub trades: u64,

    /// Events of the current call, as records of f64 words (see `protocol.rs`).
    pub out: Vec<f64>,
    /// Handles whose orders are gone after the current command; the wrapper recycles them.
    pub freed: Vec<u32>,
    /// Handles that may have died during the current command (checked in `finish`).
    departed: Vec<u32>,

    // Scratch space, kept to avoid allocating on every call.
    triggered: Vec<Stop>,
    auction_asks: Vec<u32>,
    auction_bids: Vec<u32>,
    auction_prices: Vec<f64>,
    snapshot_stops: Vec<u32>,
}

impl Engine {
    pub const fn new() -> Engine {
        Engine {
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            orders: Vec::new(),
            free_orders: Vec::new(),
            levels: Vec::new(),
            free_levels: Vec::new(),
            buy_stops: BTreeMap::new(),
            sell_stops: BTreeMap::new(),
            stops: Vec::new(),
            free_stops: Vec::new(),
            loc: Vec::new(),
            has_number: Vec::new(),
            resting: 0,
            pending_stops: 0,
            last_price: None,
            arrival: 0.0,
            seq: 0.0,
            phase: CONTINUOUS,
            trades: 0,
            out: Vec::new(),
            freed: Vec::new(),
            departed: Vec::new(),
            triggered: Vec::new(),
            auction_asks: Vec::new(),
            auction_bids: Vec::new(),
            auction_prices: Vec::new(),
            snapshot_stops: Vec::new(),
        }
    }

    // ---- Commands ------------------------------------------------------

    /// Runs one command. Its events are left in `out` and the handles it
    /// freed in `freed`.
    pub fn apply(&mut self, c: &Command) {
        self.out.clear();
        self.freed.clear();
        match c.op {
            OP_SUBMIT => {
                self.ensure_handle(c.handle);
                self.ensure_trader(c.trader);
                self.submit(c);
                self.departed.push(c.handle);
            }
            OP_CANCEL => {
                self.ensure_handle(c.handle);
                self.cancel(c.handle);
                self.departed.push(c.handle);
            }
            OP_AMEND => {
                self.ensure_handle(c.handle);
                let price = if c.flags & HAS_PRICE != 0 { Some(c.price) } else { None };
                let quantity = if c.flags & HAS_QUANTITY != 0 { Some(c.quantity) } else { None };
                self.amend(c.handle, price, quantity);
                self.departed.push(c.handle);
            }
            OP_START_AUCTION => self.start_auction(),
            OP_UNCROSS => self.uncross(),
            _ => {}
        }
        self.finish();
    }

    /// Reports every handle whose order no longer exists, once each. A handle
    /// can leave and come back within one command (an amend, a stop that
    /// triggers and rests), so liveness is checked only at the end.
    fn finish(&mut self) {
        for &h in &self.departed {
            if self.loc[h as usize] == DEAD {
                self.loc[h as usize] = REPORTED;
                self.freed.push(h);
            }
        }
        for &h in &self.freed {
            self.loc[h as usize] = DEAD;
        }
        self.departed.clear();
    }

    fn ensure_handle(&mut self, h: u32) {
        if h as usize >= self.loc.len() {
            self.loc.resize(h as usize + 1, DEAD);
        }
    }

    fn ensure_trader(&mut self, t: u32) {
        if t as usize >= self.has_number.len() {
            self.has_number.resize(t as usize + 1, false);
        }
    }

    fn is_resting(&self, h: u32) -> bool {
        self.loc[h as usize] < STOP
    }

    fn is_stop(&self, h: u32) -> bool {
        let l = self.loc[h as usize];
        l >= STOP && l < REPORTED
    }

    /// Stops continuous matching. Limit orders rest without trading until `uncross`.
    pub fn start_auction(&mut self) {
        if self.phase == AUCTION {
            return;
        }
        self.phase = AUCTION;
        self.emit(&[EV_PHASE as f64, AUCTION as f64, f64::NAN, 0.0]);
    }

    /// Ends the auction: everything that can trade does, at one price, and
    /// continuous trading resumes (which may set off stops).
    pub fn uncross(&mut self) {
        if self.phase != AUCTION {
            return;
        }
        let result = self.indicative_auction();
        if let Some(r) = result {
            self.execute_auction(r);
        }
        self.phase = CONTINUOUS;
        let (price, volume) = match result {
            Some(r) => (r.price, r.volume),
            None => (f64::NAN, 0.0),
        };
        self.emit(&[EV_PHASE as f64, CONTINUOUS as f64, price, volume]);
        self.run_stops();
    }

    /// The price an uncross would trade at right now, or None if nothing
    /// crosses. Same rules as the TypeScript engine: maximise volume, then
    /// minimise |imbalance|, then nearest the last price, then lowest. Only
    /// levels between the best ask and the best bid can trade, so only those
    /// are candidates.
    pub fn indicative_auction(&mut self) -> Option<Auction> {
        let (_, &best_bid) = self.bids.first_key_value()?;
        let (_, &best_ask) = self.asks.first_key_value()?;
        let high = self.levels[best_bid as usize].price;
        let low = self.levels[best_ask as usize].price;
        if high < low {
            return None;
        }

        let levels = &self.levels;
        let size = |li: u32| levels[li as usize].total + levels[li as usize].hidden;
        // Both ascending by price.
        let asks = &mut self.auction_asks;
        asks.clear();
        for (_, &li) in self.asks.iter() {
            if levels[li as usize].price > high {
                break;
            }
            asks.push(li);
        }
        let bids = &mut self.auction_bids;
        bids.clear();
        bids.extend(self.bids.range(..=book_key(BUY, low)).rev().map(|(_, &li)| li));

        // Every distinct price on either side, ascending (a merge of two sorted lists).
        let prices = &mut self.auction_prices;
        prices.clear();
        let (mut i, mut j) = (0, 0);
        while i < asks.len() || j < bids.len() {
            let a = asks.get(i).map_or(f64::INFINITY, |&li| levels[li as usize].price);
            let b = bids.get(j).map_or(f64::INFINITY, |&li| levels[li as usize].price);
            let p = min(a, b);
            if a == p {
                i += 1;
            }
            if b == p {
                j += 1;
            }
            prices.push(p);
        }

        let mut demand = 0.0;
        for &li in bids.iter() {
            demand += size(li);
        }
        let mut supply = 0.0;
        let (mut a, mut b) = (0, 0);
        let mut best: Option<Auction> = None;
        let mut best_distance = f64::INFINITY;
        for &price in prices.iter() {
            while a < asks.len() && levels[asks[a] as usize].price <= price {
                supply += size(asks[a]);
                a += 1;
            }
            while b < bids.len() && levels[bids[b] as usize].price < price {
                demand -= size(bids[b]);
                b += 1;
            }
            let volume = min(demand, supply);
            if volume == 0.0 {
                continue;
            }
            let imbalance = demand - supply;
            let distance = match self.last_price {
                None => 0.0,
                Some(last) => (price - last).abs(),
            };
            let better = match best {
                None => true,
                Some(b) => {
                    volume > b.volume
                        || (volume == b.volume
                            && (imbalance.abs() < b.imbalance.abs()
                                || (imbalance.abs() == b.imbalance.abs() && distance < best_distance)))
                }
            };
            if better {
                best = Some(Auction { price, volume, imbalance });
                best_distance = distance;
            }
        }
        best
    }

    /// Ids must be unique among live orders (resting or pending stop); the
    /// wrapper hands every live id one handle, so a live handle is a duplicate.
    fn submit(&mut self, c: &Command) {
        let h = c.handle;
        if self.is_resting(h) || self.is_stop(h) {
            return self.reject(h, REJECT_DUPLICATE_ID);
        }
        if !is_positive_integer(c.quantity) {
            return self.reject(h, REJECT_INVALID_QUANTITY);
        }
        if c.kind == KIND_LIMIT && !is_positive_integer(c.price) {
            return self.reject(h, REJECT_INVALID_PRICE);
        }
        let has_limit = c.flags & HAS_LIMIT != 0;
        if c.kind == KIND_STOP {
            if !is_positive_integer(c.price) {
                return self.reject(h, REJECT_INVALID_STOP_PRICE);
            }
            if has_limit && !is_positive_integer(c.limit_price) {
                return self.reject(h, REJECT_INVALID_PRICE);
            }
        }

        let limit = match c.kind {
            KIND_LIMIT => Some(c.price),
            KIND_STOP if has_limit => Some(c.limit_price),
            _ => None,
        };
        let tif = if limit.is_some() {
            if c.tif == TIF_ABSENT { GTC } else { c.tif }
        } else if c.tif == FOK {
            FOK
        } else {
            IOC
        };
        let display = if c.kind == KIND_LIMIT && c.flags & HAS_DISPLAY != 0 { Some(c.display) } else { None };
        if let Some(d) = display {
            if !is_positive_integer(d) || tif != GTC {
                return self.reject(h, REJECT_INVALID_DISPLAY_QUANTITY);
            }
        }
        if c.kind == KIND_STOP && self.last_price.is_some() && self.is_triggered(c.side, c.price) {
            return self.reject(h, REJECT_INVALID_STOP_PRICE);
        }
        // An auction only collects orders that can wait for the uncross.
        if self.phase == AUCTION && c.kind != KIND_STOP && (c.kind == KIND_MARKET || tif != GTC) {
            return self.reject(h, REJECT_NOT_ALLOWED_IN_AUCTION);
        }

        self.emit(&[EV_ACCEPTED as f64, h as f64]);

        if c.kind == KIND_STOP {
            self.arrival += 1.0;
            self.park_stop(Stop {
                stop_price: c.price,
                limit_price: limit,
                quantity: c.quantity,
                arrival: self.arrival,
                handle: h,
                trader: c.trader,
                side: c.side,
                tif,
                self_trade: c.self_trade,
            });
            self.emit(&[EV_STOP_PENDING as f64, h as f64, c.side as f64, c.price, c.quantity]);
            return;
        }

        let mut taker = Taker { handle: h, trader: c.trader, side: c.side, remaining: c.quantity, self_trade: c.self_trade };
        self.execute(&mut taker, limit, tif, display);
        self.run_stops();
    }

    fn cancel(&mut self, h: u32) {
        if self.is_stop(h) {
            let index = self.loc[h as usize] & !STOP;
            let quantity = self.stops[index as usize].quantity;
            self.unpark_stop(index);
            self.emit(&[EV_CANCELLED as f64, h as f64, quantity, CANCEL_USER as f64]);
            return;
        }
        if !self.is_resting(h) {
            return self.reject(h, REJECT_UNKNOWN_ORDER);
        }
        let slot = self.loc[h as usize];
        let o = self.orders[slot as usize];
        let remaining = o.visible + o.hidden;
        self.remove_resting(slot);
        self.emit(&[EV_CANCELLED as f64, h as f64, remaining, CANCEL_USER as f64]);
    }

    /// Reducing quantity at the same price keeps the order's place in the
    /// queue. Any other change sends it to the back, and if the new price
    /// crosses the spread it trades immediately.
    fn amend(&mut self, h: u32, new_price: Option<f64>, new_quantity: Option<f64>) {
        if self.is_stop(h) {
            return self.reject(h, REJECT_NOT_AMENDABLE);
        }
        if !self.is_resting(h) {
            return self.reject(h, REJECT_UNKNOWN_ORDER);
        }
        let slot = self.loc[h as usize];
        let o = self.orders[slot as usize];
        let total = o.visible + o.hidden;
        let price = new_price.unwrap_or(o.price);
        let quantity = new_quantity.unwrap_or(total);
        if !is_positive_integer(quantity) {
            return self.reject(h, REJECT_INVALID_QUANTITY);
        }
        if !is_positive_integer(price) {
            return self.reject(h, REJECT_INVALID_PRICE);
        }

        if price == o.price && quantity <= total {
            let visible = min(o.visible, quantity);
            self.reduce(o.level, slot, o.visible - visible);
            self.reduce_hidden(o.level, slot, o.hidden - (quantity - visible));
            self.emit(&[EV_AMENDED as f64, h as f64, price, quantity, 1.0]);
            return;
        }

        let mut taker = Taker { handle: h, trader: o.trader, side: o.side, remaining: quantity, self_trade: o.self_trade };
        let display = if o.display < 0.0 { None } else { Some(o.display) };
        self.remove_resting(slot);
        self.emit(&[EV_AMENDED as f64, h as f64, price, quantity, 0.0]);
        self.execute(&mut taker, Some(price), GTC, display);
        self.run_stops();
    }

    // ---- Matching ------------------------------------------------------

    /// Runs an order that is entering the book now: FOK check, match, then rest or cancel the remainder.
    fn execute(&mut self, taker: &mut Taker, limit: Option<f64>, tif: u8, display: Option<f64>) {
        // In an auction (only GTC limits get this far) orders wait for the uncross.
        if self.phase == AUCTION {
            let price = limit.expect("only limit orders reach an auction");
            self.rest(taker, price, display);
            return;
        }
        if tif == FOK && self.liquidity(taker, limit, taker.remaining) < taker.remaining {
            self.emit(&[EV_CANCELLED as f64, taker.handle as f64, taker.remaining, CANCEL_FOK_UNFILLABLE as f64]);
            return;
        }
        self.match_taker(taker, limit);
        if taker.remaining == 0.0 {
            return;
        }
        match limit {
            Some(price) if tif == GTC => self.rest(taker, price, display),
            _ => self.emit(&[EV_CANCELLED as f64, taker.handle as f64, taker.remaining, CANCEL_UNFILLED_REMAINDER as f64]),
        }
    }

    fn best(&self, book_side: u8) -> Option<u32> {
        let tree = if book_side == BUY { &self.bids } else { &self.asks };
        tree.first_key_value().map(|(_, &li)| li)
    }

    fn match_taker(&mut self, taker: &mut Taker, limit: Option<f64>) {
        let book_side = if taker.side == BUY { SELL } else { BUY };
        // NONE matches nobody, so "allow" never looks for the trader's own orders.
        let taker_trader = if taker.self_trade == ALLOW { NONE } else { taker.trader };
        while taker.remaining > 0.0 {
            let Some(li) = self.best(book_side) else { return };
            let price = self.levels[li as usize].price;
            if !crosses(taker.side, price, limit) {
                return;
            }

            while taker.remaining > 0.0 {
                let maker = self.levels[li as usize].head;
                if maker == NONE {
                    break;
                }
                let m = self.orders[maker as usize];
                if taker_trader != NONE && m.trader == taker_trader {
                    self.prevent_self_trade(taker, maker);
                    continue;
                }
                let quantity = min(taker.remaining, m.visible);
                taker.remaining -= quantity;
                self.reduce(li, maker, quantity);
                self.last_price = Some(price);
                self.trades += 1;
                self.emit(&[
                    EV_TRADE as f64,
                    price,
                    quantity,
                    m.handle as f64,
                    m.trader as f64,
                    taker.handle as f64,
                    taker.trader as f64,
                    taker.side as f64,
                ]);
                if self.orders[maker as usize].visible == 0.0 {
                    self.consumed(maker);
                }
            }
        }
    }

    /// A resting order whose visible quantity just ran out: an iceberg shows
    /// its next slice at the back of the queue; anything else leaves the book.
    fn consumed(&mut self, slot: u32) {
        let o = self.orders[slot as usize];
        if o.hidden > 0.0 {
            self.unlink(o.level, slot);
            let order = &mut self.orders[slot as usize];
            order.visible = min(order.display, order.hidden);
            order.hidden -= order.visible;
            self.push(o.level, slot);
        } else {
            self.remove_resting(slot);
        }
    }

    /// Trades the auction's volume at its single price. Best bids meet best
    /// asks in price-time priority; the buyer is reported as the taker by
    /// convention, and self-trade prevention does not apply.
    fn execute_auction(&mut self, result: Auction) {
        let mut remaining = result.volume;
        while remaining > 0.0 {
            let bid_level = self.best(BUY).expect("the auction volume is on the book");
            let ask_level = self.best(SELL).expect("the auction volume is on the book");
            let bid = self.levels[bid_level as usize].head;
            let ask = self.levels[ask_level as usize].head;
            let (b, a) = (self.orders[bid as usize], self.orders[ask as usize]);
            let quantity = min(min(remaining, b.visible), a.visible);
            remaining -= quantity;
            self.reduce(bid_level, bid, quantity);
            self.reduce(ask_level, ask, quantity);
            self.last_price = Some(result.price);
            self.trades += 1;
            self.emit(&[
                EV_TRADE as f64,
                result.price,
                quantity,
                a.handle as f64,
                a.trader as f64,
                b.handle as f64,
                b.trader as f64,
                BUY as f64,
            ]);
            if self.orders[bid as usize].visible == 0.0 {
                self.consumed(bid);
            }
            if self.orders[ask as usize].visible == 0.0 {
                self.consumed(ask);
            }
        }
    }

    fn prevent_self_trade(&mut self, taker: &mut Taker, maker: u32) {
        let policy = taker.self_trade;
        if policy == CANCEL_MAKER || policy == CANCEL_BOTH {
            let m = self.orders[maker as usize];
            self.remove_resting(maker);
            self.emit(&[EV_CANCELLED as f64, m.handle as f64, m.visible + m.hidden, CANCEL_SELF_TRADE as f64]);
        }
        if policy == CANCEL_TAKER || policy == CANCEL_BOTH {
            self.emit(&[EV_CANCELLED as f64, taker.handle as f64, taker.remaining, CANCEL_SELF_TRADE as f64]);
            taker.remaining = 0.0;
        }
    }

    /// Quantity a FOK taker could fill right now, counting only up to
    /// `needed`. Hidden iceberg reserves count, because their slices refill
    /// during the same match. If self-trade prevention would cancel the
    /// taker at some resting order, matching stops there: only the visible
    /// quantity queued ahead of it can fill, since refills join behind it.
    fn liquidity(&self, taker: &Taker, limit: Option<f64>, needed: f64) -> f64 {
        let tree = if taker.side == BUY { &self.asks } else { &self.bids };
        let numbered = self.has_number[taker.trader as usize];
        let mut available = 0.0;
        for (_, &li) in tree.iter() {
            let level = &self.levels[li as usize];
            if !crosses(taker.side, level.price, limit) {
                break;
            }
            if taker.self_trade == ALLOW || !numbered {
                available += level.total + level.hidden;
            } else {
                let mut level_total = 0.0;
                let mut visible_ahead = 0.0;
                let mut o = level.head;
                while o != NONE {
                    let order = &self.orders[o as usize];
                    if order.trader == taker.trader {
                        if taker.self_trade == CANCEL_MAKER {
                            o = order.next;
                            continue;
                        }
                        return available + visible_ahead;
                    }
                    visible_ahead += order.visible;
                    level_total += order.visible + order.hidden;
                    o = order.next;
                }
                available += level_total;
            }
            if available >= needed {
                break;
            }
        }
        available
    }

    fn rest(&mut self, taker: &Taker, price: f64, display: Option<f64>) {
        let visible = match display {
            None => taker.remaining,
            Some(d) => min(d, taker.remaining),
        };
        self.insert_resting(
            taker.handle,
            taker.trader,
            taker.side,
            price,
            visible,
            taker.remaining - visible,
            display.unwrap_or(-1.0),
            taker.self_trade,
        );
        self.emit(&[EV_RESTED as f64, taker.handle as f64, taker.side as f64, price, taker.remaining, visible]);
    }

    // ---- Book structure ------------------------------------------------

    /// Appends an order to the back of its price level's queue.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_resting(
        &mut self,
        handle: u32,
        trader: u32,
        side: u8,
        price: f64,
        visible: f64,
        hidden: f64,
        display: f64,
        self_trade: u8,
    ) {
        self.ensure_handle(handle);
        self.ensure_trader(trader);
        let tree = if side == BUY { &mut self.bids } else { &mut self.asks };
        let key = book_key(side, price);
        let li = match tree.get(&key) {
            Some(&li) => li,
            None => {
                let level = Level { price, total: 0.0, hidden: 0.0, head: NONE, tail: NONE, count: 0 };
                let li = match self.free_levels.pop() {
                    Some(li) => {
                        self.levels[li as usize] = level;
                        li
                    }
                    None => {
                        self.levels.push(level);
                        (self.levels.len() - 1) as u32
                    }
                };
                tree.insert(key, li);
                li
            }
        };
        let order = Order { price, visible, hidden, display, handle, trader, level: li, prev: NONE, next: NONE, side, self_trade };
        let slot = match self.free_orders.pop() {
            Some(slot) => {
                self.orders[slot as usize] = order;
                slot
            }
            None => {
                self.orders.push(order);
                (self.orders.len() - 1) as u32
            }
        };
        self.has_number[trader as usize] = true;
        self.push(li, slot);
        self.loc[handle as usize] = slot;
        self.resting += 1;
    }

    /// Takes an order off the book and frees its slot; read anything needed from it first.
    fn remove_resting(&mut self, slot: u32) {
        let o = self.orders[slot as usize];
        self.unlink(o.level, slot);
        self.loc[o.handle as usize] = DEAD;
        self.departed.push(o.handle);
        self.resting -= 1;
        let level = self.levels[o.level as usize];
        if level.head == NONE {
            let tree = if o.side == BUY { &mut self.bids } else { &mut self.asks };
            tree.remove(&book_key(o.side, level.price));
            self.free_levels.push(o.level);
        }
        self.free_orders.push(slot);
    }

    fn push(&mut self, li: u32, slot: u32) {
        let tail = self.levels[li as usize].tail;
        let o = &mut self.orders[slot as usize];
        o.prev = tail;
        o.next = NONE;
        o.level = li;
        let (visible, hidden) = (o.visible, o.hidden);
        if tail == NONE {
            self.levels[li as usize].head = slot;
        } else {
            self.orders[tail as usize].next = slot;
        }
        let level = &mut self.levels[li as usize];
        level.tail = slot;
        level.total += visible;
        level.hidden += hidden;
        level.count += 1;
    }

    fn unlink(&mut self, li: u32, slot: u32) {
        let o = self.orders[slot as usize];
        if o.prev == NONE {
            self.levels[li as usize].head = o.next;
        } else {
            self.orders[o.prev as usize].next = o.next;
        }
        if o.next == NONE {
            self.levels[li as usize].tail = o.prev;
        } else {
            self.orders[o.next as usize].prev = o.prev;
        }
        let order = &mut self.orders[slot as usize];
        order.prev = NONE;
        order.next = NONE;
        let level = &mut self.levels[li as usize];
        level.total -= o.visible;
        level.hidden -= o.hidden;
        level.count -= 1;
    }

    /// Lowers an order's visible quantity in place, keeping its queue position.
    fn reduce(&mut self, li: u32, slot: u32, quantity: f64) {
        self.orders[slot as usize].visible -= quantity;
        self.levels[li as usize].total -= quantity;
    }

    fn reduce_hidden(&mut self, li: u32, slot: u32, quantity: f64) {
        self.orders[slot as usize].hidden -= quantity;
        self.levels[li as usize].hidden -= quantity;
    }

    // ---- Stops -----------------------------------------------------------

    fn is_triggered(&self, side: u8, stop_price: f64) -> bool {
        let last = self.last_price.expect("checked by the caller");
        if side == BUY { last >= stop_price } else { last <= stop_price }
    }

    fn park_stop(&mut self, stop: Stop) {
        self.ensure_handle(stop.handle);
        // A stop restored from a snapshot may be its trader's only order; the
        // FOK check reads `has_number` for it once it triggers.
        self.ensure_trader(stop.trader);
        let index = match self.free_stops.pop() {
            Some(i) => {
                self.stops[i as usize] = stop;
                i
            }
            None => {
                self.stops.push(stop);
                (self.stops.len() - 1) as u32
            }
        };
        let tree = if stop.side == BUY { &mut self.buy_stops } else { &mut self.sell_stops };
        tree.entry(stop_key(stop.side, stop.stop_price)).or_default().push(index);
        self.loc[stop.handle as usize] = STOP | index;
        self.pending_stops += 1;
    }

    fn unpark_stop(&mut self, index: u32) {
        let stop = self.stops[index as usize];
        let tree = if stop.side == BUY { &mut self.buy_stops } else { &mut self.sell_stops };
        let key = stop_key(stop.side, stop.stop_price);
        let queue = tree.get_mut(&key).expect("a pending stop is queued at its price");
        let position = queue.iter().position(|&i| i == index).expect("a pending stop is in its queue");
        queue.remove(position);
        if queue.is_empty() {
            tree.remove(&key);
        }
        self.forget_stop(index);
    }

    fn forget_stop(&mut self, index: u32) {
        let handle = self.stops[index as usize].handle;
        self.loc[handle as usize] = DEAD;
        self.departed.push(handle);
        self.pending_stops -= 1;
        self.free_stops.push(index);
    }

    /// Enters every stop the last trade price has reached, oldest first.
    /// Their trades can move the price through more stops, so repeat until
    /// none fire.
    fn run_stops(&mut self) {
        let mut triggered = std::mem::take(&mut self.triggered);
        while self.pending_stops > 0 {
            let Some(last) = self.last_price else { break };
            triggered.clear();
            // Buy stops fire as the price rises (lowest first); sell stops as it falls.
            while let Some(entry) = self.buy_stops.first_entry() {
                if !(last >= self.stops[entry.get()[0] as usize].stop_price) {
                    break;
                }
                for &i in entry.remove().iter() {
                    triggered.push(self.stops[i as usize]);
                    self.forget_stop(i);
                }
            }
            while let Some(entry) = self.sell_stops.first_entry() {
                if !(last <= self.stops[entry.get()[0] as usize].stop_price) {
                    break;
                }
                for &i in entry.remove().iter() {
                    triggered.push(self.stops[i as usize]);
                    self.forget_stop(i);
                }
            }
            if triggered.is_empty() {
                break;
            }
            // Stable, like JavaScript's sort: arrivals are unique in any book
            // built by commands, but a hand-made snapshot could repeat one.
            triggered.sort_by(|a, b| a.arrival.total_cmp(&b.arrival));

            for stop in triggered.iter() {
                let last = self.last_price.expect("a trade has printed");
                self.emit(&[EV_TRIGGERED as f64, stop.handle as f64, last]);
                let mut taker =
                    Taker { handle: stop.handle, trader: stop.trader, side: stop.side, remaining: stop.quantity, self_trade: stop.self_trade };
                self.execute(&mut taker, stop.limit_price, stop.tif, None);
            }
        }
        self.triggered = triggered;
    }

    // ---- Events ----------------------------------------------------------

    fn reject(&mut self, h: u32, reason: u8) {
        self.emit(&[EV_REJECTED as f64, h as f64, reason as f64]);
    }

    /// Appends one event record: its tag, the next sequence number, then its fields.
    fn emit(&mut self, record: &[f64]) {
        self.seq += 1.0;
        self.out.push(record[0]);
        self.out.push(self.seq);
        self.out.extend_from_slice(&record[1..]);
    }

    // ---- Queries (results go to `out`) -----------------------------------

    pub fn best_price(&self, side: u8) -> f64 {
        self.best(side).map_or(f64::NAN, |li| self.levels[li as usize].price)
    }

    pub fn last_trade_price(&self) -> f64 {
        self.last_price.unwrap_or(f64::NAN)
    }

    pub fn phase(&self) -> u8 {
        self.phase
    }

    pub fn resting_count(&self) -> u32 {
        self.resting
    }

    pub fn stop_count(&self) -> u32 {
        self.pending_stops
    }

    /// `[bid count, ask count, (price, quantity, orders) per level...]`, best first.
    /// `levels` is compared as a float, as in TypeScript (so NaN means all).
    pub fn depth(&mut self, levels: f64) {
        self.out.clear();
        self.out.extend_from_slice(&[0.0, 0.0]);
        for (side, tree) in [(0, &self.bids), (1, &self.asks)] {
            if levels <= 0.0 {
                continue;
            }
            let mut n = 0.0;
            for (_, &li) in tree.iter() {
                let level = &self.levels[li as usize];
                self.out.extend_from_slice(&[level.price, level.total, level.count as f64]);
                n += 1.0;
                if n >= levels {
                    break;
                }
            }
            self.out[side] = n;
        }
    }

    /// The whole book: a header, then resting orders (bids, then asks, best
    /// first and in queue order), then pending stops in arrival order.
    pub fn snapshot(&mut self) {
        self.out.clear();
        let last = self.last_trade_price();
        self.out.extend_from_slice(&[self.phase as f64, self.seq, self.arrival, last, 0.0, 0.0, 0.0]);
        for (field, tree) in [(4, &self.bids), (5, &self.asks)] {
            let mut n = 0.0;
            for (_, &li) in tree.iter() {
                let mut o = self.levels[li as usize].head;
                while o != NONE {
                    let order = &self.orders[o as usize];
                    self.out.extend_from_slice(&[
                        order.handle as f64,
                        order.trader as f64,
                        order.side as f64,
                        order.price,
                        order.visible,
                        order.hidden,
                        order.display,
                        order.self_trade as f64,
                    ]);
                    n += 1.0;
                    o = order.next;
                }
            }
            self.out[field] = n;
        }
        let stops = &mut self.snapshot_stops;
        stops.clear();
        for queue in self.buy_stops.values().chain(self.sell_stops.values()) {
            stops.extend_from_slice(queue);
        }
        stops.sort_by(|&a, &b| self.stops[a as usize].arrival.total_cmp(&self.stops[b as usize].arrival));
        for &i in stops.iter() {
            let s = &self.stops[i as usize];
            self.out.extend_from_slice(&[
                s.handle as f64,
                s.trader as f64,
                s.side as f64,
                s.stop_price,
                s.limit_price.unwrap_or(f64::NAN),
                s.quantity,
                s.tif as f64,
                s.self_trade as f64,
                s.arrival,
            ]);
        }
        self.out[6] = stops.len() as f64;
    }

    /// `[trader, side, price, remaining, visible]` of a resting order.
    pub fn order_info(&mut self, h: u32) -> bool {
        self.out.clear();
        if h as usize >= self.loc.len() || !self.is_resting(h) {
            return false;
        }
        let o = self.orders[self.loc[h as usize] as usize];
        self.out.extend_from_slice(&[o.trader as f64, o.side as f64, o.price, o.visible + o.hidden, o.visible]);
        true
    }

    /// `[trader, side, stop price, limit price (NaN = none), quantity]` of a pending stop.
    pub fn stop_info(&mut self, h: u32) -> bool {
        self.out.clear();
        if h as usize >= self.loc.len() || !self.is_stop(h) {
            return false;
        }
        let s = self.stops[(self.loc[h as usize] & !STOP) as usize];
        self.out.extend_from_slice(&[s.trader as f64, s.side as f64, s.stop_price, s.limit_price.unwrap_or(f64::NAN), s.quantity]);
        true
    }

    // ---- Restoring a snapshot --------------------------------------------

    pub fn restore_state(&mut self, phase: u8, seq: f64, arrival: f64, last_price: f64) {
        self.phase = phase;
        self.seq = seq;
        self.arrival = arrival;
        self.last_price = if last_price.is_nan() { None } else { Some(last_price) };
    }

    #[allow(clippy::too_many_arguments)]
    pub fn restore_stop(
        &mut self,
        handle: u32,
        trader: u32,
        side: u8,
        stop_price: f64,
        limit_price: f64,
        quantity: f64,
        tif: u8,
        self_trade: u8,
        arrival: f64,
    ) {
        let limit_price = if limit_price.is_nan() { None } else { Some(limit_price) };
        self.park_stop(Stop { stop_price, limit_price, quantity, arrival, handle, trader, side, tif, self_trade });
    }
}
