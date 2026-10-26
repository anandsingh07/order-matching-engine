import { defineConfig } from "vitest/config";

// Several of these tests run live markets of bots on timers (surveillance,
// derivatives). Running the files side by side starves those timers, and
// starved bots trade differently: slower cancels and stale quotes make honest
// traders look unusual to surveillance. One file at a time keeps the markets
// close to how they behave in production.
export default defineConfig({
  test: { fileParallelism: false },
});
