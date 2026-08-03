import { describe, expect, it } from "vitest";
import { normalizePlanarTrack, resolvePlanarTrackAtTime } from "./planar-track";

const quad = (offset: number): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] => [
  { x: 0.1 + offset, y: 0.2 }, { x: 0.5 + offset, y: 0.2 },
  { x: 0.5 + offset, y: 0.6 }, { x: 0.1 + offset, y: 0.6 },
];

describe("planar track", () => {
  it("normalizes convex corner pins and interpolates every corner", () => {
    const track = normalizePlanarTrack({
      sourceClipId: "source", surface: "phone screen",
      samples: [{ time: 2, corners: quad(0.2) }, { time: 0, corners: quad(0), confidence: 2 }],
    });
    expect(track?.samples).toHaveLength(2);
    expect(track?.samples[0]?.confidence).toBe(1);
    const mid = resolvePlanarTrackAtTime(track, 1);
    expect(mid?.corners[0]).toEqual({ x: 0.2, y: 0.2 });
    expect(mid?.corners[2]).toEqual({ x: 0.6, y: 0.6 });
  });

  it("rejects an invalid self-crossing pin", () => {
    expect(normalizePlanarTrack({
      sourceClipId: "source", surface: "screen", samples: [
        { time: 0, corners: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 }, { x: 0.8, y: 0.1 }, { x: 0.1, y: 0.8 }] },
        { time: 1, corners: quad(0) },
      ],
    })).toBeNull();
  });
});
