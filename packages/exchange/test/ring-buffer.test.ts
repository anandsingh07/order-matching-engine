import { Worker } from "node:worker_threads";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

const bootstrap = new URL("../src/worker-bootstrap.mjs", import.meta.url);
const producer = new URL("./fixtures/producer.ts", import.meta.url).href;

/** Same message rule as the producer fixture. */
function messageFor(i: number): Uint8Array {
  const bytes = new Uint8Array(i % 997);
  for (let k = 0; k < bytes.length; k++) bytes[k] = (i + k) & 255;
  if (bytes.length >= 4) new DataView(bytes.buffer).setUint32(0, i, true);
  return bytes;
}

describe("RingBuffer", () => {
  it("behaves like a FIFO queue, including wrap-around and full buffers", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(64, 128, 256),
        fc.array(fc.oneof(fc.integer({ min: 0, max: 200 }), fc.constant(-1)), { maxLength: 300, size: "max" }),
        (capacity, ops) => {
          const ring = new RingBuffer(RingBuffer.allocate(capacity));
          const model: Uint8Array[] = [];
          let n = 0;
          for (const op of ops) {
            if (op === -1) {
              expect(ring.readAll()).toEqual(model.splice(0));
              continue;
            }
            const message = new Uint8Array(op % (ring.maxMessageBytes + 1)).map((_, k) => (n + k) & 255);
            n++;
            if (ring.tryWrite(message)) model.push(message);
            else expect(model.length).toBeGreaterThan(0); // only a non-empty ring may be full
          }
          expect(ring.readAll()).toEqual(model);
          expect(ring.readAll()).toEqual([]);
        },
      ),
    );
  });

  it("rejects messages larger than half the capacity", () => {
    const ring = new RingBuffer(RingBuffer.allocate(64));
    expect(ring.maxMessageBytes).toBe(28);
    expect(() => ring.tryWrite(new Uint8Array(29))).toThrow(RangeError);
  });

  it("delivers every message intact and in order between two real threads", async () => {
    const count = 200_000;
    // A small ring forces constant wrap-around and producer back-pressure.
    const sab = RingBuffer.allocate(16 * 1024);
    const ring = new RingBuffer(sab);
    const worker = new Worker(bootstrap, { workerData: { entry: producer, sab, count } });

    let received = 0;
    let firstMismatch = -1;
    while (received < count) {
      const messages = ring.readAll();
      if (messages.length === 0) {
        await ring.waitForDataAsync(100);
        continue;
      }
      for (const message of messages) {
        if (firstMismatch === -1 && Buffer.compare(message, messageFor(received)) !== 0) firstMismatch = received;
        received++;
      }
    }
    await new Promise((resolve) => worker.once("exit", resolve));
    expect(firstMismatch).toBe(-1);
    expect(received).toBe(count);
  }, 60_000);
});
