import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { effectsToolExecutors } from "./effects.tool.js";
import type { ProjectState } from "./project-state.js";
import { DEFAULT_AUDIO_MIXER } from "./project-state.js";

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
        duration: 5,
        sourceOffset: 0,
        speed: 1,
        opacity: 1,
        blendMode: "normal",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        effects: [],
        keyframes: [],
        mask: null,
        volume: 1,
        muted: false,
      },
    ],
  };
}

function baseState(): ProjectState {
  return {
    audioMixer: { ...DEFAULT_AUDIO_MIXER, trackVolumes: {}, trackMutes: {} },
    tracks: [videoTrack()],
  };
}

describe("escape-css effects tools", () => {
  it("rejects string booleans when toggling an effect", async () => {
    const added = await effectsToolExecutors.add_effect!(
      { clipId: "c1", effectType: "glow", params: {} },
      baseState()
    );
    const effectId = added.state.tracks[0]!.clips[0]!.effects[0]!.id;
    const toggled = await effectsToolExecutors.set_effect_enabled!(
      { clipId: "c1", effectId, enabled: "false" },
      added.state
    );
    expect(toggled.result).toMatch(/^Error/);
    expect(toggled.state.tracks[0]!.clips[0]!.effects[0]!.enabled).toBe(true);
  });

  it("sets a bounded pre-grade S-Log3 input transform", async () => {
    const { result, state } = await effectsToolExecutors.set_clip_input_color_space!(
      { clipId: "c1", profile: "slog3", exposureCompensation: 9 },
      baseState()
    );
    expect(JSON.parse(result)).toMatchObject({ ok: true, profile: "slog3", exposureCompensation: 4 });
    expect(state.tracks[0]!.clips[0]!.effects[0]!.params).toMatchObject({ profile: "slog3", exposureCompensation: 4 });
  });

  it("add_effect glow with params", async () => {
    const state = baseState();
    const { result, state: next } = await effectsToolExecutors.add_effect!(
      {
        clipId: "c1",
        effectType: "glow",
        params: { intensity: 1.2, threshold: 0.4, radius: 10 },
      },
      state
    );
    expect(result).toMatch(/Soft Glow/);
    const fx = next.tracks[0]!.clips[0]!.effects[0]!;
    expect(fx.type).toBe("glow");
    expect(fx.params.intensity).toBe(1.2);
    expect(fx.params.radius).toBe(10);
  });

  it("adds a primary color grade with schema-clamped controls", async () => {
    const state = baseState();
    const { result, state: next } = await effectsToolExecutors.add_effect!(
      {
        clipId: "c1",
        effectType: "color-grade",
        params: { exposure: 0.35, temperature: 20, highlights: -140, vibrance: 16 },
      },
      state
    );
    expect(result).toMatch(/Primary Color Grade/);
    const fx = next.tracks[0]!.clips[0]!.effects[0]!;
    expect(fx.params).toMatchObject({
      exposure: 0.35,
      temperature: 20,
      highlights: -100,
      vibrance: 16,
    });
  });

  it("adds a keyframeable HSL secondary correction through the stable effect tool", async () => {
    const state = baseState();
    const { result, state: next } = await effectsToolExecutors.add_effect!(
      {
        clipId: "c1",
        effectType: "hsl-secondary",
        params: { hueCenter: 28, hueRange: 24, saturationShift: 12, lightnessShift: 3 },
      },
      state
    );
    expect(result).toMatch(/HSL Secondary/);
    const fx = next.tracks[0]!.clips[0]!.effects[0]!;
    expect(fx.params).toMatchObject({ hueCenter: 28, hueRange: 24, saturationShift: 12, lightnessShift: 3 });
  });

  it("adds Lift/Gamma/Gain through the stable effect tool", async () => {
    const { result, state } = await effectsToolExecutors.add_effect!(
      {
        clipId: "c1",
        effectType: "lift-gamma-gain",
        params: { liftBlue: 0.12, gammaMaster: -0.08, gainRed: 0.1 },
      },
      baseState()
    );
    expect(result).toMatch(/Lift \/ Gamma \/ Gain/);
    expect(state.tracks[0]!.clips[0]!.effects[0]!.params).toMatchObject({
      liftBlue: 0.12,
      gammaMaster: -0.08,
      gainRed: 0.1,
    });
  });

  it("adds Levels and rejects crossed black/white points", async () => {
    const added = await effectsToolExecutors.add_effect!(
      { clipId: "c1", effectType: "levels", params: { inputBlack: 0.04, inputWhite: 0.96, gamma: 1.08 } },
      baseState()
    );
    expect(added.result).toMatch(/Levels/);
    expect(added.state.tracks[0]!.clips[0]!.effects[0]!.params).toMatchObject({ inputBlack: 0.04, inputWhite: 0.96, gamma: 1.08 });

    const rejected = await effectsToolExecutors.set_effect_params!(
      { clipId: "c1", effectId: added.state.tracks[0]!.clips[0]!.effects[0]!.id, params: { outputBlack: 0.9, outputWhite: 0.1 } },
      added.state
    );
    expect(rejected.result).toMatch(/outputBlack must be below outputWhite/);
  });

  it("rejects inverted HSL secondary qualifier ranges after merging params", async () => {
    const { result } = await effectsToolExecutors.add_effect!(
      {
        clipId: "c1",
        effectType: "hsl-secondary",
        params: { saturationMin: 0.9, saturationMax: 0.2 },
      },
      baseState()
    );
    expect(result).toMatch(/saturationMin cannot exceed saturationMax/);
  });

  it("adds structured luma curves through the stable effect tool", async () => {
    const state = baseState();
    const { result, state: next } = await effectsToolExecutors.add_effect!(
      {
        clipId: "c1",
        effectType: "color-curves",
        params: {
          luma: [{ x: 0, y: 0 }, { x: 0.45, y: 0.6 }, { x: 1, y: 1 }],
        },
      },
      state
    );
    expect(result).toMatch(/RGB \/ Luma Curves/);
    expect(next.tracks[0]!.clips[0]!.effects[0]!.params.luma).toEqual([
      { x: 0, y: 0 },
      { x: 0.45, y: 0.6 },
      { x: 1, y: 1 },
    ]);
  });

  it("rejects malformed curve control points", async () => {
    const { result } = await effectsToolExecutors.add_effect!(
      {
        clipId: "c1",
        effectType: "color-curves",
        params: { red: [{ x: 0.2, y: 0 }, { x: 1, y: 1 }] },
      },
      baseState()
    );
    expect(result).toMatch(/must begin at x=0/);
  });

  it("add_effect lut defaults + set_effect_params", async () => {
    const state = baseState();
    const added = await effectsToolExecutors.add_effect!(
      { clipId: "c1", effectType: "lut" },
      state
    );
    const effectId = added.state.tracks[0]!.clips[0]!.effects[0]!.id;
    const updated = await effectsToolExecutors.set_effect_params!(
      {
        clipId: "c1",
        effectId,
        params: { intensity: 0.5, lutId: "builtin:identity" },
      },
      added.state
    );
    const fx = updated.state.tracks[0]!.clips[0]!.effects[0]!;
    expect(fx.params.intensity).toBe(0.5);
    expect(fx.params.lutId).toBe("builtin:identity");
  });

  it("rejects unknown lutId", async () => {
    const state = baseState();
    const { result } = await effectsToolExecutors.add_effect!(
      {
        clipId: "c1",
        effectType: "lut",
        params: { lutId: "not-a-real-lut" },
      },
      state
    );
    expect(result).toMatch(/Unknown lutId/);
    expect(state.tracks[0]!.clips[0]!.effects).toHaveLength(0);
  });

  it("list_effects includes exportBackend", () => {
    const { result } = effectsToolExecutors.list_effects!({}, baseState()) as {
      result: string;
    };
    const list = JSON.parse(result) as Array<{ type: string; exportBackend: string }>;
    expect(list.some((e) => e.type === "grain" && e.exportBackend === "frame")).toBe(
      true
    );
  });

  it("sets only supported, finite clip properties", () => {
    const state = baseState();
    effectsToolExecutors.set_clip_property!({ clipId: "c1", property: "transform.x", value: "42" }, state);
    effectsToolExecutors.set_clip_property!({ clipId: "c1", property: "transform.anchorX", value: 120 }, state);
    effectsToolExecutors.set_clip_property!({ clipId: "c1", property: "opacity", value: 0.4 }, state);
    effectsToolExecutors.set_clip_property!({ clipId: "c1", property: "blendMode", value: "screen" }, state);
    effectsToolExecutors.set_clip_property!({ clipId: "c1", property: "muted", value: true }, state);

    expect(state.tracks[0]!.clips[0]).toMatchObject({
      transform: { x: 42, anchorX: 120 },
      opacity: 0.4,
      blendMode: "screen",
      muted: true,
    });
  });

  it("rejects malformed clip properties without changing state", async () => {
    const state = baseState();
    const clip = state.tracks[0]!.clips[0]!;
    const invalidUpdates = [
      { property: "transform.constructor", value: 1 },
      { property: "transform.scaleX", value: -1 },
      { property: "transform.x", value: "not-a-number" },
      { property: "opacity", value: 2 },
      { property: "volume", value: Number.NaN },
      { property: "blendMode", value: "erase" },
      { property: "muted", value: "false" },
    ];

    for (const update of invalidUpdates) {
      const before = structuredClone(clip);
      const { result } = await effectsToolExecutors.set_clip_property!({ clipId: "c1", ...update }, state);
      expect(result).toMatch(/^Error:/);
      expect(clip).toEqual(before);
    }
  });

  it("keeps negative speed as reverse shorthand and synchronizes its magnitude", async () => {
    const state = baseState();
    const { result } = await effectsToolExecutors.set_clip_property!(
      { clipId: "c1", property: "speed", value: -2 },
      state
    );
    expect(result).not.toMatch(/^Error:/);
    expect(state.tracks[0]!.clips[0]).toMatchObject({ speed: 2, reversed: true, speedRamp: null });
  });
});
