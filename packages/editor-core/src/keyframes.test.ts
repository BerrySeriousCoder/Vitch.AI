import { describe, expect, it } from "vitest";
import type { Effect, Keyframe } from "@tempo/types";
import {
  interpolateValue,
  resolveEffectParamsAtTime,
  resolveKeyframeValues,
} from "./keyframes";

function kf(
  property: string,
  time: number,
  value: number,
  easing: Keyframe["easing"] = "linear"
): Keyframe {
  return { id: `${property}-${time}`, property, time, value, easing };
}

describe("keyframes core", () => {
  it("interpolates linearly", () => {
    const keys = [kf("opacity", 0, 0), kf("opacity", 1, 1)];
    expect(interpolateValue(keys, 0.5, "opacity")).toBeCloseTo(0.5);
  });

  it("uses cubic-bezier handles from the incoming keyframe", () => {
    const keys: Keyframe[] = [
      kf("transform.x", 0, 0),
      {
        ...kf("transform.x", 1, 100, "cubic-bezier"),
        bezierHandles: [0.42, 0, 1, 1],
      },
    ];
    expect(interpolateValue(keys, 0.5, "transform.x")).toBeLessThan(50);
  });

  it("holds the previous value until an incoming step keyframe", () => {
    const keys = [kf("transform.scaleX", 0, 1), kf("transform.scaleX", 1, 1.5, "hold")];
    expect(interpolateValue(keys, 0.25, "transform.scaleX")).toBe(1);
    expect(interpolateValue(keys, 0.999, "transform.scaleX")).toBe(1);
    expect(interpolateValue(keys, 1, "transform.scaleX")).toBe(1.5);
  });

  it("resolveKeyframeValues returns all properties", () => {
    const keys = [kf("opacity", 0, 1), kf("transform.x", 0, 10), kf("transform.x", 1, 20)];
    const r = resolveKeyframeValues(keys, 0.5);
    expect(r.opacity).toBe(1);
    expect(r["transform.x"]).toBeCloseTo(15);
  });

  it("resolveEffectParamsAtTime merges keyframeable params", () => {
    const effect: Effect = {
      id: "e1",
      type: "blur",
      name: "Blur",
      enabled: true,
      params: { amount: 0 },
      keyframes: [kf("amount", 0, 0), kf("amount", 1, 10)],
    };
    const at0 = resolveEffectParamsAtTime(effect, 0);
    const atMid = resolveEffectParamsAtTime(effect, 0.5);
    expect(at0.amount).toBe(0);
    expect(atMid.amount).toBeCloseTo(5);
  });
});
