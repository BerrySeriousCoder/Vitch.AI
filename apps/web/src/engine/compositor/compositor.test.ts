import { describe, expect, it } from "vitest";
import {
  listEffectDefinitions,
  getEffectSchema,
  listTransitionTypes,
  getTransitionType,
} from "@tempo/editor-core";
import { isWebGPUAvailable } from "./webgpu-available";

describe("effect registry (editor-core)", () => {
  it("lists parity WebGPU effects", () => {
    const types = listEffectDefinitions().map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "brightness",
        "color-grade",
        "color-curves",
        "contrast",
        "saturate",
        "hue-rotate",
        "blur",
        "grayscale",
        "sepia",
        "invert",
      ])
    );
    for (const def of listEffectDefinitions()) {
      expect(def.previewBackend).toBe("webgpu");
      expect(def.shaderId).toBeTruthy();
    }
  });

  it("returns schema by type", () => {
    const blur = getEffectSchema("blur");
    expect(blur?.params.value?.max).toBe(24);
  });
});

describe("transition registry stubs", () => {
  it("exposes crossfade and dip-black without apply logic", () => {
    expect(listTransitionTypes().length).toBeGreaterThanOrEqual(2);
    expect(getTransitionType("crossfade")?.previewBackend).toBe("webgpu");
  });
});

describe("WebGPU gate", () => {
  it("reports availability without throwing", () => {
    expect(typeof isWebGPUAvailable()).toBe("boolean");
  });
});
