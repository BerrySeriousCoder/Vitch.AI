import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import {
  resolveCompositingStates,
  setClipParent,
  setClipTrackMatte,
  validateCompositingHierarchy,
} from "./compositing-hierarchy";
import { validateTimeline } from "./validate-timeline";

const transform = (x = 0) => ({ x, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 });
const clip = (id: string, startTime = 0): Clip => ({
  id, trackId: "v", sourceMediaId: "asset", startTime, duration: 2, sourceOffset: 0,
  speed: 1, transform: transform(), opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1,
});
const tracks = (): Track[] => [{ id: "v", name: "Video", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [clip("parent"), { ...clip("child"), transform: transform(10) }] }];

describe("compositing hierarchy", () => {
  it("inherits parent transform and opacity", () => {
    const t = tracks();
    const parent = t[0]!.clips[0]!;
    const child = t[0]!.clips[1]!;
    parent.transform = transform(20);
    parent.opacity = 0.5;
    child.parentId = parent.id;
    const resolved = resolveCompositingStates(t, t[0]!.clips.map((c) => ({ clipId: c.id, transform: c.transform, opacity: c.opacity })));
    expect(resolved.get(child.id)?.matrix[4]).toBe(30);
    expect(resolved.get(child.id)?.opacity).toBe(0.5);
  });

  it("rejects parent cycles", () => {
    const t = tracks();
    const first = setClipParent(t, "child", "parent");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(setClipParent(first.tracks, "parent", "child")).toEqual(expect.objectContaining({ ok: false }));
  });

  it("validates matte sources and allows alpha/luma references", () => {
    const t = tracks();
    const result = setClipTrackMatte(t, "child", { sourceClipId: "parent", type: "luma" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateCompositingHierarchy(result.tracks)).toEqual([]);
    expect(setClipTrackMatte(t, "child", { sourceClipId: "child", type: "alpha" })).toEqual(expect.objectContaining({ ok: false }));
  });

  it("treats null controllers as valid non-media layers", () => {
    const t = tracks();
    t.push({
      id: "null-track", name: "Controller", type: "null", order: 1, locked: false, visible: true, solo: false,
      clips: [{ ...clip("controller"), trackId: "null-track", sourceMediaId: null, nullLayer: true }],
    });
    expect(validateTimeline(t).some((issue) => issue.code === "missing_media")).toBe(false);
  });
});
