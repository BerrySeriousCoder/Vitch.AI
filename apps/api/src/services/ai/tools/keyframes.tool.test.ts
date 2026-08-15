import { describe, it, expect } from "vitest";
import type { Track } from "@tempo/types";
import { keyframeToolExecutors } from "./keyframes.tool.js";

function emptyState(tracks: Track[] = []) {
  return { tracks };
}

function textClipTrack(): Track {
  return {
    id: "t1",
    name: "Text",
    type: "text",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips: [
      {
        id: "c1",
        trackId: "t1",
        sourceMediaId: null,
        startTime: 0,
        duration: 3,
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
        textParams: {
          text: "Hello",
          fontFamily: "Inter",
          fontSize: 48,
          fontWeight: "600",
          color: "#fff",
          textAlign: "center",
          lineHeight: 1.3,
        },
      },
    ],
  };
}

describe("keyframe tools", () => {
  it("applies fade-in preset", () => {
    const state = emptyState([textClipTrack()]);
    const { result, state: next } = keyframeToolExecutors.apply_animation_preset!(
      { clipId: "c1", presetId: "fade-in" },
      state
    );
    expect(result).toContain("fade-in");
    const clip = next.tracks[0]!.clips[0]!;
    expect(clip.keyframes.length).toBeGreaterThanOrEqual(2);
    expect(clip.keyframes.some((k) => k.property === "opacity")).toBe(true);
  });

  it("adds and removes keyframes", () => {
    const state = emptyState([textClipTrack()]);
    const added = keyframeToolExecutors.add_keyframe!(
      { clipId: "c1", property: "opacity", time: 0, value: 0, easing: "ease-out" },
      state
    );
    expect(added.result).toMatch(/Added keyframe/);
    const id = added.state.tracks[0]!.clips[0]!.keyframes[0]!.id;
    const removed = keyframeToolExecutors.remove_keyframe!(
      { clipId: "c1", keyframeId: id },
      added.state
    );
    expect(removed.state.tracks[0]!.clips[0]!.keyframes).toHaveLength(0);
  });

  it("rejects unknown presets", () => {
    const state = emptyState([textClipTrack()]);
    const { result } = keyframeToolExecutors.apply_animation_preset!(
      { clipId: "c1", presetId: "nope" },
      state
    );
    expect(result).toMatch(/Unknown preset/);
  });

  it("adds effect keyframes with effectId", () => {
    const track = textClipTrack();
    track.clips[0]!.effects = [
      {
        id: "e1",
        type: "blur",
        name: "Blur",
        enabled: true,
        params: { value: 0 },
        keyframes: [],
      },
    ];
    const state = emptyState([track]);
    const added = keyframeToolExecutors.add_keyframe!(
      {
        clipId: "c1",
        effectId: "e1",
        property: "value",
        time: 0,
        value: 8,
      },
      state
    );
    expect(added.result).toMatch(/effect e1/);
    expect(added.state.tracks[0]!.clips[0]!.effects[0]!.keyframes).toHaveLength(1);
    expect(added.state.tracks[0]!.clips[0]!.keyframes).toHaveLength(0);

    const preset = keyframeToolExecutors.apply_effect_animation_preset!(
      {
        clipId: "c1",
        effectId: "e1",
        presetId: "fade-in-blur",
      },
      added.state
    );
    expect(preset.result).toMatch(/fade-in-blur/);
    expect(
      preset.state.tracks[0]!.clips[0]!.effects[0]!.keyframes.length
    ).toBeGreaterThanOrEqual(2);
  });

  it("rejects non-keyframeable effect params", () => {
    const track = textClipTrack();
    track.clips[0]!.effects = [
      {
        id: "e1",
        type: "lut",
        name: "LUT",
        enabled: true,
        params: { lutId: "builtin:cinematic", intensity: 1 },
        keyframes: [],
      },
    ];
    const state = emptyState([track]);
    const { result } = keyframeToolExecutors.add_keyframe!(
      {
        clipId: "c1",
        effectId: "e1",
        property: "lutId",
        time: 0,
        value: 0,
      },
      state
    );
    expect(result).toMatch(/not keyframeable/);
  });

  it("rejects malformed clip keyframes without mutating the clip", () => {
    const state = emptyState([textClipTrack()]);
    const invalid = [
      { property: "transform.constructor", time: 0, value: 1 },
      { property: "opacity", time: 0, value: 2 },
      { property: "transform.x", time: 4, value: 10 },
      { property: "transform.x", time: 1, value: Number.NaN },
      { property: "crop.width", time: 1, value: -0.2 },
      { property: "transform.x", time: 1, value: 2, easing: "spring" },
    ];
    for (const input of invalid) {
      const result = keyframeToolExecutors.add_keyframe!({ clipId: "c1", ...input }, state);
      expect(result.result).toMatch(/^Error:/);
      expect(state.tracks[0]!.clips[0]!.keyframes).toEqual([]);
    }
  });

  it("atomically writes a custom stepped curve anchored to reference impacts", () => {
    const state = {
      ...emptyState([textClipTrack()]),
      editBlueprint: {
        audioAnalysis: {
          impacts: [{ id: "impact-title", time: 1.25, strength: 1, isDownbeat: false, kind: "onset" }],
        },
      },
    } as any;
    const applied = keyframeToolExecutors.set_keyframe_curve!({
      clipId: "c1",
      property: "transform.scaleX",
      keyframes: [
        { time: 0, value: 1 },
        { syncEventId: "impact-title", value: 1.5, easing: "hold" },
        { time: 1.5, value: 1, easing: "ease-out" },
      ],
    }, state);
    expect(JSON.parse(applied.result)).toMatchObject({ ok: true, keyframes: 3 });
    expect(applied.state.tracks[0]!.clips[0]!.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1.25, 1.5]);
    expect(applied.state.tracks[0]!.clips[0]!.keyframes[1]!.easing).toBe("hold");
  });

  it("does not partially mutate when an event-anchored curve is invalid", () => {
    const state = emptyState([textClipTrack()]);
    const applied = keyframeToolExecutors.set_keyframe_curve!({
      clipId: "c1",
      property: "opacity",
      keyframes: [
        { time: 0, value: 0 },
        { syncEventId: "missing", value: 1 },
      ],
    }, state);
    expect(applied.result).toMatch(/^Error:/);
    expect(state.tracks[0]!.clips[0]!.keyframes).toEqual([]);
  });

  it("rejects invalid updates and effect values outside schema bounds", () => {
    const state = emptyState([textClipTrack()]);
    const added = keyframeToolExecutors.add_keyframe!({ clipId: "c1", property: "opacity", time: 1, value: 0.5 }, state);
    const keyframeId = added.state.tracks[0]!.clips[0]!.keyframes[0]!.id;
    const before = structuredClone(added.state.tracks[0]!.clips[0]!.keyframes[0]);
    const updated = keyframeToolExecutors.update_keyframe!({ clipId: "c1", keyframeId, time: -1 }, added.state);
    expect(updated.result).toMatch(/^Error:/);
    expect(updated.state.tracks[0]!.clips[0]!.keyframes[0]).toEqual(before);

    const track = textClipTrack();
    track.clips[0]!.effects = [{ id: "blur", type: "blur", name: "Blur", enabled: true, params: { value: 0 }, keyframes: [] }];
    const effectState = emptyState([track]);
    const effect = keyframeToolExecutors.add_keyframe!({ clipId: "c1", effectId: "blur", property: "value", time: 1, value: 999 }, effectState);
    expect(effect.result).toMatch(/^Error:/);
    expect(effectState.tracks[0]!.clips[0]!.effects[0]!.keyframes).toEqual([]);
  });
});
