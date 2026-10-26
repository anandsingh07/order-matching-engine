/**
 * Token bucket: allows bursts up to `burst` requests, refilled continuously at
 * `perSecond`. One bucket per connection stops a single client from flooding
 * the engine.
 */
export class TokenBucket {
  private tokens: number;
  private updated: number;

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.updated = now();
  }

  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.updated) / 1000) * this.perSecond);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
