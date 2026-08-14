import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { speedToolExecutors } from "./speed.tool.js";

function track(): Track {
  return {
    id: "t1",
    name: "V1",
    type: "video",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips: [
      {
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
      },
    ],
  };
}

describe("speed tools", () => {
  it("sets reverse via negative speed", () => {
    const state = { tracks: [track()] };
    const { result, state: next } = speedToolExecutors.set_clip_speed!(
      { clipId: "c1", speed: -1 },
      state
    );
    expect(result).toMatch(/reversed/);
    expect(next.tracks[0]!.clips[0]!.speed).toBe(1);
    expect(next.tracks[0]!.clips[0]!.reversed).toBe(true);
    expect(next.tracks[0]!.clips[0]!.speedRamp).toBeNull();
  });

  it("applies slow-mo-middle preset", () => {
    const state = { tracks: [track()] };
    const { result, state: next } = speedToolExecutors.apply_speed_preset!(
      { clipId: "c1", presetId: "slow-mo-middle" },
      state
    );
    expect(result).toMatch(/slow-mo-middle/);
    expect(next.tracks[0]!.clips[0]!.speedRamp!.length).toBeGreaterThanOrEqual(2);
  });

  it("sets and clears ramp", () => {
    const state = { tracks: [track()] };
    const set = speedToolExecutors.set_speed_ramp!(
      {
        clipId: "c1",
        points: [
          { time: 0, rate: 1 },
          { time: 2, rate: 0.4 },
          { time: 4, rate: 1 },
        ],
      },
      state
    );
    expect(set.state.tracks[0]!.clips[0]!.speedRamp).toHaveLength(3);
    const cleared = speedToolExecutors.clear_speed_ramp!(
      { clipId: "c1" },
      set.state
    );
    expect(cleared.state.tracks[0]!.clips[0]!.speedRamp).toBeNull();
  });

  it("rejects coerced speed and reversed values without mutating the clip", () => {
    const state = { tracks: [track()] };
    const speed = speedToolExecutors.set_clip_speed!({ clipId: "c1", speed: "2" }, state);
    expect(speed.result).toMatch(/^Error/);
    expect(speed.state.tracks[0]!.clips[0]!.speed).toBe(1);

    const ramp = speedToolExecutors.set_speed_ramp!({
      clipId: "c1",
      points: [{ time: 0, rate: 1 }, { time: 4, rate: 2 }],
      reversed: "false",
    }, state);
    expect(ramp.result).toMatch(/^Error/);
    expect(ramp.state.tracks[0]!.clips[0]!.speedRamp).toBeUndefined();
  });

  it("configures bounded frame-blend retime quality", () => {
    const state = { tracks: [track()] };
    const result = speedToolExecutors.set_retime_quality!({ clipId: "c1", interpolation: "frame-blend", frameRate: 90 }, state);
    expect(result.state.tracks[0]!.clips[0]!.retime).toEqual({ interpolation: "frame-blend", frameRate: 60 });
  });
});
