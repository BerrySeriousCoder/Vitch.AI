import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import {
  createEmptySequence,
  createSequenceFromClips,
  deleteSequence,
  hasNestClips,
  isNestClip,
  placeSequenceClip,
  sequenceContentEnd,
  sequenceLocalTime,
  validateSequences,
} from "./sequences";
import { needsFrameExport } from "./export-policy";
import { validateTimeline } from "./validate-timeline";

function baseClip(
  partial: Partial<Clip> & { id: string; startTime: number; duration: number }
): Clip {
  return {
    trackId: "t1",
    sourceMediaId: "m1",
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
    ...partial,
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

describe("sequences", () => {
  it("createEmptySequence has a video track", () => {
    const s = createEmptySequence("Intro");
    expect(s.name).toBe("Intro");
    expect(s.tracks).toHaveLength(1);
    expect(s.tracks[0]!.type).toBe("video");
  });

  it("createSequenceFromClips nests and places instance", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 1, duration: 2 }),
        baseClip({ id: "b", startTime: 3, duration: 2 }),
      ]),
    ];
    const r = createSequenceFromClips(tracks, [], [], ["a", "b"], "Pack");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sequences).toHaveLength(1);
    expect(r.tracks[0]!.clips).toHaveLength(1);
    expect(isNestClip(r.tracks[0]!.clips[0]!)).toBe(true);
    expect(r.tracks[0]!.clips[0]!.startTime).toBeCloseTo(1);
    expect(r.tracks[0]!.clips[0]!.duration).toBeCloseTo(4);
    expect(sequenceContentEnd(r.sequences[0]!)).toBeGreaterThan(0);
  });

  it("rejects nesting a nest", () => {
    const tracks = [
      track([
        baseClip({
          id: "n",
          startTime: 0,
          duration: 2,
          sourceMediaId: null,
          sourceSequenceId: "s1",
        }),
      ]),
    ];
    const r = createSequenceFromClips(tracks, [], [], ["n"], "X");
    expect(r.ok).toBe(false);
  });

  it("createSequenceFromClips refuses audio-only host", () => {
    const audioTrack: Track = {
      id: "a1",
      name: "A1",
      type: "audio",
      order: 0,
      locked: false,
      visible: true,
      solo: false,
      clips: [
        baseClip({
          id: "aud",
          trackId: "a1",
          startTime: 0,
          duration: 2,
        }),
      ],
    };
    const r = createSequenceFromClips([audioTrack], [], [], ["aud"], "Pack");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/video\/text\/shape/i);
  });

  it("createSequenceFromClips places nest on non-audio track when mixed", () => {
    const video = track([
      baseClip({ id: "v", startTime: 0, duration: 2 }),
    ]);
    const audio: Track = {
      id: "a1",
      name: "A1",
      type: "audio",
      order: 1,
      locked: false,
      visible: true,
      solo: false,
      clips: [
        baseClip({
          id: "aud",
          trackId: "a1",
          startTime: 0,
          duration: 2,
        }),
      ],
    };
    const r = createSequenceFromClips(
      [video, audio],
      [],
      [],
      ["aud", "v"],
      "Pack"
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tracks.find((t) => t.id === "t1")!.clips[0]!.sourceSequenceId).toBe(
      r.sequenceId
    );
    expect(r.tracks.find((t) => t.id === "a1")!.clips).toHaveLength(0);
  });

  it("deleteSequence fails when referenced", () => {
    const seq = createEmptySequence("S");
    const placed = placeSequenceClip(
      [track([])],
      seq.id,
      "t1",
      0,
      3,
      [seq]
    );
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const del = deleteSequence([seq], placed.tracks, seq.id);
    expect(del.ok).toBe(false);
  });

  it("validateSequences catches missing sequence", () => {
    const tracks = [
      track([
        baseClip({
          id: "n",
          startTime: 0,
          duration: 1,
          sourceMediaId: null,
          sourceSequenceId: "missing",
        }),
      ]),
    ];
    const issues = validateSequences({ tracks, sequences: [] });
    expect(issues.some((i) => i.code === "missing_sequence")).toBe(true);
  });

  it("validateSequences rejects depth > 1", () => {
    const inner = createEmptySequence("Inner");
    const outer = createEmptySequence("Outer");
    outer.tracks[0]!.clips.push(
      baseClip({
        id: "bad",
        trackId: outer.tracks[0]!.id,
        startTime: 0,
        duration: 1,
        sourceMediaId: null,
        sourceSequenceId: inner.id,
      })
    );
    const issues = validateSequences({
      tracks: [],
      sequences: [inner, outer],
    });
    expect(issues.some((i) => i.code === "nested_depth")).toBe(true);
  });

  it("sequenceLocalTime maps parent time", () => {
    const clip = baseClip({
      id: "n",
      startTime: 2,
      duration: 4,
      sourceOffset: 1,
      sourceMediaId: null,
      sourceSequenceId: "s",
    });
    expect(sequenceLocalTime(clip, 2)).toBeCloseTo(1);
    expect(sequenceLocalTime(clip, 4)).toBeCloseTo(3);
  });

  it("needsFrameExport true for nest", () => {
    const tracks = [
      track([
        baseClip({
          id: "n",
          startTime: 0,
          duration: 1,
          sourceMediaId: null,
          sourceSequenceId: "s",
        }),
      ]),
    ];
    expect(hasNestClips(tracks)).toBe(true);
    expect(needsFrameExport(tracks, [], [])).toBe(true);
  });

  it("validateTimeline accepts nest without missing_media", () => {
    const seq = createEmptySequence("S");
    const tracks = [
      track([
        baseClip({
          id: "n",
          startTime: 0,
          duration: 1,
          sourceMediaId: null,
          sourceSequenceId: seq.id,
        }),
      ]),
    ];
    const issues = validateTimeline(tracks, [], [seq]);
    expect(issues.some((i) => i.code === "missing_media")).toBe(false);
    expect(issues.some((i) => i.code === "missing_sequence")).toBe(false);
  });
});
