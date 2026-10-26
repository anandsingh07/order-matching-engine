//! The binary protocol between the TypeScript wrapper and the engine. It must
//! match `src/protocol.ts`; the differential tests fail at once if it does not.
//!
//! Everything is an f64 word, so the wrapper reads and writes one
//! `Float64Array` and handles, enums and quantities all round-trip exactly.
//!
//! A command is `CMD_WORDS` words:
//!   0  header: op | kind << 4 | side << 8 | tif << 12 | self-trade << 16 | flags << 20
//!   1  order handle
//!   2  trader handle
//!   3  quantity (or the amend's new quantity)
//!   4  price: the limit price, the stop price, or the amend's new price
//!   5  a stop's limit price
//!   6  display (iceberg slice) quantity
//!
//! An event is its tag, its sequence number, then its fields:
//!   accepted      order
//!   rejected      order, reason
//!   trade         price, quantity, maker order, maker trader, taker order, taker trader, taker side
//!   rested        order, side, price, quantity, visible
//!   cancelled     order, remaining, reason
//!   amended       order, price, quantity, kept priority (0/1)
//!   stop_pending  order, side, stop price, quantity
//!   triggered     order, last price
//!   phase         phase, price (NaN = null), volume

pub const CMD_WORDS: usize = 8;

pub const OP_SUBMIT: u32 = 0;
pub const OP_CANCEL: u32 = 1;
pub const OP_AMEND: u32 = 2;
pub const OP_START_AUCTION: u32 = 3;
pub const OP_UNCROSS: u32 = 4;

pub const KIND_LIMIT: u8 = 0;
pub const KIND_MARKET: u8 = 1;
pub const KIND_STOP: u8 = 2;

pub const BUY: u8 = 0;
pub const SELL: u8 = 1;

pub const GTC: u8 = 0;
pub const IOC: u8 = 1;
pub const FOK: u8 = 2;
/// No time in force given, so the engine applies the default for the order type.
pub const TIF_ABSENT: u8 = 3;

pub const ALLOW: u8 = 0;
pub const CANCEL_TAKER: u8 = 1;
pub const CANCEL_MAKER: u8 = 2;
pub const CANCEL_BOTH: u8 = 3;

// Presence flags, because "absent" and "present but invalid" are different
// inputs (an absent amend price keeps the old one; a NaN one is rejected).
pub const HAS_LIMIT: u32 = 1;
pub const HAS_DISPLAY: u32 = 2;
pub const HAS_PRICE: u32 = 4;
pub const HAS_QUANTITY: u32 = 8;

pub const CONTINUOUS: u8 = 0;
pub const AUCTION: u8 = 1;

pub const EV_ACCEPTED: u8 = 0;
pub const EV_REJECTED: u8 = 1;
pub const EV_TRADE: u8 = 2;
pub const EV_RESTED: u8 = 3;
pub const EV_CANCELLED: u8 = 4;
pub const EV_AMENDED: u8 = 5;
pub const EV_STOP_PENDING: u8 = 6;
pub const EV_TRIGGERED: u8 = 7;
pub const EV_PHASE: u8 = 8;

pub const REJECT_NOT_ALLOWED_IN_AUCTION: u8 = 0;
pub const REJECT_DUPLICATE_ID: u8 = 1;
pub const REJECT_INVALID_QUANTITY: u8 = 2;
pub const REJECT_INVALID_PRICE: u8 = 3;
pub const REJECT_INVALID_DISPLAY_QUANTITY: u8 = 4;
pub const REJECT_INVALID_STOP_PRICE: u8 = 5;
pub const REJECT_UNKNOWN_ORDER: u8 = 6;
pub const REJECT_NOT_AMENDABLE: u8 = 7;

pub const CANCEL_USER: u8 = 0;
pub const CANCEL_UNFILLED_REMAINDER: u8 = 1;
pub const CANCEL_FOK_UNFILLABLE: u8 = 2;
pub const CANCEL_SELF_TRADE: u8 = 3;
