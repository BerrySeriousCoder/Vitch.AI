import { describe, it, expect } from "vitest";
import { interpolateValue, resolveKeyframeValues } from "./interpolation";
import type { Keyframe } from "@tempo/types";

function kf(
  property: string,
  time: number,
  value: number | string | boolean,
  easing: Keyframe["easing"] = "linear"
): Keyframe {
  return {
    id: `${property}-${time}`,
    property,
    time,
    value,
    easing,
  };
}

describe("interpolateValue", () => {
  it("returns undefined when no keyframes for property", () => {
    expect(interpolateValue([kf("opacity", 0, 0)], 0.5, "transform.x")).toBeUndefined();
  });

  it("returns first value before first keyframe", () => {
    const frames = [kf("opacity", 1, 0), kf("opacity", 2, 1)];
    expect(interpolateValue(frames, 0, "opacity")).toBe(0);
  });

  it("returns last value after last keyframe", () => {
    const frames = [kf("opacity", 0, 0), kf("opacity", 1, 1)];
    expect(interpolateValue(frames, 2, "opacity")).toBe(1);
  });

  it("linearly interpolates numeric values", () => {
    const frames = [kf("opacity", 0, 0), kf("opacity", 1, 1)];
    expect(interpolateValue(frames, 0.5, "opacity")).toBeCloseTo(0.5, 5);
  });

  it("holds string/boolean values without interpolating", () => {
    const frames = [kf("blendMode", 0, "normal"), kf("blendMode", 1, "multiply")];
    expect(interpolateValue(frames, 0.5, "blendMode")).toBe("normal");
  });

  it("uses ease-out easing from next keyframe", () => {
    const frames = [
      kf("transform.x", 0, 0, "linear"),
      kf("transform.x", 1, 100, "ease-out"),
    ];
    const mid = interpolateValue(frames, 0.5, "transform.x") as number;
    expect(mid).toBeGreaterThan(50);
  });
});

describe("resolveKeyframeValues", () => {
  it("resolves multiple properties at once", () => {
    const frames = [
      kf("opacity", 0, 0),
      kf("opacity", 1, 1),
      kf("transform.x", 0, 10),
      kf("transform.x", 1, 20),
    ];
    const resolved = resolveKeyframeValues(frames, 0.5);
    expect(resolved.opacity).toBeCloseTo(0.5, 5);
    expect(resolved["transform.x"]).toBeCloseTo(15, 5);
  });
});
