import { describe, expect, it } from "vitest";
import type { Effect, Track } from "@tempo/types";
import { applyClipAttributes, reorderClipEffects, setEffectEnabled } from "./effect-stack";

const fx = (id: string, type: string): Effect => ({ id, type, name: type, enabled: true, params: type === "color-grade" ? { exposure: 1 } : { value: 0.5 }, keyframes: [] });
const track = (): Track[] => [{ id: "t", name: "V1", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [
  { id: "source", trackId: "t", sourceMediaId: "a", startTime: 0, duration: 2, sourceOffset: 0, speed: 1, transform: { x: 1, y: 2, scaleX: 1.2, scaleY: 1.2, rotation: 4, anchorX: 0, anchorY: 0 }, opacity: 0.8, blendMode: "screen", effects: [fx("color", "color-grade"), fx("blur", "blur")], keyframes: [], mask: null, muted: true, volume: 0.4, fadeInSec: 0.2, fadeOutSec: 0.3 },
  { id: "target", trackId: "t", sourceMediaId: "b", startTime: 2, duration: 2, sourceOffset: 0, speed: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 }, opacity: 1, blendMode: "normal", effects: [fx("old", "vignette")], keyframes: [], mask: null, muted: false, volume: 1 },
] }];

describe("effect stack operations", () => {
  it("toggles and strictly reorders an effect stack", () => {
    const disabled = setEffectEnabled(track(), "source", "blur", false);
    if ("ok" in disabled) throw new Error(disabled.message);
    expect(disabled.tracks[0]!.clips[0]!.effects[1]!.enabled).toBe(false);
    const reordered = reorderClipEffects(disabled.tracks, "source", ["blur", "color"]);
    if ("ok" in reordered) throw new Error(reordered.message);
    expect(reordered.tracks[0]!.clips[0]!.effects.map((effect) => effect.id)).toEqual(["blur", "color"]);
  });

  it("copies color, motion, and audio without reusing effect IDs", () => {
    let n = 0;
    const result = applyClipAttributes(track(), { sourceClipId: "source", targetClipIds: ["target"], scopes: ["color", "motion", "audio"] }, () => `copy-${++n}`);
    if ("ok" in result) throw new Error(result.message);
    const target = result.tracks[0]!.clips[1]!;
    expect(target.effects.map((effect) => effect.type)).toEqual(["vignette", "color-grade"]);
    expect(target.effects[1]!.id).toBe("copy-1");
    expect(target.transform).toEqual(track()[0]!.clips[0]!.transform);
    expect(target.volume).toBe(0.4);
    expect(target.muted).toBe(true);
  });
});
