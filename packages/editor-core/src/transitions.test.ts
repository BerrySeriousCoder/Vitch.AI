import { describe, it, expect } from "vitest";
import type { Clip, Track, Transition } from "@tempo/types";
import {
  applyTransition,
  removeTransition,
  validateTransitionPlacement,
  updateTransitionDuration,
  getTransitionWindow,
  getTransitionProgress,
} from "./transitions";

function clip(partial: Partial<Clip> & { id: string; trackId: string }): Clip {
  return {
    sourceMediaId: "m1",
    startTime: 0,
    duration: 5,
    sourceOffset: 0,
    speed: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
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

function videoTrack(clips: Clip[]): Track {
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

describe("transitions core", () => {
  const media = { m1: 30, m2: 30 };

  it("refuses insufficient tail", () => {
    const a = clip({
      id: "a",
      trackId: "t1",
      sourceMediaId: "m1",
      startTime: 0,
      duration: 5,
      sourceOffset: 25, // source 25-30, no tail
    });
    const b = clip({
      id: "b",
      trackId: "t1",
      sourceMediaId: "m2",
      startTime: 5,
      duration: 5,
      sourceOffset: 2, // has head
    });
    const result = validateTransitionPlacement(
      [videoTrack([a, b])],
      {
        trackId: "t1",
        clipAId: "a",
        clipBId: "b",
        duration: 1,
        type: "crossfade",
      },
      media
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("insufficient_tail");
  });

  it("refuses insufficient head", () => {
    // With extend-A-only geometry, head is not required — keep a smoke test for unknown type instead
    const a = clip({
      id: "a",
      trackId: "t1",
      sourceMediaId: "m1",
      startTime: 0,
      duration: 5,
      sourceOffset: 0,
    });
    const b = clip({
      id: "b",
      trackId: "t1",
      sourceMediaId: "m2",
      startTime: 5,
      duration: 5,
      sourceOffset: 0,
    });
    const result = validateTransitionPlacement(
      [videoTrack([a, b])],
      {
        trackId: "t1",
        clipAId: "a",
        clipBId: "b",
        duration: 1,
        type: "not-a-real-type",
      },
      media
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_type");
  });

  it("applies steal-to-overlap and removes cleanly", () => {
    const a = clip({
      id: "a",
      trackId: "t1",
      sourceMediaId: "m1",
      startTime: 0,
      duration: 5,
      sourceOffset: 0,
    });
    const b = clip({
      id: "b",
      trackId: "t1",
      sourceMediaId: "m2",
      startTime: 5,
      duration: 5,
      sourceOffset: 2,
    });
    const applied = applyTransition(
      [videoTrack([a, b])],
      [],
      {
        trackId: "t1",
        clipAId: "a",
        clipBId: "b",
        type: "crossfade",
        duration: 1,
      },
      media
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const ca = applied.value.tracks[0]!.clips.find((c) => c.id === "a")!;
    const cb = applied.value.tracks[0]!.clips.find((c) => c.id === "b")!;
    expect(ca.duration).toBe(6);
    expect(cb.startTime).toBe(5);
    expect(cb.duration).toBe(5);
    expect(cb.sourceOffset).toBe(2);
    expect(applied.value.transitions).toHaveLength(1);

    const win = getTransitionWindow(ca, cb, 1);
    expect(win[0]).toBeCloseTo(5);
    expect(win[1]).toBeCloseTo(6);
    expect(getTransitionProgress(5.5, win)).toBeCloseTo(0.5);

    const removed = removeTransition(
      applied.value.tracks,
      applied.value.transitions,
      applied.value.transition.id
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const ra = removed.value.tracks[0]!.clips.find((c) => c.id === "a")!;
    const rb = removed.value.tracks[0]!.clips.find((c) => c.id === "b")!;
    expect(ra.duration).toBe(5);
    expect(rb.startTime).toBe(5);
    expect(rb.duration).toBe(5);
    expect(rb.sourceOffset).toBe(2);
    expect(removed.value.transitions).toHaveLength(0);
  });

  it("updateTransitionDuration re-validates handles", () => {
    const a = clip({
      id: "a",
      trackId: "t1",
      sourceMediaId: "m1",
      startTime: 0,
      duration: 5,
      sourceOffset: 0,
    });
    const b = clip({
      id: "b",
      trackId: "t1",
      sourceMediaId: "m2",
      startTime: 5,
      duration: 5,
      sourceOffset: 3,
    });
    const applied = applyTransition(
      [videoTrack([a, b])],
      [],
      {
        id: "tx1",
        trackId: "t1",
        clipAId: "a",
        clipBId: "b",
        type: "dip-black",
        duration: 0.5,
      },
      media
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const updated = updateTransitionDuration(
      applied.value.tracks,
      applied.value.transitions,
      "tx1",
      1,
      media
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.transitions[0]!.duration).toBe(1);
  });
});
