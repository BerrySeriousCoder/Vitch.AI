import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import { matchFrameTime, rollEdit, slideEdit, slipEdit } from "./advanced-timeline-edit";

function clip(id: string, startTime: number, duration = 2, sourceOffset = 0): Clip {
  return { id, trackId: "t", sourceMediaId: "media", startTime, duration, sourceOffset, speed: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1 };
}

function tracks(): Track[] {
  return [{ id: "t", name: "V1", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [clip("a", 0, 2, 0), clip("b", 2, 2, 2), clip("c", 4, 2, 4)] }];
}

describe("advanced timeline edits", () => {
  it("rolls an abutting boundary without moving downstream clips", () => {
    const result = rollEdit(tracks(), [], "a", "b", 0.5, { media: 10 });
    if (!result.ok) throw new Error(result.message);
    const clips = result.tracks[0]!.clips;
    expect([clips[0]!.duration, clips[1]!.startTime, clips[1]!.duration, clips[2]!.startTime]).toEqual([2.5, 2.5, 1.5, 4]);
  });

  it("slides while preserving outer cut points and slips only source timing", () => {
    const slid = slideEdit(tracks(), [], "b", 0.5, { media: 10 });
    if (!slid.ok) throw new Error(slid.message);
    const clips = slid.tracks[0]!.clips;
    expect([clips[0]!.duration, clips[1]!.startTime, clips[2]!.startTime, clips[2]!.duration]).toEqual([2.5, 2.5, 4, 1.5]);
    const slipped = slipEdit(tracks(), [], "b", 0.5, { media: 10 });
    if (!slipped.ok) throw new Error(slipped.message);
    expect(slipped.tracks[0]!.clips[1]!.sourceOffset).toBe(2.5);
  });

  it("locates an equivalent source frame in another clip", () => {
    const timeline = tracks();
    timeline[0]!.clips[1]!.sourceOffset = 0;
    const result = matchFrameTime(timeline, "a", 1, "b");
    expect(result).toEqual({ ok: true, sourceTime: 1, targetTimelineTime: 3 });
  });
});
