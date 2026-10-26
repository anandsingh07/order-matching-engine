import { defineConfig, devices } from "@playwright/test";

// End-to-end tests: a real gateway and the real terminal in a real browser.
// Ports differ from the defaults so a running dev setup is left alone.
const GATEWAY_PORT = 18_090;
const WEB_PORT = 3_100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // The tests share one exchange; running them one at a time keeps books predictable.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "pnpm --filter @ome/gateway start",
      url: `http://127.0.0.1:${GATEWAY_PORT}/api/health`,
      // No opening auction, so tests can trade at once; short circuit-breaker halts.
      // Plain-English orders point at a closed port, never a real Ollama on this machine: the
      // rules answer, and the model is always "not running", so runs are the same here and in CI.
      env: {
        PORT: String(GATEWAY_PORT),
        CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
        OPENING_AUCTION_MS: "0",
        HALT_MS: "4000",
        OLLAMA_URL: "http://127.0.0.1:9",
      },
      timeout: 60_000,
    },
    {
      command: `pnpm exec next dev --port ${WEB_PORT} --hostname 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { NEXT_PUBLIC_GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}` },
      timeout: 120_000,
    },
  ],
});
