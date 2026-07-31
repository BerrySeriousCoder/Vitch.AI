import { describe, expect, it } from "vitest";
import { applyColorMatchToClip, colorStatisticsFromPalette, deriveColorMatch } from "./color-match";
import type { Track } from "@tempo/types";

const reference = { meanRed: 0.7, meanGreen: 0.55, meanBlue: 0.4, meanLuma: 0.58, lumaStdDev: 0.3, meanSaturation: 0.5, blackPoint: 0.03, whitePoint: 0.95, sampleCount: 4096, sampledAt: "", source: "ffmpeg" as const };
const target = { meanRed: 0.4, meanGreen: 0.48, meanBlue: 0.65, meanLuma: 0.48, lumaStdDev: 0.18, meanSaturation: 0.25, blackPoint: 0.05, whitePoint: 0.92, sampleCount: 4096, sampledAt: "", source: "ffmpeg" as const };

function track(): Track {
  return { id: "t", name: "V1", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [{ id: "target", trackId: "t", sourceMediaId: "asset", startTime: 0, duration: 2, sourceOffset: 0, speed: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1 }] };
}

describe("color match", () => {
  it("derives a warm, brighter correction from decoded statistics", () => {
    const proposal = deriveColorMatch(reference, target, 1);
    expect(proposal.grade.exposure).toBeGreaterThan(0);
    expect(proposal.grade.temperature).toBeGreaterThan(0);
    expect(proposal.grade.saturation).toBeGreaterThan(0);
  });

  it("creates then merges a non-destructive primary grade", () => {
    const result = applyColorMatchToClip([track()], "target", deriveColorMatch(reference, target), () => "match") as any;
    expect(result.effectId).toBe("match");
    expect(result.tracks[0].clips[0].effects[0].name).toBe("Color Match");
    const merged = applyColorMatchToClip(result.tracks, "target", deriveColorMatch(target, reference), () => "unused") as any;
    expect(merged.created).toBe(false);
    expect(merged.tracks[0].clips[0].effects).toHaveLength(1);
  });

  it("falls back to a usable profile from a hex palette", () => {
    expect(colorStatisticsFromPalette(["#ff8844", "#552244"])?.meanRed).toBeGreaterThan(0.4);
  });
});
