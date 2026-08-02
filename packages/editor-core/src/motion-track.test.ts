import { describe, expect, it } from "vitest";
import { normalizeMotionTrack, resolveMotionTrackAtTime } from "./motion-track";

describe("motion track", () => {
  it("normalizes samples and interpolates sparse AI tracking data", () => {
    const track = normalizeMotionTrack({
      sourceClipId: "source",
      subject: "speaker",
      samples: [
        { time: 2, x: 1.2, y: -0.1, scale: 40 },
        { time: 0, x: 0.2, y: 0.4, scale: 1, confidence: 0.9 },
      ],
      useScale: true,
    });
    expect(track?.samples).toEqual([
      expect.objectContaining({ time: 0, x: 0.2, y: 0.4, scale: 1 }),
      expect.objectContaining({ time: 2, x: 1, y: 0, scale: 20 }),
    ]);
    const mid = resolveMotionTrackAtTime(track, 1);
    expect(mid?.x).toBeCloseTo(0.6);
    expect(mid?.y).toBeCloseTo(0.2);
    expect(mid?.scale).toBeCloseTo(10.5);
  });

  it("requires at least two valid samples", () => {
    expect(normalizeMotionTrack({ sourceClipId: "s", subject: "x", samples: [{ time: 0, x: 0.5, y: 0.5 }] })).toBeNull();
  });
});
