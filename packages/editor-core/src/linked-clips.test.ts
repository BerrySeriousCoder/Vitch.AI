import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import { linkClips, rippleDeleteLinkedGroup, unlinkClips } from "./linked-clips";

function clip(id: string, trackId: string, startTime: number): Clip {
  return { id, trackId, sourceMediaId: id, startTime, duration: 2, sourceOffset: 0, speed: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1 };
}
const timeline = (): Track[] => [
  { id: "v", name: "Video", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [clip("v1", "v", 0), clip("v2", "v", 2)] },
  { id: "a", name: "Audio", type: "audio", order: 1, locked: false, visible: true, solo: false, clips: [clip("a1", "a", 0), clip("a2", "a", 2)] },
];

describe("linked clips", () => {
  it("links, ripples, and unlinks synchronized A/V clips", () => {
    const linked = linkClips(timeline(), ["v1", "a1"], "group");
    if (!linked.ok) throw new Error(linked.message);
    const deleted = rippleDeleteLinkedGroup(linked.tracks, [], "v1");
    if (!deleted.ok) throw new Error(deleted.message);
    expect(deleted.tracks.map((track) => track.clips[0]!.id)).toEqual(["v2", "a2"]);
    expect(deleted.tracks.map((track) => track.clips[0]!.startTime)).toEqual([0, 0]);
    const unlinked = unlinkClips(linked.tracks, ["v1", "a1"]);
    if (!unlinked.ok) throw new Error(unlinked.message);
    expect(unlinked.tracks.flatMap((track) => track.clips).filter((clip) => ["v1", "a1"].includes(clip.id)).every((clip) => !clip.linkGroupId)).toBe(true);
  });

  it("rejects an unsynchronized A/V link instead of creating a group that cannot be edited safely", () => {
    const tracks = timeline();
    tracks[1]!.clips[0] = { ...tracks[1]!.clips[0]!, startTime: 0.25 };
    const result = linkClips(tracks, ["v1", "a1"], "group");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/same timeline start/i);
  });
});
