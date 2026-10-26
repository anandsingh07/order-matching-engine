/** Seedable PRNG (mulberry32), so bot behaviour can be reproduced. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box-Muller). */
export function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Exponentially distributed wait with the given mean: gaps between Poisson arrivals. */
export function exponential(random: () => number, mean: number): number {
  return -Math.log(Math.max(random(), 1e-12)) * mean;
}

/**
 * Geometric Brownian motion: the textbook model of a stock price, where each
 * step multiplies the price by exp(sigma * sqrt(dt) * Z) for a standard normal Z.
 */
export class RandomWalk {
  private value: number;

  constructor(
    start: number,
    /** Volatility per second, e.g. 0.0005 = 0.05%. */
    private readonly sigmaPerSecond: number,
    private readonly random: () => number,
    private readonly floor = 1,
  ) {
    this.value = start;
  }

  get current(): number {
    return this.value;
  }

  step(seconds: number): number {
    this.value = Math.max(this.floor, this.value * Math.exp(this.sigmaPerSecond * Math.sqrt(seconds) * gaussian(this.random)));
    return this.value;
  }
}
