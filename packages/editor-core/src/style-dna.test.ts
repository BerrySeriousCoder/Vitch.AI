import { describe, expect, it } from "vitest";
import type { EditBlueprint, ShotIndexEntry, Track } from "@tempo/types";
import {
  extractStyleDnaFromBlueprint,
  rankShots,
  scoreShotForRole,
  applyStyleDnaHints,
} from "./style-dna";
import { shotsFromAssets, filterShots, syntheticShotFromAnalysis } from "./shot-index";

function minimalBlueprint(overrides: Partial<EditBlueprint> = {}): EditBlueprint {
  return {
    id: "bp-1",
    referenceUrl: "https://youtube.com/watch?v=x",
    totalDuration: 12,
    aspectRatio: "9:16",
    segments: [
      {
        index: 0,
        startTime: 0,
        duration: 2,
        shotType: "close-up",
        motionType: "static",
        transitionToNext: "cut",
        energyLevel: 40,
        visualDescription: "face hook opening",
        colorPalette: ["#111111", "#ffaa00"],
        effects: [],
        textOverlays: [
          {
            text: "WAIT",
            style: "bold",
            position: "center",
            animation: "scale-up",
          },
        ],
        onBeat: true,
        speed: 1,
      },
      {
        index: 1,
        startTime: 2,
        duration: 4,
        shotType: "wide",
        motionType: "zoom-in",
        transitionToNext: "dissolve",
        energyLevel: 90,
        visualDescription: "party drop peak",
        colorPalette: ["#220022"],
        effects: [],
        textOverlays: [],
        onBeat: true,
        speed: 1,
      },
      {
        index: 2,
        startTime: 6,
        duration: 6,
        shotType: "medium",
        motionType: "pan",
        transitionToNext: "fade",
        energyLevel: 30,
        visualDescription: "outro product",
        colorPalette: [],
        effects: [],
        textOverlays: [],
        onBeat: false,
        speed: 1,
      },
    ],
    audioAnalysis: {
      bpm: 120,
      beats: [],
      energyCurve: [],
      mood: "energetic",
      genre: "edm",
    },
    overallStyle: {
      colorGrading: "warm punchy",
      pacing: "fast",
      mood: "hype",
      genre: "edm",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("extractStyleDnaFromBlueprint", () => {
  it("maps pacing, palette, transitions, and narrative roles", () => {
    const dna = extractStyleDnaFromBlueprint(minimalBlueprint());
    expect(dna.source).toBe("reference");
    expect(dna.derivedFromBlueprintId).toBe("bp-1");
    expect(dna.pacing.label).toBe("fast");
    expect(dna.pacing.avgShotSec).toBeCloseTo(4, 0);
    expect(dna.color.palette).toContain("#ffaa00");
    expect(dna.transitions.vocabulary).toEqual(
      expect.arrayContaining(["dissolve", "fade"])
    );
    expect(dna.typography.animationHints).toContain("scale-up");
    const roles = dna.narrativeRoles.map((r) => r.role);
    expect(roles).toContain("hook");
    expect(roles).toContain("drop");
    expect(roles).toContain("outro");
    expect(dna.audio.bpm).toBe(120);
    expect(dna.audio.beatCutBias).toBe(true);
  });
});

describe("rankShots / scoreShotForRole", () => {
  const hookShot: ShotIndexEntry = {
    id: "s1",
    assetId: "a1",
    start: 0,
    end: 2,
    tags: ["face", "hook"],
    subjects: ["person"],
    shotType: "close-up",
    bestFor: ["hook", "opening"],
    energy: 0.5,
    summary: "face looking at camera",
    analyzedAt: "2026-01-01T00:00:00.000Z",
  };
  const longBroll: ShotIndexEntry = {
    id: "s2",
    assetId: "a2",
    start: 0,
    end: 30,
    tags: ["landscape"],
    subjects: ["trees"],
    shotType: "wide",
    bestFor: ["broll"],
    energy: 0.2,
    summary: "forest trees",
    analyzedAt: "2026-01-01T00:00:00.000Z",
  };

  it("prefers tagged hook shot over random long clip for hook role", () => {
    const dna = extractStyleDnaFromBlueprint(minimalBlueprint());
    const ranked = rankShots([longBroll, hookShot], "hook", dna);
    expect(ranked[0]!.shot.id).toBe("s1");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("scores bestFor role match", () => {
    const { score, reasons } = scoreShotForRole(hookShot, "hook", null);
    expect(score).toBeGreaterThan(20);
    expect(reasons.some((r) => r.includes("bestFor"))).toBe(true);
  });
});

describe("applyStyleDnaHints", () => {
  it("adds contrast/saturate when clip has no color FX", () => {
    const dna = extractStyleDnaFromBlueprint(minimalBlueprint());
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
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
            effects: [],
            keyframes: [],
            blendMode: "normal",
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
    const out = applyStyleDnaHints(tracks, dna);
    const fx = out[0]!.clips[0]!.effects.map((e) => e.type);
    expect(fx).toEqual(expect.arrayContaining(["contrast", "saturate"]));
  });

  it("skips clips that already have color FX", () => {
    const dna = extractStyleDnaFromBlueprint(minimalBlueprint());
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
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
            effects: [
              {
                id: "e1",
                type: "brightness",
                name: "Brightness",
                enabled: true,
                params: { value: 0.1 },
                keyframes: [],
              },
            ],
            keyframes: [],
            blendMode: "normal",
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
    const out = applyStyleDnaHints(tracks, dna);
    expect(out[0]!.clips[0]!.effects).toHaveLength(1);
  });

  it("scopes reference style hints to explicit generated clip ids", () => {
    const dna = extractStyleDnaFromBlueprint(minimalBlueprint());
    const base = {
      id: "generated",
      trackId: "t1",
      sourceMediaId: "m1",
      startTime: 0,
      duration: 2,
      sourceOffset: 0,
      speed: 1,
      opacity: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      effects: [],
      keyframes: [],
      blendMode: "normal" as const,
      mask: null,
      muted: false,
      volume: 1,
    };
    const tracks: Track[] = [{
      id: "t1",
      name: "V1",
      type: "video",
      clips: [base, { ...base, id: "user", startTime: 2 }],
      order: 0,
      locked: false,
      visible: true,
      solo: false,
    }];
    const out = applyStyleDnaHints(tracks, dna, { clipIds: ["generated"] });
    expect(out[0]!.clips.find((clip) => clip.id === "generated")!.effects.length).toBeGreaterThan(0);
    expect(out[0]!.clips.find((clip) => clip.id === "user")!.effects).toEqual([]);
  });
});

describe("shot-index helpers", () => {
  it("builds synthetic shot from analysis", () => {
    const shot = syntheticShotFromAnalysis({
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
        analysis: {
          summary: "beach",
          tags: ["ocean"],
          subjects: [],
          bestFor: ["broll"],
          model: "test",
          analyzedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(shot?.end).toBe(10);
    expect(shot?.tags).toContain("ocean");
  });

  it("filterShots by tag", () => {
    const shots: ShotIndexEntry[] = [
      {
        id: "1",
        assetId: "a",
        start: 0,
        end: 1,
        tags: ["hook"],
        subjects: [],
        bestFor: [],
        analyzedAt: "x",
      },
      {
        id: "2",
        assetId: "a",
        start: 1,
        end: 2,
        tags: ["outro"],
        subjects: [],
        bestFor: [],
        analyzedAt: "x",
      },
    ];
    expect(filterShots(shots, { tags: ["hook"] })).toHaveLength(1);
  });

  it("shotsFromAssets prefers shotIndex", () => {
    const assets = [
      {
        id: "m1",
        projectId: "p",
        name: "v",
        type: "video" as const,
        url: "/u",
        thumbnailUrl: null,
        proxyUrl: null,
        waveformUrl: null,
        duration: 5,
        metadata: {
          fileSize: 1,
          mimeType: "video/mp4",
          shotIndex: {
            schemaVersion: 1 as const,
            model: "t",
            analyzedAt: "x",
            shots: [
              {
                id: "s1",
                assetId: "m1",
                start: 0,
                end: 2,
                tags: [],
                subjects: [],
                bestFor: [],
                analyzedAt: "x",
              },
            ],
          },
        },
        status: "ready" as const,
        createdAt: "x",
      },
    ];
    expect(shotsFromAssets(assets)).toHaveLength(1);
    expect(shotsFromAssets(assets)[0]!.id).toBe("s1");
  });
});
