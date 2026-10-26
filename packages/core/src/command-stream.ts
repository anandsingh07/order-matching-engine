import type { EngineCommand, Side } from "./types.js";

/** Small, fast, seedable PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An endless, seeded stream of synthetic order flow around a randomly
 * walking mid price, using every command type: passive and aggressive
 * limits, icebergs, market orders, stops, cancels, amends, and a short call
 * auction every 2,000 commands.
 *
 * The same seed always yields the same commands, so a stream can be
 * regenerated anywhere (in a crash-test child process, a simulator, a test)
 * and compared command for command.
 */
export class CommandStream {
  private readonly random: () => number;
  private readonly recent: string[] = [];
  private mid = 10_000;
  private count = 0;

  constructor(seed: number) {
    this.random = prng(seed);
  }

  next(): EngineCommand {
    const n = ++this.count;
    // A short call auction every 2,000 commands, like a market reopening.
    if (n % 2_000 === 1_000) return { type: "start_auction" };
    if (n % 2_000 === 1_150) return { type: "uncross" };
    if (n % 50 === 0) this.mid = Math.max(100, this.mid + this.int(-2, 2));
    const r = this.random();

    if (r < 0.12 && this.recent.length > 0) return { type: "cancel", orderId: this.pickRecent() };
    if (r < 0.17 && this.recent.length > 0) {
      return { type: "amend", orderId: this.pickRecent(), changes: { quantity: this.int(1, 100) } };
    }

    const id = `c${n}`;
    const side: Side = this.random() < 0.5 ? "buy" : "sell";
    const away = side === "buy" ? -1 : 1;
    const traderId = `t${this.int(1, 50)}`;
    const quantity = this.int(1, 100);

    if (r < 0.62) {
      this.remember(id);
      const price = this.mid + away * this.int(1, 20);
      const order = { type: "limit" as const, id, traderId, side, price, quantity };
      return { type: "submit", order: this.random() < 0.1 ? { ...order, displayQuantity: this.int(5, 20) } : order };
    }
    if (r < 0.82) {
      const price = this.mid - away * this.int(0, 5);
      return { type: "submit", order: { type: "limit", id, traderId, side, price, quantity, selfTrade: "cancel_taker" } };
    }
    if (r < 0.9) return { type: "submit", order: { type: "market", id, traderId, side, quantity } };

    this.remember(id);
    // Stops sit beyond the market: above it for buys, below it for sells.
    const stopPrice = this.mid - away * this.int(5, 30);
    return { type: "submit", order: { type: "stop", id, traderId, side, stopPrice, quantity } };
  }

  private int(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  private remember(id: string): void {
    this.recent.push(id);
    if (this.recent.length > 500) this.recent.shift();
  }

  private pickRecent(): string {
    return this.recent[this.int(0, this.recent.length - 1)]!;
  }
}
