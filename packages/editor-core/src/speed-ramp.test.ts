import { describe, expect, it } from "vitest";
import type { Clip } from "@tempo/types";
import {
  applySpeedPreset,
  integrateRate,
  isClipReversed,
  normalizeRetimeSettings,
  rateAtTime,
  sourceTimeAt,
  sourceTimeWithHold,
} from "./speed-ramp";

function clip(partial: Partial<Clip> = {}): Clip {
  return {
    id: "c1",
    trackId: "t1",
    sourceMediaId: "m1",
    startTime: 0,
    duration: 4,
    sourceOffset: 0,
    speed: 1,
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: "normal",
    effects: [],
    keyframes: [],
    mask: null,
    muted: false,
    volume: 1,
    ...partial,
  };
}

describe("speed ramp", () => {
  it("maps constant speed", () => {
    const c = clip({ speed: 2, duration: 2 });
    expect(sourceTimeAt(c, 1).sourceTime).toBeCloseTo(2);
    expect(sourceTimeAt(c, 1).frozen).toBe(false);
  });

  it("reverses constant speed window", () => {
    const c = clip({ speed: -1, duration: 4, sourceOffset: 10 });
    expect(isClipReversed(c)).toBe(true);
    expect(sourceTimeAt(c, 0).sourceTime).toBeCloseTo(14);
    expect(sourceTimeAt(c, 4).sourceTime).toBeCloseTo(10);
    expect(sourceTimeAt(c, 2).sourceTime).toBeCloseTo(12);
  });

  it("integrates linear ramp", () => {
    const points = [
      { time: 0, rate: 1 },
      { time: 2, rate: 1 },
    ];
    expect(integrateRate(points, 0, 2)).toBeCloseTo(2);
  });

  it("uses smooth velocity curves while preserving exact source consumption", () => {
    const points = [{ time: 0, rate: 0, interpolation: "smooth" as const }, { time: 2, rate: 2 }];
    expect(rateAtTime(points, 0.5)).toBeCloseTo(0.3125);
    expect(rateAtTime(points, 1)).toBeCloseTo(1);
    expect(integrateRate(points, 0, 2)).toBeCloseTo(2);
  });

  it("bounds frame-blend retime quality", () => {
    expect(normalizeRetimeSettings({ interpolation: "frame-blend", frameRate: 90 })).toEqual({ interpolation: "frame-blend", frameRate: 60 });
  });

  it("slow-mo middle consumes less source mid-way pattern", () => {
    const preset = applySpeedPreset("slow-mo-middle", 4)!;
    const c = clip({ ...preset, duration: 4 });
    const mid = sourceTimeAt(c, 2);
    const end = sourceTimeAt(c, 4);
    expect(end.sourceTime).toBeGreaterThan(mid.sourceTime);
    expect(end.sourceTime).toBeLessThan(4); // slower than 1x overall-ish
  });

  it("hold out still freezes end frame with ramp", () => {
    const c = clip({
      duration: 5,
      sourceOffset: 0,
      speed: 1,
      hold: { at: "out", durationSec: 1 },
      speedRamp: [
        { time: 0, rate: 1 },
        { time: 4, rate: 1 },
      ],
    });
    expect(sourceTimeWithHold(c, 4.5).frozen).toBe(true);
    expect(sourceTimeWithHold(c, 4.5).sourceTime).toBeCloseTo(4);
  });

  it("reverse preset sets reversed flag", () => {
    const p = applySpeedPreset("reverse", 3)!;
    expect(p.reversed).toBe(true);
    expect(p.speedRamp).toBeNull();
  });
});
