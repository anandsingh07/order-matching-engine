// The binary protocol between this wrapper and the Rust engine. It mirrors
// rust/src/protocol.rs, which documents the layout of commands and events;
// the differential tests fail at once if the two disagree.

/** f64 words per command. */
export const CMD_WORDS = 8;

export const OP_SUBMIT = 0;
export const OP_CANCEL = 1;
export const OP_AMEND = 2;
export const OP_START_AUCTION = 3;
export const OP_UNCROSS = 4;

export const KIND_LIMIT = 0;
export const KIND_MARKET = 1;
export const KIND_STOP = 2;

export const GTC = 0;
export const IOC = 1;
export const FOK = 2;
/** No time in force given, so the engine applies the default for the order type. */
export const TIF_ABSENT = 3;

export const HAS_LIMIT = 1;
export const HAS_DISPLAY = 2;
export const HAS_PRICE = 4;
export const HAS_QUANTITY = 8;

export const EV_ACCEPTED = 0;
export const EV_REJECTED = 1;
export const EV_TRADE = 2;
export const EV_RESTED = 3;
export const EV_CANCELLED = 4;
export const EV_AMENDED = 5;
export const EV_STOP_PENDING = 6;
export const EV_TRIGGERED = 7;
export const EV_PHASE = 8;

/** Byte offset of the output header (after `CMD_WORDS` f64s) inside the shared `Io` block. */
export const IO_HEADER = CMD_WORDS * 8;

/** The header word of a command. */
export const header = (op: number, kind = 0, side = 0, tif = 0, selfTrade = 0, flags = 0): number =>
  op | (kind << 4) | (side << 8) | (tif << 12) | (selfTrade << 16) | (flags << 20);
