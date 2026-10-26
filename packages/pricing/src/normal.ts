const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Standard normal density. */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * Standard normal cumulative distribution with an absolute error within about 2e-16
 * across the whole real line: Hart's (1968) rational approximation in the form
 * given by West, "Better approximations to cumulative normal functions" (2005).
 * (Relative accuracy in the far tail is about 1e-8, which only matters for
 * prices far below a tick.)
 *
 * The cheaper Abramowitz-Stegun formula is only good to about 1e-7, which is
 * visible in an implied-volatility round trip. The tail is computed on |x|
 * and reflected, so N(x) + N(-x) = 1 and put-call parity holds to rounding.
 */
export function normalCdf(x: number): number {
  const a = Math.abs(x);
  let tail: number;
  if (a > 37) {
    tail = 0;
  } else {
    const e = Math.exp(-0.5 * a * a);
    if (a < 7.07106781186547) {
      let n = 3.52624965998911e-2 * a + 0.700383064443688;
      n = n * a + 6.37396220353165;
      n = n * a + 33.912866078383;
      n = n * a + 112.079291497871;
      n = n * a + 221.213596169931;
      n = n * a + 220.206867912376;
      let d = 8.83883476483184e-2 * a + 1.75566716318264;
      d = d * a + 16.064177579207;
      d = d * a + 86.7807322029461;
      d = d * a + 296.564248779674;
      d = d * a + 637.333633378831;
      d = d * a + 793.826512519948;
      d = d * a + 440.413735824752;
      tail = (e * n) / d;
    } else {
      // Continued fraction for the far tail.
      let d = a + 0.65;
      d = a + 4 / d;
      d = a + 3 / d;
      d = a + 2 / d;
      d = a + 1 / d;
      tail = e / d / SQRT_2PI;
    }
  }
  return x > 0 ? 1 - tail : tail;
}
