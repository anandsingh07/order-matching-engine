// Header layout (Int32 slots). The producer's and consumer's counters sit 64
// bytes apart so the two threads do not fight over one cache line.
const HEAD = 0; // words read so far (written by the consumer)
const SPACE_WAITING = 1; // producer is asleep waiting for space
const TAIL = 16; // words written so far (written by the producer)
const DATA_WAITING = 17; // consumer is asleep waiting for data
const HEADER_INTS = 32;

/** Length slot value meaning "nothing more here, continue at the start". */
const WRAP = -1;

/**
 * Lock-free single-producer / single-consumer queue of byte messages in a
 * SharedArrayBuffer, for passing work between threads without copying through
 * postMessage.
 *
 * - `head` and `tail` are ever-increasing 32-bit word counters; the slot index
 *   is `counter & mask`, so capacity must be a power of two.
 * - A message is one length word followed by its bytes, padded to 4 bytes. A
 *   message that would run past the end leaves a WRAP marker and starts again
 *   at index 0, so every message is contiguous.
 * - The producer publishes by storing `tail` with Atomics (sequentially
 *   consistent), which makes the message bytes visible before the consumer
 *   can see the new tail.
 * - Sleeping uses Atomics.wait/notify, but only when the other side has raised
 *   a waiting flag, so the busy path never makes a system call.
 */
export class RingBuffer {
  readonly sab: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly words: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly capacity: number;
  private readonly mask: number;
  private lastSeenHead = 0;

  static allocate(capacityBytes: number): SharedArrayBuffer {
    const words = capacityBytes / 4;
    if (!Number.isInteger(words) || words < 16 || (words & (words - 1)) !== 0) {
      throw new RangeError("capacityBytes must be a power of two of at least 64");
    }
    return new SharedArrayBuffer(HEADER_INTS * 4 + capacityBytes);
  }

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.words = new Int32Array(sab, HEADER_INTS * 4);
    this.bytes = new Uint8Array(sab, HEADER_INTS * 4);
    this.capacity = this.words.length;
    this.mask = this.capacity - 1;
  }

  /**
   * Largest message that is always writable into an empty buffer. With at
   * most half the capacity per message, wrap padding plus the message
   * always fits.
   */
  get maxMessageBytes(): number {
    return (this.capacity / 2 - 1) * 4;
  }

  // ---- producer side ----

  /** Appends a message; returns false if there is not enough free space right now. */
  tryWrite(payload: Uint8Array): boolean {
    const length = payload.length;
    const size = 1 + ((length + 3) >>> 2);
    if (size > this.capacity / 2) throw new RangeError(`message of ${length} bytes exceeds ${this.maxMessageBytes}`);

    const head = Atomics.load(this.header, HEAD) >>> 0;
    let tail = Atomics.load(this.header, TAIL) >>> 0;
    this.lastSeenHead = head;
    const free = this.capacity - ((tail - head) >>> 0);
    let index = tail & this.mask;
    const pad = index + size > this.capacity ? this.capacity - index : 0;
    if (pad + size > free) return false;

    if (pad > 0) {
      this.words[index] = WRAP;
      tail = (tail + pad) >>> 0;
      index = 0;
    }
    this.words[index] = length;
    this.bytes.set(payload, (index + 1) * 4);
    Atomics.store(this.header, TAIL, (tail + size) | 0);
    if (Atomics.load(this.header, DATA_WAITING) === 1) Atomics.notify(this.header, TAIL);
    return true;
  }

  /** Blocks (worker threads only) until the consumer frees space or the timeout passes. */
  waitForSpace(timeoutMs: number): void {
    Atomics.store(this.header, SPACE_WAITING, 1);
    if ((Atomics.load(this.header, HEAD) >>> 0) === this.lastSeenHead) {
      Atomics.wait(this.header, HEAD, this.lastSeenHead | 0, timeoutMs);
    }
    Atomics.store(this.header, SPACE_WAITING, 0);
  }

  /** Non-blocking version of waitForSpace for the main thread. */
  async waitForSpaceAsync(timeoutMs: number): Promise<void> {
    Atomics.store(this.header, SPACE_WAITING, 1);
    if ((Atomics.load(this.header, HEAD) >>> 0) === this.lastSeenHead) {
      const result = Atomics.waitAsync(this.header, HEAD, this.lastSeenHead | 0, timeoutMs);
      if (result.async) await result.value;
    }
    Atomics.store(this.header, SPACE_WAITING, 0);
  }

  // ---- consumer side ----

  /** Removes and returns every message currently available, oldest first. */
  readAll(): Uint8Array[] {
    let head = Atomics.load(this.header, HEAD) >>> 0;
    const tail = Atomics.load(this.header, TAIL) >>> 0;
    if (head === tail) return [];
    const out: Uint8Array[] = [];
    while (head !== tail) {
      const index = head & this.mask;
      const length = this.words[index]!;
      if (length === WRAP) {
        head = (head + (this.capacity - index)) >>> 0;
        continue;
      }
      const start = (index + 1) * 4;
      // slice() copies into an ordinary (non-shared) buffer the caller can keep.
      out.push(this.bytes.slice(start, start + length));
      head = (head + 1 + ((length + 3) >>> 2)) >>> 0;
    }
    Atomics.store(this.header, HEAD, head | 0);
    if (Atomics.load(this.header, SPACE_WAITING) === 1) Atomics.notify(this.header, HEAD);
    return out;
  }

  /** Blocks (worker threads only) until a message arrives or the timeout passes. */
  waitForData(timeoutMs: number): void {
    Atomics.store(this.header, DATA_WAITING, 1);
    const head = Atomics.load(this.header, HEAD);
    if (Atomics.load(this.header, TAIL) === head) Atomics.wait(this.header, TAIL, head, timeoutMs);
    Atomics.store(this.header, DATA_WAITING, 0);
  }

  /** Non-blocking version of waitForData for the main thread. */
  async waitForDataAsync(timeoutMs: number): Promise<void> {
    Atomics.store(this.header, DATA_WAITING, 1);
    const head = Atomics.load(this.header, HEAD);
    if (Atomics.load(this.header, TAIL) === head) {
      const result = Atomics.waitAsync(this.header, TAIL, head, timeoutMs);
      if (result.async) await result.value;
    }
    Atomics.store(this.header, DATA_WAITING, 0);
  }
}
