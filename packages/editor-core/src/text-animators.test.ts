import { describe, expect, it } from "vitest";
import {
  splitTextUnits,
  resolveUnitMotion,
  validateAnimators,
  applyTextAnimatorPreset,
  textHasKineticAnimators,
  normalizeAnimator,
} from "./text-animators";

describe("text-animators", () => {
  it("splits by char/word/line", () => {
    expect(splitTextUnits("ab", "char").map((u) => u.text)).toEqual(["a", "b"]);
    expect(splitTextUnits("hi there", "word").map((u) => u.text)).toEqual([
      "hi ",
      "there",
    ]);
    expect(splitTextUnits("a\nb", "line").map((u) => u.text)).toEqual(["a", "b"]);
  });

  it("resolves staggered opacity", () => {
    const anim = [
      normalizeAnimator({
        property: "opacity",
        offsetSec: 0,
        durationSec: 0.1,
        staggerSec: 0.1,
        from: 0,
        to: 1,
        ease: "linear",
      }),
    ];
    expect(resolveUnitMotion(0, 0, anim).opacity).toBe(0);
    expect(resolveUnitMotion(0, 0.1, anim).opacity).toBeCloseTo(1);
    expect(resolveUnitMotion(1, 0.05, anim).opacity).toBe(0);
    expect(resolveUnitMotion(1, 0.2, anim).opacity).toBeCloseTo(1);
  });

  it("uses explicit irregular per-unit event times", () => {
    const anim = [normalizeAnimator({
      property: "opacity",
      unitStartTimes: [0.1, 0.37],
      durationSec: 0.01,
      from: 0,
      to: 1,
      ease: "hold",
    })];
    expect(resolveUnitMotion(0, 0.2, anim).opacity).toBe(1);
    expect(resolveUnitMotion(1, 0.2, anim).opacity).toBe(0);
    expect(resolveUnitMotion(1, 0.38, anim).opacity).toBe(1);
  });

  it("resolves multi-stage per-unit overshoot and settle curves", () => {
    const anim = [normalizeAnimator({
      property: "scale",
      unitStartTimes: [0.2],
      valueKeyframes: [
        { timeSec: 0, value: 0, easing: "linear" },
        { timeSec: 0.01, value: 1.5, easing: "hold" },
        { timeSec: 0.1, value: 1.5, easing: "hold" },
        { timeSec: 0.3, value: 1, easing: "linear" },
      ],
    })];
    expect(resolveUnitMotion(0, 0.2, anim).scale).toBe(0);
    expect(resolveUnitMotion(0, 0.25, anim).scale).toBe(1.5);
    expect(resolveUnitMotion(0, 0.4, anim).scale).toBeCloseTo(1.25);
    expect(resolveUnitMotion(0, 0.6, anim).scale).toBe(1);
  });

  it("validates and rejects NaN", () => {
    expect(validateAnimators([{ property: "opacity", from: NaN }]).ok).toBe(false);
    expect(validateAnimators([{ property: "opacity", from: 0, to: 1 }]).ok).toBe(true);
    expect(validateAnimators([{ property: "opacity", unitStartTimes: [0, Number.NaN] }]).ok).toBe(false);
    expect(validateAnimators([{ property: "scale", valueKeyframes: [{ timeSec: 0, value: 0 }] }]).ok).toBe(false);
  });

  it("validates and resolves per-unit rotation and color", () => {
    expect(
      validateAnimators([
        { property: "color", fromColor: "#f00", toColor: "#00ff00" },
      ]).ok
    ).toBe(true);
    expect(
      validateAnimators([{ property: "color", fromColor: "red", toColor: "#00ff00" }]).ok
    ).toBe(false);
    expect(
      validateAnimators([{ property: "rotation", range: [3, 1] }]).ok
    ).toBe(false);

    const animators = [
      normalizeAnimator({
        property: "rotation",
        offsetSec: 0,
        durationSec: 1,
        staggerSec: 0,
        from: -30,
        to: 0,
        ease: "linear",
      }),
      normalizeAnimator({
        property: "color",
        offsetSec: 0,
        durationSec: 1,
        staggerSec: 0,
        fromColor: "#ff0000",
        toColor: "#00ff00",
        ease: "linear",
      }),
    ];
    const halfway = resolveUnitMotion(0, 0.5, animators);
    expect(halfway.rotation).toBeCloseTo(-15);
    expect(halfway.color).toBe("#808000");
  });

  it("applies typewriter preset", () => {
    const next = applyTextAnimatorPreset(
      {
        text: "Hi",
        fontFamily: "Inter",
        fontSize: 48,
        fontWeight: "600",
        color: "#fff",
        textAlign: "center",
        lineHeight: 1.3,
      },
      "typewriter",
      2
    );
    expect(next.split).toBe("char");
    expect(textHasKineticAnimators(next)).toBe(true);
  });

  it("ships rotation and color kinetic presets", () => {
    const next = applyTextAnimatorPreset(
      {
        text: "Hit",
        fontFamily: "Inter",
        fontSize: 48,
        fontWeight: "600",
        color: "#fff",
        textAlign: "center",
        lineHeight: 1.3,
      },
      "word-slam",
      2
    );
    expect(next.animators?.map((animator) => animator.property)).toEqual(
      expect.arrayContaining(["rotation", "color"])
    );
  });
});
