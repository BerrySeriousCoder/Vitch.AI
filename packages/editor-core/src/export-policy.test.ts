import { describe, expect, it } from "vitest";
import { needsFrameExport, getEffectDefinition } from "./index";
import type { Track, Transition } from "@tempo/types";

function trackWithEffects(effects: Array<{ type: string; enabled?: boolean }>): Track {
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
        duration: 2,
        sourceOffset: 0,
        speed: 1,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
        opacity: 1,
        blendMode: "normal",
        effects: effects.map((e, i) => ({
          id: `e${i}`,
          type: e.type,
          name: e.type,
          enabled: e.enabled !== false,
          params: {},
          keyframes: [],
        })),
        keyframes: [],
        mask: null,
        muted: false,
        volume: 1,
      },
    ],
  };
}

describe("needsFrameExport", () => {
  it("is false for css-only effects", () => {
    expect(needsFrameExport([trackWithEffects([{ type: "brightness" }])])).toBe(false);
    expect(needsFrameExport([trackWithEffects([{ type: "blur" }])])).toBe(false);
  });

  it("is true for WebGPU frame effects including primary grade", () => {
    expect(getEffectDefinition("color-curves")?.exportBackend).toBe("frame");
    expect(needsFrameExport([trackWithEffects([{ type: "color-curves" }])])).toBe(true);
    expect(getEffectDefinition("color-grade")?.exportBackend).toBe("frame");
    expect(needsFrameExport([trackWithEffects([{ type: "color-grade" }])])).toBe(true);
    expect(getEffectDefinition("hsl-secondary")?.exportBackend).toBe("frame");
    expect(needsFrameExport([trackWithEffects([{ type: "hsl-secondary" }])])).toBe(true);
    expect(getEffectDefinition("lift-gamma-gain")?.exportBackend).toBe("frame");
    expect(needsFrameExport([trackWithEffects([{ type: "lift-gamma-gain" }])])).toBe(true);
    expect(getEffectDefinition("levels")?.exportBackend).toBe("frame");
    expect(needsFrameExport([trackWithEffects([{ type: "levels" }])])).toBe(true);
    expect(getEffectDefinition("glow")?.exportBackend).toBe("frame");
    expect(needsFrameExport([trackWithEffects([{ type: "glow" }])])).toBe(true);
    expect(needsFrameExport([trackWithEffects([{ type: "grain" }])])).toBe(true);
  });

  it("ignores disabled frame effects", () => {
    expect(
      needsFrameExport([trackWithEffects([{ type: "glow", enabled: false }])])
    ).toBe(false);
  });

  it("is true for wipe/push transitions", () => {
    const wipe: Transition = {
      id: "tr1",
      trackId: "t1",
      clipAId: "a",
      clipBId: "b",
      duration: 0.5,
      type: "wipe",
      params: { direction: "left" },
    };
    expect(needsFrameExport([trackWithEffects([])], [wipe])).toBe(true);
    expect(
      needsFrameExport([trackWithEffects([])], [
        { ...wipe, type: "crossfade", params: {} },
      ])
    ).toBe(false);
  });

  it("is true when a clip has a mask", () => {
    const t = trackWithEffects([]);
    t.clips[0]!.mask = {
      shape: "ellipse",
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.8,
      feather: 0.05,
      inverted: false,
      opacity: 1,
    };
    expect(needsFrameExport([t])).toBe(true);
  });

  it("routes static visual transforms, opacity, blend, and cover fit through the parity renderer", () => {
    const transformed = trackWithEffects([]);
    transformed.clips[0]!.transform.scaleX = 1.2;
    expect(needsFrameExport([transformed])).toBe(true);

    const translucent = trackWithEffects([]);
    translucent.clips[0]!.opacity = 0.8;
    expect(needsFrameExport([translucent])).toBe(true);

    const blended = trackWithEffects([]);
    blended.clips[0]!.blendMode = "screen";
    expect(needsFrameExport([blended])).toBe(true);

    const cover = trackWithEffects([]);
    cover.clips[0]!.mediaLayout = { schemaVersion: 1, fit: "cover" };
    expect(needsFrameExport([cover])).toBe(true);
  });

  it("is true for clip keyframes or kinetic text", () => {
    const kf = trackWithEffects([]);
    kf.clips[0]!.keyframes = [
      { id: "k1", property: "opacity", time: 0, value: 0, easing: "linear" },
    ];
    expect(needsFrameExport([kf])).toBe(true);

    const kinetic = trackWithEffects([]);
    kinetic.type = "text";
    kinetic.clips[0]!.textParams = {
      text: "Hi",
      fontFamily: "Inter",
      fontSize: 48,
      fontWeight: "600",
      color: "#fff",
      textAlign: "center",
      lineHeight: 1.3,
      split: "char",
      animators: [
        {
          property: "opacity",
          offsetSec: 0,
          durationSec: 0.2,
          staggerSec: 0.05,
          from: 0,
          to: 1,
          ease: "linear",
        },
      ],
    };
    expect(needsFrameExport([kinetic])).toBe(true);
  });

  it("routes advanced text and shape paint through the shared frame renderer", () => {
    const text = trackWithEffects([]);
    text.type = "text";
    text.clips[0]!.textParams = {
      text: "Gradient",
      fontFamily: "Inter",
      fontSize: 48,
      fontWeight: "700",
      color: "#ffffff",
      textAlign: "center",
      lineHeight: 1.2,
      fillGradient: { type: "linear", from: "#fff", to: "#7c3aed" },
    };
    expect(needsFrameExport([text])).toBe(true);

    const shape = trackWithEffects([]);
    shape.type = "shape";
    shape.clips[0]!.shapeParams = {
      shape: "rect", fill: "#fff", stroke: "transparent", strokeWidth: 0, width: 100, height: 100,
      glow: { color: "#22d3ee", blur: 12 },
    };
    expect(needsFrameExport([shape])).toBe(true);
  });

  it("routes format-aware graphic layouts through the shared frame renderer", () => {
    const text = trackWithEffects([]);
    text.type = "text";
    text.clips[0]!.textParams = {
      text: "Reel title",
      fontFamily: "Inter",
      fontSize: 64,
      fontWeight: "700",
      color: "#fff",
      textAlign: "center",
      lineHeight: 1.2,
    };
    text.clips[0]!.layout = {
      schemaVersion: 1,
      mode: "normalized",
      x: 0.5,
      y: 0.25,
      width: 0.8,
      safety: "title",
      overflow: "warn",
      source: "agent",
    };
    expect(needsFrameExport([text])).toBe(true);
  });

  it("is true for marked clip hold", () => {
    const t = trackWithEffects([]);
    t.clips[0]!.hold = { at: "out", durationSec: 0.5 };
    expect(needsFrameExport([t])).toBe(true);
  });

  it("is true when an effect has param keyframes", () => {
    const t = trackWithEffects([{ type: "brightness" }]);
    t.clips[0]!.effects[0]!.keyframes = [
      { id: "k1", property: "value", time: 0, value: 1, easing: "linear" },
      { id: "k2", property: "value", time: 1, value: 1.5, easing: "linear" },
    ];
    expect(needsFrameExport([t])).toBe(true);
  });

  it("is true for speed ramp or reverse", () => {
    const ramp = trackWithEffects([]);
    ramp.clips[0]!.speedRamp = [
      { time: 0, rate: 1 },
      { time: 2, rate: 0.4 },
    ];
    expect(needsFrameExport([ramp])).toBe(true);

    const rev = trackWithEffects([]);
    rev.clips[0]!.reversed = true;
    expect(needsFrameExport([rev])).toBe(true);

    const neg = trackWithEffects([]);
    neg.clips[0]!.speed = -1;
    expect(needsFrameExport([neg])).toBe(true);
  });

  it("is true for frame-blended retiming", () => {
    const blended = trackWithEffects([]);
    blended.clips[0]!.retime = { interpolation: "frame-blend", frameRate: 30 };
    expect(needsFrameExport([blended])).toBe(true);
  });

  it("is true when chroma key is set", () => {
    const t = trackWithEffects([]);
    t.clips[0]!.chromaKey = {
      keyColor: "#00FF00",
      similarity: 0.4,
      smoothness: 0.1,
      spill: 0.4,
      screen: "green",
    };
    expect(needsFrameExport([t])).toBe(true);
  });

  it("is true for parented layers and track mattes", () => {
    const parented = trackWithEffects([]);
    parented.clips[0]!.parentId = "controller";
    expect(needsFrameExport([parented])).toBe(true);

    const matte = trackWithEffects([]);
    matte.clips[0]!.trackMatte = { sourceClipId: "matte-source", type: "alpha" };
    expect(needsFrameExport([matte])).toBe(true);

    const blurred = trackWithEffects([]);
    blurred.clips[0]!.motionBlur = { enabled: true, shutterAngle: 180, samples: 8 };
    expect(needsFrameExport([blurred])).toBe(true);

    const stabilized = trackWithEffects([]);
    stabilized.clips[0]!.stabilization = {
      enabled: true,
      smoothness: 0.6,
      cropScale: 1.08,
      samples: [{ time: 0, x: 0.5, y: 0.5 }, { time: 1, x: 0.55, y: 0.52 }],
    };
    expect(needsFrameExport([stabilized])).toBe(true);

    const captionGraphic = trackWithEffects([]);
    captionGraphic.clips[0]!.textParams = {
      text: "Caption", fontFamily: "Inter", fontSize: 42, fontWeight: "700", color: "#fff", textAlign: "center", lineHeight: 1.2, captionPresetId: "podcast",
    };
    expect(needsFrameExport([captionGraphic])).toBe(true);

    const multicam = trackWithEffects([]);
    multicam.clips[0]!.multicam = {
      angles: [
        { id: "a", name: "Wide", sourceClipId: "a", sourceMediaId: "a", sourceOffset: 0 },
        { id: "b", name: "Close", sourceClipId: "b", sourceMediaId: "b", sourceOffset: 0 },
      ],
      switches: [{ time: 0, angleId: "a" }], audioAngleId: "a",
    };
    expect(needsFrameExport([multicam])).toBe(true);
  });
});
