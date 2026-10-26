import { workerData } from "node:worker_threads";
import { RingBuffer } from "../../src/ring-buffer.js";

// Writes `count` messages of varying size into the ring as fast as it can.
// Message i is (i mod 997) bytes long, starts with i as a 32-bit number when
// long enough, and every other byte is (i + position) & 255, so the consumer
// can verify order and content.

const { sab, count } = workerData as { sab: SharedArrayBuffer; count: number };
const ring = new RingBuffer(sab);

export function messageFor(i: number): Uint8Array {
  const bytes = new Uint8Array(i % 997);
  for (let k = 0; k < bytes.length; k++) bytes[k] = (i + k) & 255;
  if (bytes.length >= 4) new DataView(bytes.buffer).setUint32(0, i, true);
  return bytes;
}

for (let i = 0; i < count; i++) {
  const message = messageFor(i);
  while (!ring.tryWrite(message)) ring.waitForSpace(50);
}
