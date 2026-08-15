import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { cropToolExecutors } from "./crop.tool.js";

function state() {
  const tracks: Track[] = [{
    id: "v1", name: "Video", type: "video", order: 0, locked: false, visible: true, solo: false,
    clips: [{
      id: "clip-1", trackId: "v1", sourceMediaId: "media-1", startTime: 0, duration: 3, sourceOffset: 0, speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 }, opacity: 1, blendMode: "normal",
      effects: [], keyframes: [], mask: null, muted: false, volume: 1,
    }],
  }];
  return { tracks, audioMixer: { masterVolume: 1, trackVolumes: {}, trackMutes: {} } };
}

describe("crop tools", () => {
  it("sets an explicit non-distorting media fit and focal point", () => {
    const project = state();
    const out = cropToolExecutors.set_media_fit!(
      { clipId: "clip-1", fit: "cover", focalX: 0.7, focalY: 0.4 },
      project
    );
    expect(out.result).not.toMatch(/error/i);
    expect(project.tracks[0]!.clips[0]!.mediaLayout).toEqual({
      schemaVersion: 1,
      fit: "cover",
      focalPoint: { x: 0.7, y: 0.4 },
    });
  });

  it("sets crop and applies Ken Burns without discarding other animation", () => {
    const project = state();
    const clip = project.tracks[0]!.clips[0]!;
    clip.keyframes.push({ id: "opacity", property: "opacity", time: 0, value: 1, easing: "linear" });
    expect(cropToolExecutors.set_clip_crop!({ clipId: "clip-1", x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, project).result).not.toMatch(/error/i);
    const out = cropToolExecutors.apply_ken_burns!({ clipId: "clip-1", presetId: "zoom-in" }, project);
    expect(out.result).not.toMatch(/error/i);
    expect(clip.keyframes.some((keyframe) => keyframe.property === "opacity")).toBe(true);
    expect(clip.keyframes.filter((keyframe) => keyframe.property.startsWith("crop.")).length).toBe(8);
  });

  it("places media in a normalized grid cell without enabling fill distortion", () => {
    const project = state();
    const out = cropToolExecutors.set_media_viewport!(
      { clipId: "clip-1", x: 0.5, y: 0, width: 0.5, height: 0.5, fit: "cover" },
      project
    );
    expect(out.result).not.toMatch(/error/i);
    expect(project.tracks[0]!.clips[0]!.mediaLayout).toMatchObject({
      fit: "cover",
      viewport: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    });
  });
});
