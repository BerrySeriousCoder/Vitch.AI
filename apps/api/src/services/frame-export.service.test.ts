import { describe, expect, it } from "vitest";
import {
  chromiumWebGpuArgs,
  permitsSoftwareWebGpuFallback,
} from "./frame-export.service.js";

describe("offline Chromium WebGPU launch policy", () => {
  it("enables Vulkan and never forces the SwiftShader-producing disabled backend", () => {
    const args = chromiumWebGpuArgs();
    expect(args).toContain("--enable-features=Vulkan");
    expect(args).not.toContain("--disable-features=Vulkan");
    expect(args).toContain("--enable-gpu");
  });

  it("never silently enters the software renderer in hardware mode", () => {
    expect(permitsSoftwareWebGpuFallback("hardware")).toBe(false);
    expect(permitsSoftwareWebGpuFallback("auto")).toBe(true);
  });
});
