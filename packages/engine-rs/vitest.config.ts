import { defineConfig } from "vitest/config";

// test/core-suite.test.ts runs @ome/core's own property tests against the
// Rust engine, with the timeouts they have there: vitest's default 5 s, and
// 15 s for the reference differential. Run in parallel with the parity
// streams on a busy machine, they came within milliseconds of those limits
// and sometimes past them, with no mismatch. So the files run one at a time,
// and a test without its own timeout gets 30 s. No assertion changes, only
// how long a passing test may take.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
