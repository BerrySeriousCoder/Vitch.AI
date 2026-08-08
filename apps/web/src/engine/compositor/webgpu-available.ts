export function isWebGPUAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/**
 * Try multiple adapter acquisition strategies in priority order:
 *
 * 1. High-performance preference (important on dual-GPU laptops)
 * 2. Default (Vulkan on Linux, Metal on macOS, D3D12 on Windows)
 * 3. Low-power preference
 * 4. Compatibility feature level (Chrome 146+, restricted WebGPU subset;
 *    the browser remains responsible for choosing the graphics backend)
 *
 * Software adapters such as SwiftShader are deliberately rejected. A video
 * editor that silently accepts them appears functional but becomes unusably
 * slow and hides the actual driver/backend problem.
 *
 * The compatibility feature level broadens hardware reach while preserving
 * the same WebGPU API. It cannot override Chromium's process-level backend
 * selection when the browser itself exposes no usable adapter.
 */
export function isSoftwareWebGPUAdapter(info: Pick<GPUAdapterInfo, "vendor" | "architecture" | "isFallbackAdapter">): boolean {
  const vendor = String(info.vendor || "").toLowerCase();
  const architecture = String(info.architecture || "").toLowerCase();
  return info.isFallbackAdapter === true || (vendor === "google" && architecture.includes("swiftshader"));
}

async function acquireAdapter(options: { allowSoftwareFallback?: boolean } = {}): Promise<GPUAdapter | null> {
  const strategies: GPURequestAdapterOptions[] = [
    { powerPreference: "high-performance" },
    {},
    { powerPreference: "low-power" },
    { featureLevel: "compatibility" } as GPURequestAdapterOptions,
    { featureLevel: "compatibility", powerPreference: "low-power" } as GPURequestAdapterOptions,
  ];
  for (const opts of strategies) {
    try {
      const adapter = await navigator.gpu.requestAdapter(opts);
      if (adapter) {
        const info = adapter.info;
        if (isSoftwareWebGPUAdapter(info) && !options.allowSoftwareFallback) {
          console.warn(
            `[WebGPU] Rejected software adapter: ${info?.device || "unknown"}`,
            `(vendor: ${info?.vendor || "?"}, arch: ${info?.architecture || "?"})`
          );
          continue;
        }
        if (isSoftwareWebGPUAdapter(info)) {
          console.warn(
            `[WebGPU] Using software adapter for offline rendering: ${info?.device || "unknown"}`,
            `(vendor: ${info?.vendor || "?"}, arch: ${info?.architecture || "?"})`
          );
        }
        console.info(
          `[WebGPU] Adapter acquired: ${info?.device || "unknown"}`,
          `(vendor: ${info?.vendor || "?"}, arch: ${info?.architecture || "?"})`,
          opts.featureLevel === "compatibility" ? "[compatibility mode]" : "[core]"
        );
        return adapter;
      }
    } catch {
      // Strategy not supported by this browser, try next
    }
  }
  return null;
}

export async function requestWebGPUDevice(options: { allowSoftwareFallback?: boolean } = {}): Promise<{
  adapter: GPUAdapter;
  device: GPUDevice;
} | null> {
  if (!isWebGPUAvailable()) return null;
  try {
    const adapter = await acquireAdapter(options);
    if (!adapter) {
      console.error(
        "[WebGPU] All adapter strategies failed. Possible causes:\n" +
        "  • Linux Chrome opened normally without the experimental WebGPU/Vulkan flags\n" +
        "  • Start Tempo with: pnpm browser:gpu\n" +
        "  • Or enable chrome://flags/#enable-unsafe-webgpu and #enable-vulkan\n" +
        "  • GPU drivers missing Vulkan support (run: vulkaninfo --summary)\n" +
        "  • Hardware acceleration disabled in browser settings\n" +
        "  • GPU blocklisted — try chrome://flags/#ignore-gpu-blocklist\n" +
        "  • Linux: ensure mesa-vulkan-drivers or intel-vulkan-icd is installed\n" +
        "  • SwiftShader was rejected because software WebGPU is not realtime-capable"
      );
      return null;
    }
    const requiredFeatures: GPUFeatureName[] = [];
    if (adapter.features.has("float16-filterable" as GPUFeatureName)) {
      requiredFeatures.push("float16-filterable" as GPUFeatureName);
    }
    if (adapter.features.has("float32-filterable" as GPUFeatureName)) {
      requiredFeatures.push("float32-filterable" as GPUFeatureName);
    }
    if (adapter.features.has("float32-blendable" as GPUFeatureName)) {
      requiredFeatures.push("float32-blendable" as GPUFeatureName);
    }
    const device = await adapter.requestDevice({ requiredFeatures });
    return { adapter, device };
  } catch (err) {
    console.error("[WebGPU] requestDevice failed:", err);
    return null;
  }
}
