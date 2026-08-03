import { describe, expect, it } from "vitest";
import type { Clip, Track, Transition } from "@tempo/types";
import { sourceEdit } from "./source-edit";

const transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 };

function clip(id: string, trackId: string, startTime: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return { id, trackId, sourceMediaId: id, startTime, duration, sourceOffset: 0, speed: 1, transform: { ...transform }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1, ...extra };
}

function incoming(startTime: number, duration: number): Omit<Clip, "id" | "trackId"> {
  const { id: _id, trackId: _trackId, ...value } = clip("incoming", "v1", startTime, duration);
  return value;
}

function project(): { tracks: Track[]; transitions: Transition[] } {
  return {
    tracks: [
      { id: "v1", name: "V1", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [clip("before", "v1", 0, 2), clip("video-linked", "v1", 2, 2, { linkGroupId: "g" })] },
      { id: "a1", name: "A1", type: "audio", order: 1, locked: false, visible: true, solo: false, clips: [clip("audio-linked", "a1", 2, 2, { linkGroupId: "g" })] },
    ],
    transitions: [{ id: "tx", trackId: "v1", clipAId: "before", clipBId: "video-linked", type: "crossfade", duration: 0.2, params: {} }],
  };
}

describe("sourceEdit", () => {
  it("ripples later linked A/V together and removes only the transition crossing the insert", () => {
    const state = project();
    let id = 0;
    const result = sourceEdit(state.tracks, state.transitions, "v1", incoming(2, 1), "insert", () => `new-${++id}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks[0]!.clips.find((item) => item.id === "video-linked")!.startTime).toBe(3);
    expect(result.tracks[1]!.clips.find((item) => item.id === "audio-linked")!.startTime).toBe(3);
    expect(result.transitions).toEqual([]);
    expect(result.metadata.changedClipIds).toEqual(expect.arrayContaining(["video-linked", "audio-linked"]));
  });

  it("refuses a linked ripple through a locked partner track", () => {
    const state = project();
    state.tracks[1]!.locked = true;
    const result = sourceEdit(state.tracks, state.transitions, "v1", incoming(2, 1), "insert", () => "new");
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/locked track/i) });
  });

  it("keeps the original id when overwrite trims only the head of a clip", () => {
    const state = project();
    state.tracks[0]!.clips = [clip("target", "v1", 2, 3, { sourceOffset: 4 })];
    const result = sourceEdit(state.tracks, [], "v1", incoming(1, 2), "overwrite", () => "inserted");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks[0]!.clips.find((item) => item.id === "target")).toMatchObject({ startTime: 3, duration: 2, sourceOffset: 5 });
    expect(result.metadata.removedClipIds).toEqual([]);
  });
});
