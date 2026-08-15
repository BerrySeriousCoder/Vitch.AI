/**
 * Optional Playwright E2E smoke test.
 *
 * Run (when Playwright is installed):
 *   pnpm exec playwright test apps/web/e2e/smoke.spec.ts
 *
 * Prerequisites: web on :3000, api on :3001, DB up.
 */
import { test, expect } from "@playwright/test";

const email = `e2e-${Date.now()}@tempo.dev`;
const password = "Password1";

test.describe("Tempo smoke", () => {
  test("register → create project → open editor → save", async ({ page }) => {
    await page.goto("http://localhost:3000/register");
    await page.getByLabel(/name/i).fill("E2E User");
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: /create|sign up|register/i }).click();

    await page.waitForURL(/dashboard|editor/);

    // Create project if on dashboard
    if (page.url().includes("dashboard")) {
      const createBtn = page.getByRole("button", { name: /new project|create/i });
      if (await createBtn.isVisible()) {
        await createBtn.click();
      }
      await page.waitForURL(/editor\//, { timeout: 15000 });
    }

    await expect(page.getByText(/export|timeline|inspector/i).first()).toBeVisible({
      timeout: 15000,
    });

    const saveBtn = page.getByRole("button", { name: /^save$/i });
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
    }
  });
});
