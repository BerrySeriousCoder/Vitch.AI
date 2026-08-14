import { describe, expect, it } from "vitest";
import type { MediaAsset, Track } from "@tempo/types";
import { colorMatchToolExecutors } from "./color-match.tool.js";
import { MUTATING_TOOL_NAMES, getToolDefinitions } from "./index.js";
import { DEFAULT_AUDIO_MIXER, type ProjectState } from "./project-state.js";

function stats(red: number, blue: number) {
  return { meanRed: red, meanGreen: 0.5, meanBlue: blue, meanLuma: 0.5, lumaStdDev: 0.25, meanSaturation: 0.4, blackPoint: 0.04, whitePoint: 0.96, sampleCount: 4096, sampledAt: "", source: "ffmpeg" as const };
}

function clip(id: string, assetId: string) {
  return { id, trackId: "t", sourceMediaId: assetId, startTime: 0, duration: 2, sourceOffset: 0, speed: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 }, opacity: 1, blendMode: "normal" as const, effects: [], keyframes: [], mask: null, muted: false, volume: 1 };
}

function state(): ProjectState {
  const tracks: Track[] = [{ id: "t", name: "V1", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [clip("reference", "ref"), clip("target", "target")] }];
  const mediaAssets = [
    { id: "ref", projectId: "p", name: "Ref", type: "video", url: "", thumbnailUrl: null, proxyUrl: null, waveformUrl: null, duration: 2, metadata: { fileSize: 0, mimeType: "video/mp4", colorStatistics: stats(0.7, 0.35) }, status: "ready", createdAt: "" },
    { id: "target", projectId: "p", name: "Target", type: "video", url: "", thumbnailUrl: null, proxyUrl: null, waveformUrl: null, duration: 2, metadata: { fileSize: 0, mimeType: "video/mp4", colorStatistics: stats(0.35, 0.7) }, status: "ready", createdAt: "" },
  ] as MediaAsset[];
  return { tracks, audioMixer: { ...DEFAULT_AUDIO_MIXER, trackVolumes: {}, trackMutes: {} }, mediaAssets };
}

describe("color match tools", () => {
  it("registers both tools and marks them as mutating", () => {
    const names = new Set(getToolDefinitions().map((definition) => definition.name));
    expect(names.has("match_clip_color")).toBe(true);
    expect(names.has("apply_reference_color_match")).toBe(true);
    expect(MUTATING_TOOL_NAMES.has("match_clip_color")).toBe(true);
    expect(MUTATING_TOOL_NAMES.has("apply_reference_color_match")).toBe(true);
  });

  it("matches a target clip to a timeline reference", () => {
    const project = state();
    const result = colorMatchToolExecutors.match_clip_color!({ referenceClipId: "reference", targetClipIds: ["target"] }, project);
    expect(JSON.parse(result.result).applied[0].clipId).toBe("target");
    expect(project.tracks[0]!.clips[1]!.effects[0]!.type).toBe("color-grade");
  });

  it("applies Edit Like This reference stats", () => {
    const project = state();
    project.styleDna = { id: "dna", source: "reference", pacing: { avgShotSec: 1, cutRate: 60, label: "fast" }, color: { palette: [], gradingHint: "warm", referenceStatistics: stats(0.7, 0.35) }, typography: { density: 0, preferredPositions: ["center"], animationHints: [] }, motion: { zoomBias: 0, panBias: 0, energy: 0 }, audio: { beatCutBias: false }, transitions: { vocabulary: [] }, narrativeRoles: [], createdAt: "" };
    const result = colorMatchToolExecutors.apply_reference_color_match!({ targetClipIds: ["target"] }, project);
    expect(JSON.parse(result.result).source).toBe("edit-like-this-reference");
  });

  it("excludes matte-fill clips from implicit reference grading", () => {
    const project = state();
    project.styleDna = { id: "dna", source: "reference", pacing: { avgShotSec: 1, cutRate: 60, label: "fast" }, color: { palette: [], gradingHint: "warm", referenceStatistics: stats(0.7, 0.35) }, typography: { density: 0, preferredPositions: ["center"], animationHints: [] }, motion: { zoomBias: 0, panBias: 0, energy: 0 }, audio: { beatCutBias: false }, transitions: { vocabulary: [] }, narrativeRoles: [], createdAt: "" };
    project.editBlueprint = {
      id: "bp", referenceUrl: "", totalDuration: 2, aspectRatio: "16:9", createdAt: "",
      overallStyle: { colorGrading: "", pacing: "fast", mood: "", genre: "" },
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "", genre: "" },
      segments: [{ index: 0, startTime: 0, duration: 2, shotType: "wide", motionType: "static", transitionToNext: "cut", energyLevel: 50, visualDescription: "matte", colorPalette: [], effects: [], textOverlays: [], onBeat: false, speed: 1, composition: { replaceBase: true, layers: [{ id: "fill", role: "matte-fill", contentDescription: "fill", zIndex: 0, timing: { startRatio: 0, endRatio: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 }, fit: "cover", matteTextOverlayIndex: 0 }] } }],
    };
    project.tracks[0]!.clips[1]!.referenceEditBinding = { blueprintId: "bp", kind: "composition-layer", segmentIndex: 0, layerId: "fill", expectedStartTime: 0, expectedDuration: 2 };
    colorMatchToolExecutors.apply_reference_color_match!({}, project);
    expect(project.tracks[0]!.clips[1]!.effects).toHaveLength(0);
  });
});
