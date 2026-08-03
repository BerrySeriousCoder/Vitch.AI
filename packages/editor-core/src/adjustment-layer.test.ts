import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import { createAdjustmentLayer, validateAdjustmentClip } from "./adjustment-layer";
import { needsFrameExport } from "./export-policy";
import { validateTimeline } from "./validate-timeline";

describe("adjustment layers", () => {
  it("creates a time-bounded top-level adjustment track with a valid effect host clip", () => {
    const out = createAdjustmentLayer({
      tracks: [],
      trackId: "adj-track",
      clipId: "adj-clip",
      name: "Global Grade",
      startTime: 2,
      duration: 4,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const track = out.tracks[0]!;
    expect(track.type).toBe("adjustment");
    expect(track.clips[0]!.adjustmentLayer).toEqual({ target: "below" });
    expect(needsFrameExport(out.tracks)).toBe(true);
    expect(validateTimeline(out.tracks)).toEqual([]);
  });

  it("reports malformed adjustment clips instead of treating them as missing media", () => {
    const clip = {
      id: "bad",
      trackId: "adj",
      sourceMediaId: "media-1",
      startTime: 0,
      duration: 2,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: true,
      volume: 0,
    } satisfies Clip;
    const track: Track = { id: "adj", name: "Adj", type: "adjustment", order: 0, locked: false, visible: true, solo: false, clips: [clip] };
    expect(validateAdjustmentClip(track, clip)).toMatch(/must declare/);
    expect(validateTimeline([track]).some((issue) => issue.code === "invalid_adjustment_layer")).toBe(true);
  });
});
