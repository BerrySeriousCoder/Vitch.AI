import { describe, expect, it } from "vitest";
import {
  planHoldExtension,
  normalizeHold,
  validateHold,
} from "./hold";
import { sourceTimeWithHold } from "./speed-ramp";
import type { Clip } from "@tempo/types";

function clip(partial: Partial<Clip> = {}): Clip {
  return {
    id: "c1",
    trackId: "t1",
    sourceMediaId: "m1",
    startTime: 0,
    duration: 5,
    sourceOffset: 1,
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

describe("hold", () => {
  it("plans extension deficit", () => {
    expect(planHoldExtension(1.0, 0.3)).toEqual({
      holdSourceSec: 0.7,
      useMediaSec: 0.3,
    });
  });

  it("freezes out hold at end", () => {
    const c = clip({
      hold: { at: "out", durationSec: 1 },
      duration: 5,
      sourceOffset: 0,
    });
    expect(sourceTimeWithHold(c, 4.5).frozen).toBe(true);
    expect(sourceTimeWithHold(c, 4.5).sourceTime).toBeCloseTo(4);
    expect(sourceTimeWithHold(c, 2).frozen).toBe(false);
  });

  it("freezes in hold at start", () => {
    const c = clip({
      hold: { at: "in", durationSec: 1 },
      sourceOffset: 2,
    });
    expect(sourceTimeWithHold(c, 0.2)).toEqual({ sourceTime: 2, frozen: true });
    expect(sourceTimeWithHold(c, 1.5).sourceTime).toBeCloseTo(2.5);
  });

  it("validates hold", () => {
    expect(validateHold({ at: "out", durationSec: NaN }).ok).toBe(false);
    expect(normalizeHold({ at: "out", durationSec: 0 })).toBeNull();
  });
});
