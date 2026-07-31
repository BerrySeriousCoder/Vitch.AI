import { describe, expect, it } from "vitest";
import type { Clip, Track, Transition } from "@tempo/types";
import {
  closeGapOnTrack,
  deleteClipLeaveGap,
  replaceClipMedia,
  rippleDeleteClip,
  rippleTrimClip,
} from "./timeline-edit";

function baseClip(partial: Partial<Clip> & { id: string; startTime: number; duration: number }): Clip {
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

describe("timeline-edit", () => {
  it("closes a gap between clips", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 0, duration: 2 }),
        baseClip({ id: "b", startTime: 5, duration: 2 }),
      ]),
    ];
    const r = closeGapOnTrack(tracks, [], "t1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.tracks[0]!.clips.find((c) => c.id === "b")!;
    expect(b.startTime).toBeCloseTo(2);
  });

  it("ripple-deletes middle clip and strips transition (A-TX-B-C)", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 0, duration: 2 }),
        baseClip({ id: "b", startTime: 2, duration: 2 }),
        baseClip({ id: "c", startTime: 4, duration: 2 }),
      ]),
    ];
    // Adjacent A-B transition (no steal geometry needed for removeMatching when remove fails gracefully)
    const transitions: Transition[] = [
      {
        id: "tx1",
        trackId: "t1",
        clipAId: "a",
        clipBId: "b",
        duration: 0.5,
        type: "crossfade",
        params: {},
      },
    ];
    const r = rippleDeleteClip(tracks, transitions, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tracks[0]!.clips.map((c) => c.id)).toEqual(["a", "c"]);
    expect(r.tracks[0]!.clips.find((c) => c.id === "c")!.startTime).toBeCloseTo(2);
    expect(r.transitions.find((t) => t.id === "tx1")).toBeUndefined();
  });

  it("delete leave gap keeps hole but removes TX", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 0, duration: 2 }),
        baseClip({ id: "b", startTime: 2, duration: 2 }),
      ]),
    ];
    const transitions: Transition[] = [
      {
        id: "tx1",
        trackId: "t1",
        clipAId: "a",
        clipBId: "b",
        duration: 0.3,
        type: "crossfade",
        params: {},
      },
    ];
    const r = deleteClipLeaveGap(tracks, transitions, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tracks[0]!.clips).toHaveLength(1);
    expect(r.transitions).toHaveLength(0);
  });

  it("ripple-trims out and pulls following clip", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 0, duration: 4 }),
        baseClip({ id: "b", startTime: 4, duration: 2 }),
      ]),
    ];
    const r = rippleTrimClip(tracks, [], "a", { duration: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tracks[0]!.clips.find((c) => c.id === "a")!.duration).toBe(2);
    expect(r.tracks[0]!.clips.find((c) => c.id === "b")!.startTime).toBeCloseTo(2);
  });

  it("ripple-trim in+duration does not double-shift follower", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 0, duration: 4 }),
        baseClip({ id: "b", startTime: 4, duration: 2 }),
      ]),
    ];
    const r = rippleTrimClip(tracks, [], "a", { startTime: 1, duration: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tracks[0]!.clips.find((c) => c.id === "a")!.startTime).toBeCloseTo(1);
    expect(r.tracks[0]!.clips.find((c) => c.id === "a")!.duration).toBe(2);
    expect(r.tracks[0]!.clips.find((c) => c.id === "b")!.startTime).toBeCloseTo(3);
  });

  it("ripple-trim roll-in (end fixed) keeps follower abutted", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 0, duration: 4 }),
        baseClip({ id: "b", startTime: 4, duration: 2 }),
      ]),
    ];
    const r = rippleTrimClip(tracks, [], "a", { startTime: 1, duration: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tracks[0]!.clips.find((c) => c.id === "b")!.startTime).toBeCloseTo(4);
  });

  it("ripple-trim in-only (keep duration) pulls follower once", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 0, duration: 4, sourceOffset: 0 }),
        baseClip({ id: "b", startTime: 4, duration: 2 }),
      ]),
    ];
    const r = rippleTrimClip(tracks, [], "a", { startTime: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.tracks[0]!.clips.find((c) => c.id === "a")!;
    expect(a.startTime).toBeCloseTo(1);
    expect(a.duration).toBe(4);
    expect(a.sourceOffset).toBeCloseTo(1);
    expect(r.tracks[0]!.clips.find((c) => c.id === "b")!.startTime).toBeCloseTo(5);
  });

  it("replace keeps duration and clamps sourceOffset", () => {
    const tracks = [
      track([
        baseClip({
          id: "a",
          startTime: 0,
          duration: 5,
          sourceOffset: 10,
          speed: 1,
        }),
      ]),
    ];
    const r = replaceClipMedia(tracks, [], "a", {
      sourceMediaId: "m2",
      sourceOffset: 10,
      mediaDurationSec: 6,
      fit: "keep-duration",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.tracks[0]!.clips[0]!;
    expect(c.sourceMediaId).toBe("m2");
    expect(c.duration).toBe(5);
    expect(c.sourceOffset).toBeCloseTo(1); // max 6-5=1
  });

  it("replace shortens duration when media shorter than clip (no hold)", () => {
    const tracks = [
      track([
        baseClip({
          id: "a",
          startTime: 0,
          duration: 10,
          sourceOffset: 2,
          speed: 1,
        }),
      ]),
    ];
    const r = replaceClipMedia(tracks, [], "a", {
      sourceMediaId: "m2",
      sourceOffset: 2,
      mediaDurationSec: 4,
      fit: "keep-duration",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.tracks[0]!.clips[0]!;
    expect(c.sourceOffset).toBe(0);
    expect(c.duration).toBeCloseTo(4);
    expect(r.message).toMatch(/shortened/i);
  });

  it("replaceClipMedia rejects nest clips", () => {
    const tracks = [
      track([
        baseClip({
          id: "n",
          startTime: 0,
          duration: 2,
          sourceMediaId: null,
          sourceSequenceId: "seq1",
        }),
      ]),
    ];
    const r = replaceClipMedia(tracks, [], "n", {
      sourceMediaId: "m2",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/nested sequence/i);
  });

  it("preserves speedRamp on ripple delete neighbor", () => {
    const tracks = [
      track([
        baseClip({ id: "a", startTime: 0, duration: 2 }),
        baseClip({
          id: "b",
          startTime: 2,
          duration: 2,
          speedRamp: [
            { time: 0, rate: 1 },
            { time: 2, rate: 0.5 },
          ],
        }),
      ]),
    ];
    const r = rippleDeleteClip(tracks, [], "a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.tracks[0]!.clips[0]!;
    expect(b.startTime).toBeCloseTo(0);
    expect(b.speedRamp).toHaveLength(2);
  });
});
