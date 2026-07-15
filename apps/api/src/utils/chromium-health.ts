/**
 * Playwright Chromium health for critique + frame export.
 * Call before launch so agents get a structured fixHint instead of a raw stack.
 */

import { env } from "../config/env.js";

export type ChromiumHealth =
  | { ok: true; executablePath: string }
  | {
      ok: false;
      code: "PLAYWRIGHT_MISSING" | "CHROMIUM_MISSING";
      error: string;
      fixHint: string;
    };

export async function checkChromiumHealth(): Promise<ChromiumHealth> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    return {
      ok: false,
      code: "PLAYWRIGHT_MISSING",
      error: "Playwright package is not installed",
      fixHint:
        "From apps/api run: pnpm add playwright && pnpm exec playwright install chromium",
    };
  }

  try {
    const fs = await import("fs");
    const configuredPath = env.CHROME_EXECUTABLE_PATH;
    const systemCandidates = [
      configuredPath,
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter((candidate): candidate is string => Boolean(candidate));
    const systemPath = systemCandidates.find((candidate) => fs.existsSync(candidate));
    const executablePath = systemPath || playwright.chromium.executablePath();
    if (!fs.existsSync(executablePath)) {
      return {
        ok: false,
        code: "CHROMIUM_MISSING",
        error: `Chromium executable missing at ${executablePath}`,
        fixHint:
          "From apps/api run: pnpm exec playwright install chromium (must match the playwright package version)",
      };
    }
    return { ok: true, executablePath };
  } catch (err: any) {
    return {
      ok: false,
      code: "CHROMIUM_MISSING",
      error: err?.message || "Failed to resolve Chromium executable",
      fixHint:
        "From apps/api run: pnpm exec playwright install chromium",
    };
  }
}
