import { describe, expect, it } from "vitest";
import {
  getTransitionMix,
  getTransitionClipOpacity,
  normalizeTransitionDirection,
  normalizeTransitionSoftness,
} from "./transition-mix";
import { getTransitionType, listTransitionTypes } from "./transition-registry";

describe("transition registry geometric types", () => {
  it("registers wipe/push/whip/iris as geometric frame-backed", () => {
    for (const id of ["wipe", "push", "whip", "iris"] as const) {
      const t = getTransitionType(id);
      expect(t?.mixFamily).toBe("geometric");
      expect(t?.exportBackend).toBe("frame");
    }
    expect(getTransitionType("whip")?.params.blur).toBeTruthy();
    expect(getTransitionType("iris")?.params.centerX).toBeTruthy();
    expect(listTransitionTypes().map((t) => t.type)).toEqual(
      expect.arrayContaining([
        "crossfade",
        "dip-black",
        "wipe",
        "push",
        "whip",
        "iris",
      ])
    );
  });
});

describe("getTransitionMix", () => {
  it("crossfade is opacity dissolve", () => {
    const mid = getTransitionMix("crossfade", 0.5);
    expect(mid).toEqual({ mode: "opacity", opacityA: 0.5, opacityB: 0.5 });
  });

  it("dip-black splits halves", () => {
    const early = getTransitionMix("dip-black", 0.25);
    expect(early.mode).toBe("opacity");
    if (early.mode === "opacity") {
      expect(early.opacityA).toBeCloseTo(0.5);
      expect(early.opacityB).toBe(0);
    }
    const late = getTransitionMix("dip-black", 0.75);
    if (late.mode === "opacity") {
      expect(late.opacityA).toBe(0);
      expect(late.opacityB).toBeCloseTo(0.5);
    }
  });

  it("wipe mid progress has edge at 0.5", () => {
    const mix = getTransitionMix("wipe", 0.5, { direction: "left", softness: 0.1 });
    expect(mix.mode).toBe("geometric");
    if (mix.mode === "geometric") {
      expect(mix.kind).toBe("wipe");
      expect(mix.progress).toBe(0.5);
      expect(mix.direction).toBe("left");
      expect(mix.softness).toBeCloseTo(0.1);
    }
  });

  it("push normalizes direction and zero softness", () => {
    const mix = getTransitionMix("push", 0.3, { direction: "up" });
    expect(mix).toMatchObject({
      mode: "geometric",
      kind: "push",
      progress: 0.3,
      direction: "up",
      softness: 0,
      blur: 0,
    });
  });

  it("whip carries blur", () => {
    const mix = getTransitionMix("whip", 0.4, { direction: "right", blur: 0.7 });
    expect(mix).toMatchObject({
      mode: "geometric",
      kind: "whip",
      direction: "right",
      blur: 0.7,
      softness: 0,
    });
  });

  it("iris carries center and softness", () => {
    const mix = getTransitionMix("iris", 0.2, {
      softness: 0.12,
      centerX: 0.25,
      centerY: 0.75,
    });
    expect(mix).toMatchObject({
      mode: "geometric",
      kind: "iris",
      softness: 0.12,
      centerX: 0.25,
      centerY: 0.75,
    });
  });

  it("unknown type falls back to crossfade opacity", () => {
    const mix = getTransitionMix("unknown-fx", 0.25);
    expect(mix).toEqual({ mode: "opacity", opacityA: 0.75, opacityB: 0.25 });
  });

  it("getTransitionClipOpacity wraps opacity mixes", () => {
    expect(getTransitionClipOpacity("crossfade", 0.25, "A")).toBeCloseTo(0.75);
    expect(getTransitionClipOpacity("crossfade", 0.25, "B")).toBeCloseTo(0.25);
    expect(getTransitionClipOpacity("wipe", 0.5, "A")).toBe(1);
  });

  it("normalizers clamp", () => {
    expect(normalizeTransitionDirection("RIGHT")).toBe("right");
    expect(normalizeTransitionDirection("nope")).toBe("left");
    expect(normalizeTransitionSoftness(2)).toBe(0.5);
    expect(normalizeTransitionSoftness(-1)).toBe(0);
  });
});
