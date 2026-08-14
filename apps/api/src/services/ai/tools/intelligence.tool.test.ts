import { describe, expect, it } from "vitest";
import {
  createProjectState,
  getToolExecutor,
} from "./index.js";
import type { MediaAsset, StyleDNA, Track } from "@tempo/types";

const dna: StyleDNA = {
  id: "dna-1",
  source: "manual",
  pacing: { avgShotSec: 2, cutRate: 30, label: "fast" },
  color: { palette: ["#111"], gradingHint: "punchy", contrastBias: 0.1 },
  typography: { density: 1, preferredPositions: ["center"], animationHints: ["fade-in"] },
  motion: { zoomBias: 0.2, panBias: 0, energy: 0.7 },
  audio: { bpm: 120, mood: "hype", beatCutBias: true },
  transitions: { vocabulary: ["dissolve"] },
  narrativeRoles: [
    { role: "hook", weight: 1, shotCriteria: ["face", "opening"], energy: 0.5 },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function assetWithShots(): MediaAsset {
  return {
    id: "m1",
    projectId: "p",
    name: "clip.mp4",
    type: "video",
    url: "/uploads/x.mp4",
    thumbnailUrl: null,
    proxyUrl: null,
    waveformUrl: null,
    duration: 10,
    metadata: {
      fileSize: 1,
      mimeType: "video/mp4",
      shotIndex: {
        schemaVersion: 1,
        model: "test",
        analyzedAt: "2026-01-01T00:00:00.000Z",
        shots: [
          {
            id: "m1-s0",
            assetId: "m1",
            start: 0,
            end: 2,
            tags: ["face", "hook"],
            subjects: ["person"],
            bestFor: ["hook"],
            shotType: "close-up",
            analyzedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "m1-s1",
            assetId: "m1",
            start: 2,
            end: 8,
            tags: ["trees"],
            subjects: [],
            bestFor: ["broll"],
            shotType: "wide",
            analyzedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    },
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("intelligence tools", () => {
  it("list_shots and rank_shots prefer hook shot", async () => {
    const state = createProjectState([], undefined, {
      mediaAssets: [assetWithShots()],
      styleDna: dna,
    });
    const list = getToolExecutor("list_shots")!;
    const listed = await list({}, state);
    expect(listed.result).toContain("m1-s0");

    const rank = getToolExecutor("rank_shots")!;
    const ranked = await rank({ role: "hook", limit: 2 }, state);
    expect(ranked.result).toContain("m1-s0");
    const parsed = JSON.parse(ranked.result);
    expect(parsed.ranked[0].shot.id).toBe("m1-s0");
  });

  it("apply_style_dna mutates tracks", async () => {
    const tracks: Track[] = [
      {
        id: "t1",
        name: "V1",
        type: "video",
        clips: [
          {
            id: "c1",
            trackId: "t1",
            sourceMediaId: "m1",
            startTime: 0,
            duration: 2,
            sourceOffset: 0,
            speed: 1,
            opacity: 1,
            blendMode: "normal",
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
            effects: [],
            keyframes: [],
            mask: null,
            muted: false,
            volume: 1,
          },
        ],
        order: 0,
        locked: false,
        visible: true,
        solo: false,
      },
    ];
    const state = createProjectState(tracks, undefined, { styleDna: dna });
    const apply = getToolExecutor("apply_style_dna")!;
    const out = await apply({}, state);
    expect(out.result).toMatch(/Applied Style DNA/);
    expect(out.state.tracks[0]!.clips[0]!.effects.length).toBeGreaterThan(0);
  });

  it("keeps Edit Like This matte-fill sources color neutral", async () => {
    const tracks: Track[] = [{
      id: "matte-track", name: "Matte", type: "video", order: 0, locked: false, visible: true, solo: false,
      clips: [{
        id: "matte", trackId: "matte-track", sourceMediaId: "m1", startTime: 0, duration: 2,
        sourceOffset: 0, speed: 1, opacity: 1, blendMode: "normal",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        effects: [], keyframes: [], mask: null, muted: true, volume: 0,
        referenceEditBinding: {
          blueprintId: "bp", kind: "composition-layer", segmentIndex: 0, layerId: "fill",
          expectedStartTime: 0, expectedDuration: 2,
        },
      }],
    }];
    const state = createProjectState(tracks, undefined, {
      styleDna: dna,
      editBlueprint: {
        id: "bp", referenceUrl: "", totalDuration: 2, aspectRatio: "16:9", createdAt: "",
        overallStyle: { colorGrading: "", pacing: "fast", mood: "", genre: "" },
        audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "", genre: "" },
        segments: [{
          index: 0, startTime: 0, duration: 2, shotType: "wide", motionType: "static",
          transitionToNext: "cut", energyLevel: 50, visualDescription: "", colorPalette: [], effects: [],
          textOverlays: [], onBeat: false, speed: 1,
          composition: { replaceBase: true, layers: [{
            id: "fill", role: "matte-fill", contentDescription: "mountain fill", zIndex: 0,
            timing: { startRatio: 0, endRatio: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 },
            fit: "cover", matteTextOverlayIndex: 0,
          }] },
        }],
      },
    });
    const out = await getToolExecutor("apply_style_dna")!({}, state);
    expect(out.state.tracks[0]!.clips[0]!.effects).toEqual([]);
  });

  it("strict portrait ranking excludes landscape shots", async () => {
    const portrait = assetWithShots();
    portrait.metadata.displayWidth = 1080;
    portrait.metadata.displayHeight = 1920;
    const landscape = assetWithShots();
    landscape.id = "m2";
    landscape.name = "wide.mp4";
    landscape.metadata.displayWidth = 1920;
    landscape.metadata.displayHeight = 1080;
    landscape.metadata.shotIndex!.shots = landscape.metadata.shotIndex!.shots.map((shot) => ({
      ...shot,
      id: shot.id.replace("m1", "m2"),
      assetId: "m2",
    }));
    const state = createProjectState([], undefined, {
      mediaAssets: [landscape, portrait],
      styleDna: dna,
      settings: {
        width: 1080,
        height: 1920,
        fps: 30,
        duration: 10,
        backgroundColor: "#000000",
        sampleRate: 44100,
      },
    });
    const ranked = await getToolExecutor("rank_shots")!(
      { role: "hook", orientation: "portrait", orientationPolicy: "strict", limit: 10 },
      state
    );
    const parsed = JSON.parse(ranked.result);
    expect(parsed.targetOrientation).toBe("portrait");
    expect(parsed.ranked.every((entry: any) => entry.shot.assetId === "m1")).toBe(true);
    expect(parsed.ranked[0].shot.sourceOrientation).toBe("portrait");
  });
});
