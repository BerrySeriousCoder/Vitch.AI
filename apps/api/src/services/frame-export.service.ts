import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { once } from "events";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { DeliveryProfile, ExportBitDepth, MediaMetadata } from "@tempo/types";

export interface FrameExportPayload {
  jobId: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  backgroundColor?: string;
  deliveryProfile?: DeliveryProfile;
  exportBitDepth?: ExportBitDepth;
  allowSoftwareWebGpu?: boolean;
  apiBaseUrl: string;
  tracks: unknown[];
  transitions: unknown[];
  sequences?: unknown[];
  cameras?: unknown[];
  lights?: unknown[];
  mediaAssets: Array<{
    id: string;
    type: string;
    url: string;
    name?: string;
    duration?: number | null;
    metadata?: MediaMetadata;
  }>;
  fonts: Array<{
    id: string;
    familyName: string;
    url: string;
    format: string;
  }>;
  luts: Array<{
    id: string;
    name: string;
    url: string;
    format: string;
  }>;
}

/** Linux WebGPU needs Vulkan enabled; disabling it forces headless Chrome onto SwiftShader. */
export function chromiumWebGpuArgs(): string[] {
  return [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--ignore-gpu-blocklist",
    "--use-angle=gl",
    "--enable-gpu",
  ];
}

export function permitsSoftwareWebGpuFallback(mode: "auto" | "hardware"): boolean {
  return mode === "auto";
}

async function openOfflineBrowser(
  playwright: typeof import("playwright"),
  executablePath: string
): Promise<{ browser: import("playwright").Browser; source: "shared-gpu" | "isolated" }> {
  if (env.CHROME_CDP_URL) {
    try {
      const browser = await playwright.chromium.connectOverCDP(env.CHROME_CDP_URL, { timeout: 3_000 });
      logger.info({ cdpUrl: env.CHROME_CDP_URL }, "Using headed GPU Chrome for offline rendering");
      return { browser, source: "shared-gpu" };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (!permitsSoftwareWebGpuFallback(env.OFFLINE_WEBGPU_MODE)) {
        throw new Error(
          `Hardware WebGPU browser is unavailable at ${env.CHROME_CDP_URL}. ` +
          "Tempo did not fall back to CPU/SwiftShader. Start the development browser with " +
          "`pnpm browser:gpu`, keep it open, and retry critique/export.",
          { cause: err }
        );
      }
      logger.warn(
        { cdpUrl: env.CHROME_CDP_URL, err },
        "Headed GPU Chrome unavailable; software fallback explicitly enabled"
      );
    }
  }
  const browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: chromiumWebGpuArgs(),
  });
  return { browser, source: "isolated" };
}

export interface FrameExportResult {
  framesDir: string;
  frameCount: number;
  frameFormat: "png" | "ffv1-rgba16";
  intermediateVideoPath?: string;
}

interface OfflineBackendInfo {
  vendor: string;
  architecture: string;
  device: string;
  isFallbackAdapter: boolean;
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m?.[1]) throw new Error("Invalid PNG data URL from export page");
  return Buffer.from(m[1], "base64");
}

function raw16DataUrlToBuffer(dataUrl: string): Buffer {
  const m = dataUrl.match(/^data:application\/x-tempo-rgba64le;base64,(.+)$/);
  if (!m?.[1]) throw new Error("Invalid RGBA64 data URL from export page");
  return Buffer.from(m[1], "base64");
}

async function writeWithBackpressure(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return;
  await once(stream, "drain");
}

function exportAssetUrl(apiBaseUrl: string, rawUrl: string): string {
  const base = apiBaseUrl.replace(/\/$/, "");
  try {
    const parsed = new URL(rawUrl);
    if (/^(?:your-public-api-domain\.com|api\.example\.com)$/i.test(parsed.hostname)) {
      return `${base}${parsed.pathname}${parsed.search}`;
    }
    return parsed.href;
  } catch {
    return rawUrl.startsWith("/") ? `${base}${rawUrl}` : `${base}/${rawUrl}`;
  }
}

