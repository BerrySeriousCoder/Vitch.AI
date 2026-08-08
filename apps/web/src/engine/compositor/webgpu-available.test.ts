import { describe, expect, it } from "vitest";
import { isSoftwareWebGPUAdapter } from "./webgpu-available";

describe("isSoftwareWebGPUAdapter", () => {
  it("rejects an explicitly marked fallback adapter", () => {
    expect(isSoftwareWebGPUAdapter({
      vendor: "google",
      architecture: "swiftshader",
      isFallbackAdapter: true,
    })).toBe(true);
  });

  it("defensively recognizes SwiftShader even if fallback metadata is wrong", () => {
    expect(isSoftwareWebGPUAdapter({
      vendor: "Google",
      architecture: "SwiftShader Device",
      isFallbackAdapter: false,
    })).toBe(true);
  });

  it("accepts real Intel and NVIDIA adapters", () => {
    expect(isSoftwareWebGPUAdapter({ vendor: "intel", architecture: "gen-12lp", isFallbackAdapter: false })).toBe(false);
    expect(isSoftwareWebGPUAdapter({ vendor: "nvidia", architecture: "turing", isFallbackAdapter: false })).toBe(false);
  });
});
