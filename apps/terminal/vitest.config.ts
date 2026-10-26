import { defineConfig } from "vitest/config";

// Unit tests for the terminal's pure logic (src/lib). Components are covered
// end to end by the browser test.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
