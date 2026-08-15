import { describe, expect, it } from "vitest";
import { buildEffectFilterChain, type RenderInputFile } from "./ffmpeg.js";

function baseFile(
  effects: RenderInputFile["effects"],
  lutCubePath?: string
): RenderInputFile {
  return {
    path: "/tmp/clip.mp4",
    startTime: 0,
    duration: 2,
    mediaType: "video",
    effects,
    lutCubePath,
  };
}

describe("buildEffectFilterChain", () => {
  it("maps vignette with softness into vignette=", () => {
    const parts = buildEffectFilterChain(
      baseFile([
        {
          type: "vignette",
          enabled: true,
          params: { amount: 0.5, softness: 0.8 },
        },
      ])
    );
    expect(parts.some((p) => p.startsWith("vignette="))).toBe(true);
  });

  it("maps grain to noise and skips glow", () => {
    const parts = buildEffectFilterChain(
      baseFile([
        { type: "glow", enabled: true, params: { intensity: 1, radius: 8 } },
        { type: "grain", enabled: true, params: { amount: 0.4, size: 2 } },
      ])
    );
    expect(parts.some((p) => p.includes("gblur") || p.includes("unsharp"))).toBe(
      false
    );
    expect(parts.some((p) => p.startsWith("noise="))).toBe(true);
  });

  it("applies lut3d when cube path present", () => {
    const parts = buildEffectFilterChain(
      baseFile(
        [{ type: "lut", enabled: true, params: { lutId: "builtin:cinematic", intensity: 1 } }],
        "/tmp/look.cube"
      )
    );
    expect(parts.some((p) => p.includes("lut3d="))).toBe(true);
  });

  it("orders color before vignette/grain", () => {
    const parts = buildEffectFilterChain(
      baseFile([
        { type: "brightness", enabled: true, params: { value: 1.2 } },
        { type: "vignette", enabled: true, params: { amount: 0.3, softness: 0.5 } },
        { type: "grain", enabled: true, params: { amount: 0.2, size: 1 } },
      ])
    );
    const eqIdx = parts.findIndex((p) => p.startsWith("eq="));
    const vigIdx = parts.findIndex((p) => p.startsWith("vignette="));
    const noiseIdx = parts.findIndex((p) => p.startsWith("noise="));
    expect(eqIdx).toBeGreaterThanOrEqual(0);
    expect(vigIdx).toBeGreaterThan(eqIdx);
    expect(noiseIdx).toBeGreaterThan(vigIdx);
  });
});
