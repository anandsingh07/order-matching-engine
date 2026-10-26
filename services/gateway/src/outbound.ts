import type { Socket } from "node:net";
import type { WebSocket } from "@fastify/websocket";

// Outbound writes, shared by the single-process gateway and the front-end
// processes (cluster/frontend.ts).
//
// Profiling showed half of the gateway's main thread in one socket write
// syscall per message: an order produces three to four messages, each its own
// write. Corking a socket on its first message of an event-loop turn and
// uncorking it once the turn's work is done turns those into one write per
// socket per turn. Measured on a 150-byte loopback write: 13-14 us of CPU
// uncorked, about 2 us per message corked 30 to a write.

const corked = new Set<Socket>();
let flushScheduled = false;

function flush(): void {
  flushScheduled = false;
  for (const raw of corked) raw.uncork();
  corked.clear();
}

/**
 * Sends a text frame, coalesced with the socket's other sends this turn.
 * ws's own cork/uncork pairs nest inside ours, and `close()`/`end()` flush
 * anything still corked, so nothing is held back past the turn.
 */
export function sendCorked(socket: WebSocket, text: string): void {
  const raw = (socket as unknown as { _socket?: Socket })._socket;
  if (raw !== undefined && !corked.has(raw)) {
    raw.cork();
    corked.add(raw);
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flush);
    }
  }
  socket.send(text);
}

const serialized = new WeakMap<object, string>();

/**
 * JSON for a message object, computed once however many sockets it goes to.
 * Market data, broadcasts and reports to a trader's several connections all
 * hand the same object to every subscriber, and stringifying it per
 * subscriber was 30% of the main thread with 100 market-data watchers.
 * Messages are never mutated after they are first sent.
 */
export function serialize(message: object): string {
  let text = serialized.get(message);
  if (text === undefined) {
    text = JSON.stringify(message);
    serialized.set(message, text);
  }
  return text;
}
