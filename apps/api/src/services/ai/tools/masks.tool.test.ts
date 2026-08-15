import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import { masksToolExecutors } from "./masks.tool.js";
import { createProjectState } from "./index.js";

function clip(id: string): Clip {
  return {
    id,
    trackId: "t1",
    sourceMediaId: "m1",
    startTime: 0,
    duration: 5,
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
  };
}

function track(clips: Clip[]): Track {
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

describe("masks tools", () => {
  it("sets and clears a rect mask", () => {
    const state = createProjectState([track([clip("c1")])]);
    const set = masksToolExecutors.set_clip_mask!(
      { clipId: "c1", shape: "rect", feather: 0.1 },
      state
    );
    expect(set.result).toMatch(/Set rect mask/);
    expect(set.state.tracks[0]!.clips[0]!.mask?.shape).toBe("rect");
    expect(set.state.tracks[0]!.clips[0]!.mask?.feather).toBeCloseTo(0.1);

    const cleared = masksToolExecutors.clear_clip_mask!({ clipId: "c1" }, set.state);
    expect(cleared.state.tracks[0]!.clips[0]!.mask).toBeNull();
  });
});
