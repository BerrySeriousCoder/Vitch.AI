import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { chromaToolExecutors } from "./chroma.tool.js";
import { createProjectState } from "./index.js";

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

describe("chroma tools", () => {
  it("lists presets and applies green-screen", () => {
    const state = createProjectState([track()]);
    const listed = chromaToolExecutors.list_chroma_presets!({}, state);
    expect(listed.result).toMatch(/green-screen/);

    const set = chromaToolExecutors.set_clip_chroma_key!(
      { clipId: "c1", presetId: "green-screen" },
      state
    );
    expect(set.result).toMatch(/Set chroma key/);
    expect(set.state.tracks[0]!.clips[0]!.chromaKey?.screen).toBe("green");
  });

  it("tunes similarity and clears", () => {
    const state = createProjectState([track()]);
    chromaToolExecutors.set_clip_chroma_key!(
      { clipId: "c1", presetId: "blue-screen" },
      state
    );
    const tuned = chromaToolExecutors.set_clip_chroma_key!(
      { clipId: "c1", similarity: 0.55 },
      state
    );
    expect(tuned.state.tracks[0]!.clips[0]!.chromaKey?.similarity).toBeCloseTo(0.55);
    expect(tuned.state.tracks[0]!.clips[0]!.chromaKey?.screen).toBe("blue");

    const cleared = chromaToolExecutors.clear_clip_chroma_key!(
      { clipId: "c1" },
      tuned.state
    );
    expect(cleared.state.tracks[0]!.clips[0]!.chromaKey).toBeNull();
  });
});