async function assertExportAssetsAccessible(payload: FrameExportPayload): Promise<void> {
  const targets = [
    ...payload.mediaAssets
      .filter((asset) => asset.type !== "audio")
      .map((asset) => ({ label: asset.name || asset.id, url: asset.url })),
    ...payload.fonts.map((font) => ({ label: `font ${font.familyName}`, url: font.url })),
    ...payload.luts.map((lut) => ({ label: `LUT ${lut.name}`, url: lut.url })),
  ];
  const failures: string[] = [];
  await Promise.all(targets.map(async (target) => {
    const url = exportAssetUrl(payload.apiBaseUrl, target.url);
    try {
      let response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(url, {
          headers: { Range: "bytes=0-0" },
          signal: AbortSignal.timeout(8_000),
        });
      }
      if (!response.ok) failures.push(`${target.label} (${response.status}) at ${url}`);
    } catch (error) {
      failures.push(`${target.label} at ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  if (failures.length > 0) {
    throw new Error(
      `Export media preflight failed: ${failures.slice(0, 3).join("; ")}. ` +
      "Verify API_INTERNAL_URL and that every timeline asset still exists."
    );
  }
}

/**
 * Drive headless Chromium to render WebGPU frames for export parity.
 * Requires Playwright + a GPU/WebGPU-capable Chromium.
 */
export async function renderFramesWithChromium(options: {
  webBaseUrl: string;
  payload: FrameExportPayload;
  framesDir: string;
  onProgress?: (ratio: number) => void | Promise<void>;
}): Promise<FrameExportResult> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Playwright is required for frame export (glow/grain). Install with: pnpm --filter @tempo/api add -D playwright && pnpm exec playwright install chromium"
    );
  }

  await fs.mkdir(options.framesDir, { recursive: true });
  await assertExportAssetsAccessible(options.payload);

  const { checkChromiumHealth } = await import("../utils/chromium-health.js");
  const health = await checkChromiumHealth();
  if (!health.ok) {
    throw new Error(`${health.error}. ${health.fixHint}`);
  }

  const session = await openOfflineBrowser(playwright, health.executablePath);
  const { browser } = session;
  let context: import("playwright").BrowserContext | undefined;

  try {
    context = await browser.newContext({
      viewport: {
        width: Math.max(64, options.payload.width),
        height: Math.max(64, options.payload.height),
      },
    });
    const page = await context.newPage();

    const exportUrl = `${options.webBaseUrl.replace(/\/$/, "")}/export-frame`;
    await page.goto(exportUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.waitForFunction(() => {
      const g = globalThis as unknown as { __tempoExport?: { ready?: boolean } };
      return typeof g.__tempoExport?.ready === "boolean";
    }, undefined, { timeout: 30_000 });

    const initOk = await page.evaluate(async (payload) => {
      const g = globalThis as unknown as {
        __tempoExport?: {
          init: (p: typeof payload) => Promise<{ ok: boolean; error?: string; backendInfo?: OfflineBackendInfo }>;
        };
      };
      if (!g.__tempoExport) return { ok: false, error: "bridge missing" };
      return g.__tempoExport.init(payload);
    }, options.payload);

    if (!initOk?.ok) {
      throw new Error(initOk?.error || "Export page failed to initialize WebGPU compositor");
    }
    if (initOk.backendInfo?.isFallbackAdapter) {
      logger.warn({ backend: initOk.backendInfo, jobId: options.payload.jobId }, "Offline rendering is using software WebGPU");
    } else {
      logger.info({ backend: initOk.backendInfo, jobId: options.payload.jobId }, "Offline rendering acquired hardware WebGPU");
    }

    const fps = Math.max(1, options.payload.fps);
    const duration = Math.max(0.1, options.payload.duration);
    const frameCount = Math.max(1, Math.ceil(duration * fps));
    const useRaw16 = options.payload.exportBitDepth === 10;
    const intermediateVideoPath = useRaw16 ? path.join(options.framesDir, "frames-16bit.mkv") : undefined;
    const losslessEncoder = intermediateVideoPath
      ? spawn("ffmpeg", [
          "-y",
          "-hide_banner",
          "-loglevel", "error",
          "-f", "rawvideo",
          "-pixel_format", "rgba64le",
          "-video_size", `${options.payload.width}x${options.payload.height}`,
          "-framerate", String(fps),
          "-i", "pipe:0",
          "-an",
          "-c:v", "ffv1",
          "-level", "3",
          "-coder", "1",
          "-context", "1",
          "-g", "1",
          "-slicecrc", "1",
          "-pix_fmt", "rgba64le",
          intermediateVideoPath,
        ], { stdio: ["pipe", "ignore", "pipe"] })
      : undefined;
    let losslessError = "";
    losslessEncoder?.stderr.on("data", (chunk) => {
      losslessError = `${losslessError}${String(chunk)}`.slice(-16_000);
    });
    const losslessDone = losslessEncoder
      ? new Promise<void>((resolve, reject) => {
          losslessEncoder.once("error", reject);
          losslessEncoder.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Lossless 16-bit frame cache failed (${code}): ${losslessError.trim()}`));
          });
        })
      : undefined;
    let losslessFailure: Error | undefined;
    void losslessDone?.catch((error) => {
      losslessFailure = error instanceof Error ? error : new Error(String(error));
    });
    let losslessCompleted = false;

    try {
      for (let i = 0; i < frameCount; i++) {
        const t = Math.min(duration - 1 / fps, i / fps);
        const dataUrl = await page.evaluate(async ({ time, raw16 }) => {
          const g = globalThis as unknown as {
            __tempoExport?: {
              renderAt: (t: number) => Promise<string>;
              renderRaw16At: (t: number) => Promise<string>;
            };
          };
          if (!g.__tempoExport) throw new Error("bridge missing");
          return raw16
            ? g.__tempoExport.renderRaw16At(time)
            : g.__tempoExport.renderAt(time);
        }, { time: Math.max(0, t), raw16: useRaw16 });

        if (useRaw16) {
          if (losslessFailure) throw losslessFailure;
          await writeWithBackpressure(losslessEncoder!.stdin, raw16DataUrlToBuffer(dataUrl));
        } else {
          const name = `frame-${String(i + 1).padStart(6, "0")}.png`;
          await fs.writeFile(path.join(options.framesDir, name), dataUrlToBuffer(dataUrl));
        }

        if (i % 5 === 0 || i === frameCount - 1) {
          await options.onProgress?.(i / Math.max(1, frameCount - 1));
        }
      }
      if (losslessEncoder) {
        losslessEncoder.stdin.end();
        await losslessDone;
        losslessCompleted = true;
      }
    } finally {
      if (losslessEncoder && !losslessCompleted) {
        losslessEncoder.stdin.destroy();
        losslessEncoder.kill("SIGTERM");
        await losslessDone?.catch(() => undefined);
      }
    }

    await page.evaluate(async () => {
      const g = globalThis as unknown as {
        __tempoExport?: { dispose?: () => Promise<void> };
      };
      await g.__tempoExport?.dispose?.();
    });

    logger.info(
      { frames: frameCount, dir: options.framesDir },
      "Chromium frame export complete"
    );

    return {
      framesDir: options.framesDir,
      frameCount,
      frameFormat: useRaw16 ? "ffv1-rgba16" : "png",
      ...(intermediateVideoPath ? { intermediateVideoPath } : {}),
    };
  } finally {
    // Export owns only this isolated context. Browser.close() disconnects a
    // connectOverCDP client; it does not terminate the externally launched
    // Chrome process. A locally launched fallback is terminated as expected.
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/**
 * Capture only specific timeline times (for vision critic), not a full fps sequence.
 */
export async function renderFramesAtTimesWithChromium(options: {
  webBaseUrl: string;
  payload: FrameExportPayload;
  framesDir: string;
  times: number[];
  onProgress?: (ratio: number) => void | Promise<void>;
}): Promise<{ frames: Array<{ time: number; path: string }> }> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Playwright is required for critique_preview. Install with: pnpm --filter @tempo/api add -D playwright && pnpm exec playwright install chromium"
    );
  }

  await fs.mkdir(options.framesDir, { recursive: true });
  await assertExportAssetsAccessible(options.payload);

  const { checkChromiumHealth } = await import("../utils/chromium-health.js");
  const health = await checkChromiumHealth();
  if (!health.ok) {
    throw new Error(`${health.error}. ${health.fixHint}`);
  }

  const session = await openOfflineBrowser(playwright, health.executablePath);
  const { browser } = session;
  let context: import("playwright").BrowserContext | undefined;

  try {
    context = await browser.newContext({
      viewport: {
        width: Math.max(64, options.payload.width),
        height: Math.max(64, options.payload.height),
      },
    });
    const page = await context.newPage();

    const exportUrl = `${options.webBaseUrl.replace(/\/$/, "")}/export-frame`;
    await page.goto(exportUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.waitForFunction(() => {
      const g = globalThis as unknown as { __tempoExport?: { ready?: boolean } };
      return typeof g.__tempoExport?.ready === "boolean";
    }, undefined, { timeout: 30_000 });

    const initOk = await page.evaluate(async (payload) => {
      const g = globalThis as unknown as {
        __tempoExport?: {
          init: (p: typeof payload) => Promise<{ ok: boolean; error?: string; backendInfo?: OfflineBackendInfo }>;
        };
      };
      if (!g.__tempoExport) return { ok: false, error: "bridge missing" };
      return g.__tempoExport.init(payload);
    }, options.payload);

    if (!initOk?.ok) {
      throw new Error(initOk?.error || "Export page failed to initialize WebGPU compositor");
    }
    if (initOk.backendInfo?.isFallbackAdapter) {
      logger.warn(
        { backend: initOk.backendInfo, jobId: options.payload.jobId, frames: options.times.length },
        "Critique capture is using software WebGPU"
      );
    } else {
      logger.info(
        { backend: initOk.backendInfo, jobId: options.payload.jobId, frames: options.times.length },
        "Critique capture acquired hardware WebGPU"
      );
    }

    const frames: Array<{ time: number; path: string }> = [];
    for (let i = 0; i < options.times.length; i++) {
      const t = Math.max(0, options.times[i]!);
      const dataUrl = await page.evaluate(async (time) => {
        const g = globalThis as unknown as {
          __tempoExport?: { renderAt: (t: number) => Promise<string> };
        };
        if (!g.__tempoExport) throw new Error("bridge missing");
        return g.__tempoExport.renderAt(time);
      }, t);
      const buf = dataUrlToBuffer(dataUrl);
      const name = `critique-${String(i + 1).padStart(3, "0")}.png`;
      const filePath = path.join(options.framesDir, name);
      await fs.writeFile(filePath, buf);
      frames.push({ time: t, path: filePath });
      await options.onProgress?.((i + 1) / Math.max(1, options.times.length));
    }

    await page.evaluate(async () => {
      const g = globalThis as unknown as {
        __tempoExport?: { dispose?: () => Promise<void> };
      };
      await g.__tempoExport?.dispose?.();
    });

    return { frames };
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
