import { describe, it, expect } from "vitest";
import type { Track } from "@tempo/types";
import { effectsToolExecutors } from "./effects.tool.js";
import { timelineToolExecutors } from "./timeline.tool.js";
import { DEFAULT_AUDIO_MIXER, type ProjectState } from "./project-state.js";

function videoTrack(): Track {
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
        duration: 2,
        sourceOffset: 0,
        speed: 1,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
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

function stateWith(tracks: Track[]): ProjectState {
  return {
    tracks,
    audioMixer: { ...DEFAULT_AUDIO_MIXER, trackVolumes: {}, trackMutes: {} },
  };
}

describe("effect + track tools", () => {
  it("applies cinematic preset", () => {
    const { result, state: next } = effectsToolExecutors.apply_effect_preset!(
      { clipId: "c1", presetId: "cinematic" },
      stateWith([videoTrack()])
    ) as { result: string; state: ProjectState };
    expect(result).toMatch(/Cinematic/);
    expect(next.tracks[0]!.clips[0]!.effects.length).toBeGreaterThanOrEqual(2);
  });

  it("duplicates a clip", () => {
    const { result, state: next } = timelineToolExecutors.duplicate_clip!(
      { clipId: "c1" },
      stateWith([videoTrack()])
    );
    expect(result).toMatch(/Duplicated/);
    expect(next.tracks[0]!.clips).toHaveLength(2);
  });

  it("removes a track", () => {
    const { state: next } = timelineToolExecutors.remove_track!(
      { trackId: "t1" },
      stateWith([videoTrack()])
    );
    expect(next.tracks).toHaveLength(0);
  });
});
