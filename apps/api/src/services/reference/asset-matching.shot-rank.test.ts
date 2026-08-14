import { describe, expect, it } from "vitest";
import { extractStyleDnaFromBlueprint, rankShots } from "@tempo/editor-core";
import type { EditBlueprint, MediaAsset, ShotIndexEntry } from "@tempo/types";
import { matchAssets, pickBestShotForRole } from "../reference/asset-matching.service.js";

function bp(): EditBlueprint {
  return {
    id: "bp",
    referenceUrl: "https://youtube.com/watch?v=1",
    totalDuration: 10,
    aspectRatio: "9:16",
    segments: [
      {
        index: 0,
        startTime: 0,
        duration: 2,
        shotType: "close-up",
        motionType: "static",
        transitionToNext: "cut",
        energyLevel: 50,
        visualDescription: "face hook",
        colorPalette: ["#000"],
        effects: [],
        textOverlays: [],
        onBeat: true,
        speed: 1,
      },
      {
        index: 1,
        startTime: 2,
        duration: 5,
        shotType: "wide",
        motionType: "zoom-in",
        transitionToNext: "dissolve",
        energyLevel: 95,
        visualDescription: "drop peak",
        colorPalette: [],
        effects: [],
        textOverlays: [],
        onBeat: true,
        speed: 1,
      },
      {
        index: 2,
        startTime: 7,
        duration: 3,
        shotType: "medium",
        motionType: "static",
        transitionToNext: "fade",
        energyLevel: 20,
        visualDescription: "outro",
        colorPalette: [],
        effects: [],
        textOverlays: [],
        onBeat: false,
        speed: 1,
      },
    ],
    audioAnalysis: {
      bpm: 128,
      beats: [],
      energyCurve: [],
      mood: "hype",
      genre: "edm",
    },
    overallStyle: {
      colorGrading: "punchy",
      pacing: "fast",
      mood: "hype",
      genre: "edm",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("ELT shot ranking fixture", () => {
  it("prefers tagged hook-role shot over random long clip", () => {
    const dna = extractStyleDnaFromBlueprint(bp());
    const hookShot: ShotIndexEntry = {
      id: "hook",
      assetId: "a1",
      start: 0,
      end: 2.5,
      tags: ["face", "opening"],
      subjects: ["person"],
      bestFor: ["hook"],
      shotType: "close-up",
      energy: 0.5,
      summary: "face looking at camera hook",
      analyzedAt: "x",
    };
    const longClip: ShotIndexEntry = {
      id: "long",
      assetId: "a2",
      start: 0,
      end: 40,
      tags: ["landscape"],
      subjects: ["trees"],
      bestFor: ["broll"],
      shotType: "wide",
      energy: 0.1,
      summary: "forest trees",
      analyzedAt: "x",
    };

    const best = pickBestShotForRole([longClip, hookShot], "hook", dna);
    expect(best?.shot.id).toBe("hook");

    const ranked = rankShots([longClip, hookShot], "hook", dna);
    expect(ranked[0]!.shot.id).toBe("hook");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("prefers suitable portrait footage for a portrait delivery", async () => {
    const media = (id: string, width: number, height: number, summary: string): MediaAsset => ({
      id,
      projectId: "p1",
      name: `${id}.mp4`,
      type: "video",
      url: `/not-local/${id}.mp4`,
      thumbnailUrl: null,
      proxyUrl: null,
      waveformUrl: null,
      duration: 10,
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        fileSize: 1,
        mimeType: "video/mp4",
        displayWidth: width,
        displayHeight: height,
        analysisStatus: "ready",
        analysis: {
          summary,
          tags: summary.split(" "),
          subjects: [],
          bestFor: ["hook"],
          model: "test",
          analyzedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const vertical = media("vertical", 1080, 1920, "person opening");
    const horizontal = media("horizontal", 1920, 1080, "face hook perfect opening");
    const mappings = await matchAssets(
      [bp().segments[0]!],
      [horizontal, vertical],
      null,
      { targetWidth: 1080, targetHeight: 1920, orientationPolicy: "prefer" }
    );
    expect(mappings[0]?.assetId).toBe("vertical");
  });

  it("creates one independent mapping request per measured composition layer", async () => {
    const segment = {
      ...bp().segments[0]!,
      composition: {
        replaceBase: true,
        layers: [
          { id: "fill", role: "matte-fill" as const, contentDescription: "mountain texture", zIndex: 0, timing: { startRatio: 0, endRatio: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 }, fit: "cover" as const, matteTextOverlayIndex: 0 },
          { id: "tl", role: "panel" as const, contentDescription: "waterfall", zIndex: 1, timing: { startRatio: 0.5, endRatio: 1 }, viewport: { x: 0, y: 0, width: 0.5, height: 0.5 }, fit: "cover" as const },
          { id: "tr", role: "panel" as const, contentDescription: "green mountain", zIndex: 2, timing: { startRatio: 0.5, endRatio: 1 }, viewport: { x: 0.5, y: 0, width: 0.5, height: 0.5 }, fit: "cover" as const },
          { id: "bl", role: "panel" as const, contentDescription: "sunset", zIndex: 3, timing: { startRatio: 0.5, endRatio: 1 }, viewport: { x: 0, y: 0.5, width: 0.5, height: 0.5 }, fit: "cover" as const },
          { id: "br", role: "panel" as const, contentDescription: "clouds", zIndex: 4, timing: { startRatio: 0.5, endRatio: 1 }, viewport: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, fit: "cover" as const },
        ],
      },
    };
    const asset = (id: string): MediaAsset => ({
      id,
      projectId: "p1",
      name: `${id}.mp4`,
      type: "video",
      url: `/not-local/${id}.mp4`,
      thumbnailUrl: null,
      proxyUrl: null,
      waveformUrl: null,
      duration: 20,
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { fileSize: 1, mimeType: "video/mp4", displayWidth: 1920, displayHeight: 1080 },
    });
    const mappings = await matchAssets(
      [segment],
      [asset("a"), asset("b")],
      null,
      { targetWidth: 1920, targetHeight: 1080, orientationPolicy: "prefer" }
    );
    expect(mappings).toHaveLength(5);
    expect(mappings.some((mapping) => !mapping.layerId)).toBe(false);
    expect(mappings.map((mapping) => mapping.layerId)).toEqual(["fill", "tl", "tr", "bl", "br"]);
  });
});
