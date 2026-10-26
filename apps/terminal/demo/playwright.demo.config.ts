import { defineConfig } from "@playwright/test";

// Records the narrated product demo (docs/demo.mp4 and docs/demo.webm): `pnpm --filter @ome/terminal demo`
// (KOKORO_MODELS=<dir> on the first run; see demo/narration.py).
// Separate from the e2e suite (playwright.config.ts, ./e2e) and on its own ports (gateway 18290,
// web 3200), so neither a dev setup nor the e2e tests are disturbed. The spec starts and stops the
// gateway, bots and actors itself; Playwright runs the Next dev server.
// DEMO_SMOKE=1: about 9 minutes, no 15-minute wait for the volatility forecast, output in test-results only.
export const GATEWAY_PORT = 18_290;
export const WEB_PORT = 3_200;

export default defineConfig({
  testDir: ".",
  testMatch: "demo.spec.ts",
  timeout: 50 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../test-results/demo/playwright",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    video: "off",
    trace: "off",
    screenshot: "off",
    headless: true,
    actionTimeout: 20_000,
  },
  webServer: {
    command: `pnpm exec next dev --port ${WEB_PORT} --hostname 127.0.0.1`,
    cwd: "..",
    url: `http://127.0.0.1:${WEB_PORT}`,
    env: { NEXT_PUBLIC_GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}` },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
