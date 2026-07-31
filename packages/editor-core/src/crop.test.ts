import { describe, expect, it } from "vitest";
import { applyKenBurns, normalizeCrop, resolveCropAtTime, validateCrop } from "./crop";

describe("crop", () => {
  it("normalizes bounds inside the source", () => {
    expect(normalizeCrop({ x: 0.8, y: 0.9, width: 0.8, height: 0.8 })).toEqual({
      x: 0.8,
      y: 0.9,
      width: 0.19999999999999996,
      height: 0.09999999999999998,
    });
    expect(validateCrop({ x: 0, y: 0, width: 0, height: 1 }).ok).toBe(false);
    expect(validateCrop({ x: 0.6, y: 0, width: 0.5, height: 1 }).ok).toBe(false);
  });

  it("creates crop-only Ken Burns keyframes and preserves unrelated animation", () => {
    let n = 0;
    const result = applyKenBurns({
      presetId: "zoom-in",
      duration: 4,
      keyframes: [{ id: "opacity", property: "opacity", time: 0, value: 1, easing: "linear" }],
      createKeyframeId: () => `crop-${++n}`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keyframes).toHaveLength(9);
    expect(result.keyframes.some((keyframe) => keyframe.property === "opacity")).toBe(true);
    expect(resolveCropAtTime(result.crop, result.keyframes, 0)).toEqual(result.from);
    expect(resolveCropAtTime(result.crop, result.keyframes, 4)).toEqual(result.to);
  });

  it("ignores non-numeric crop keyframes instead of coercing them", () => {
    const crop = resolveCropAtTime(
      { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
      [
        { id: "bad-x", property: "crop.x", time: 0, value: "0.9", easing: "linear" },
        { id: "bad-width", property: "crop.width", time: 0, value: true, easing: "linear" },
      ],
      0
    );

    expect(crop).toEqual({ x: 0.1, y: 0.2, width: 0.6, height: 0.5 });
  });
});
