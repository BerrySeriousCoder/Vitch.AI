import { defineConfig } from "@playwright/test";

/**
 * Optional E2E config. Install with:
 *   pnpm add -Dw @playwright/test && pnpm exec playwright install chromium
 */
export default defineConfig({
  testDir: "apps/web/e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
  },
});
