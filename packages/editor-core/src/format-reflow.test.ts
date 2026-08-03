import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import { reflowTracksForComposition } from "./format-reflow";

function clip(): Clip {
  return {
    id: "clip", trackId: "track", sourceMediaId: null, startTime: 0, duration: 1,
    sourceOffset: 0, speed: 1, opacity: 1, blendMode: "normal", effects: [], mask: null,
    muted: false, volume: 1,
    transform: { x: 480, y: 270, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 20, anchorY: 10 },
    keyframes: [
      { id: "x", property: "transform.x", time: 0, value: 480, easing: "linear" },
      { id: "scale", property: "transform.scaleX", time: 0, value: 2, easing: "linear" },
    ],
    shapeParams: { shape: "rect", fill: "#fff", stroke: "#000", strokeWidth: 4, width: 200, height: 100 },
  };
}

describe("reflowTracksForComposition", () => {
  it("preserves normalized position without stretching graphic geometry", () => {
    const tracks: Track[] = [{ id: "track", name: "Shape", type: "shape", order: 0, visible: true, locked: false, solo: false, clips: [clip()] }];
    const result = reflowTracksForComposition(tracks, { width: 1920, height: 1080 }, { width: 1080, height: 1920 });
    const output = result[0]!.clips[0]!;
    expect(output.transform.x).toBe(270);
    expect(output.transform.y).toBe(480);
    expect(output.shapeParams?.width).toBe(112.5);
    expect(output.shapeParams?.height).toBe(56.25);
    expect(output.keyframes[0]!.value).toBe(270);
    expect(output.keyframes[1]!.value).toBe(2);
  });
});
