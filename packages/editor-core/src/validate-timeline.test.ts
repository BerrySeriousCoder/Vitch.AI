import { describe, expect, it } from "vitest";
import type { Track, Transition } from "@tempo/types";
import { validateTimeline } from "./validate-timeline";

function videoTrack(clips: Track["clips"]): Track {
  return {
    id: "t1",
    name: "V1",
    type: "video",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips,
  };
}

function baseClip(id: string, start: number, duration: number): Track["clips"][0] {
  return {
    id,
    trackId: "t1",
    sourceMediaId: "m1",
    startTime: start,
    duration,
    sourceOffset: 0,
    speed: 1,
    opacity: 1,
    blendMode: "normal",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    volume: 1,
    muted: false,
    effects: [],
    keyframes: [],
    mask: null,
  };
}

describe("validateTimeline", () => {
  it("returns empty for clean timeline", () => {
    const tracks = [videoTrack([baseClip("a", 0, 2), baseClip("b", 2, 2)])];
    expect(validateTimeline(tracks, [])).toEqual([]);
  });

  it("flags missing media and unknown effects", () => {
    const clip = baseClip("a", 0, 2);
    clip.sourceMediaId = null;
    clip.effects = [
      {
        id: "e1",
        type: "not_a_real_fx" as any,
        name: "Unknown effect",
        enabled: true,
        params: {},
        keyframes: [],
      },
    ];
    const issues = validateTimeline([videoTrack([clip])], []);
    expect(issues.some((i) => i.code === "missing_media")).toBe(true);
    expect(issues.some((i) => i.code === "unknown_effect")).toBe(true);
  });

  it("flags overlap without transition and orphan transitions", () => {
    const tracks = [videoTrack([baseClip("a", 0, 2), baseClip("b", 1.5, 2)])];
    const orphan: Transition = {
      id: "tx1",
      trackId: "t1",
      clipAId: "missing",
      clipBId: "b",
      type: "crossfade",
      duration: 0.5,
      params: {},
    };
    const issues = validateTimeline(tracks, [orphan]);
    expect(issues.some((i) => i.code === "overlap_without_transition")).toBe(true);
    expect(issues.some((i) => i.code === "orphan_transition")).toBe(true);
  });

  it("flags source consumption beyond a known media duration", () => {
    const clip = baseClip("a", 0, 3);
    clip.sourceOffset = 1;
    clip.speed = 2;
    const issues = validateTimeline([videoTrack([clip])], [], [], { m1: 5 });
    expect(issues).toContainEqual(expect.objectContaining({ code: "source_range_overrun", severity: "error" }));
  });
});
