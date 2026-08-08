import type { TempoCompositor, CompositorInitResult } from "./types";
import { isWebGPUAvailable } from "./webgpu-available";
import { WebGPUCompositor } from "./webgpu/compositor";

export type { TempoCompositor, CompositorInitResult };
export { isWebGPUAvailable };
export { WebGPUCompositor };

/**
 * Create the Tempo preview compositor. WebGPU is required — no Canvas2D fallback.
 */
export async function createCompositor(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  renderWidth = width,
  renderHeight = height,
  options: { allowSoftwareFallback?: boolean; workingPrecision?: "unorm8" | "float16" } = {}
): Promise<CompositorInitResult> {
  if (!isWebGPUAvailable()) {
    return {
      ok: false,
      reason:
        "WebGPU is required for Tempo preview. Use Chrome 113+ (Windows/Mac) or Chrome 144+ (Linux).",
    };
  }
  try {
    const compositor = await WebGPUCompositor.create(
      canvas,
      width,
      height,
      renderWidth,
      renderHeight,
      options
    );
    return { ok: true, compositor };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isLinux = navigator.userAgent.includes("Linux");
    const hint = isLinux
      ? "\n\nLinux fix:\n" +
        "1. Recommended: start Tempo with pnpm browser:gpu\n" +
        "2. For normal Chrome launches, enable chrome://flags/#enable-unsafe-webgpu\n" +
        "3. Enable chrome://flags/#enable-vulkan and relaunch every Chrome window\n" +
        "4. Keep Chrome Settings → System → graphics acceleration enabled\n" +
        "5. Verify the preview badge names Intel/NVIDIA/AMD (not SwiftShader)"
      : "";
    return {
      ok: false,
      reason: `WebGPU adapter unavailable: ${message}${hint}`,
    };
  }
}
