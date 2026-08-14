import { describe, expect, it } from "vitest";
import type { BlueprintSegment, EditBlueprint } from "@tempo/types";
import {
  reconcileBlueprintSemantics,
  reconcileSampledFallbackBlueprint,
  validateBlueprintIntegrity,
} from "./blueprint-reconciliation.service.js";

const segment = (patch: Partial<BlueprintSegment> = {}): BlueprintSegment => ({
  index: 0,
  startTime: 0,
  duration: 4,
  shotType: "wide",
  motionType: "static",
  transitionToNext: "cut",
  energyLevel: 50,
  visualDescription: "animated panel collage",
  colorPalette: ["#000000"],
  effects: [],
  textOverlays: [],
  onBeat: false,
  speed: 1,
  ...patch,
});

describe("reference blueprint integrity", () => {
  it("rejects media-filled text without a deterministic matte layer", () => {
    const report = validateBlueprintIntegrity({ segments: [segment({
      textOverlays: [{
        text: "MOUNTAIN", style: "kinetic", position: "center", animation: "reveal",
        fillMode: "media-matte", geometry: { x: 0.5, y: 0.5, height: 0.15 },
        appearance: { fontSizeRatio: 0.15 },
      }],
    })] });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("MATTE_FILL_REQUIRED");
  });

  it("rejects appearing panels with no geometry trajectory", () => {
    const report = validateBlueprintIntegrity({ segments: [segment({
      composition: {
        replaceBase: true,
        layers: [{
          id: "panel", role: "panel", contentDescription: "panel enters from right", zIndex: 2,
          timing: { startRatio: 0.5, endRatio: 1 }, viewport: { x: 0.5, y: 0, width: 0.5, height: 1 }, fit: "cover",
        }],
      },
    })] });
    expect(report.issues.map((issue) => issue.code)).toContain("PANEL_MOTION_REQUIRED");
  });

  it("does not mistake two omitted properties for measured motion", () => {
    const report = validateBlueprintIntegrity({ segments: [segment({
      composition: {
        replaceBase: true,
        layers: [{
          id: "panel", role: "panel", contentDescription: "panel reveals", zIndex: 2,
          timing: { startRatio: 0.5, endRatio: 1 }, viewport: { x: 0, y: 0, width: 0.5, height: 1 }, fit: "cover",
          motion: { keyframes: [
            { timeRatio: 0, viewport: { x: 0, y: 0, width: 0.5, height: 1 } },
            { timeRatio: 1, viewport: { x: 0, y: 0, width: 0.5, height: 1 } },
          ] },
        }],
      },
    })] });
    expect(report.issues.map((issue) => issue.code)).toContain("PANEL_MOTION_REQUIRED");
  });

  it("rejects a media matte whose visual depth contradicts its text", () => {
    const report = validateBlueprintIntegrity({ segments: [segment({
      textOverlays: [{
        text: "MOUNTAIN", style: "bold", position: "center", animation: "static",
        fillMode: "media-matte", zIndex: 1, appearance: { fontSizeRatio: 0.16 },
        geometry: { x: 0.5, y: 0.5, width: 0.56, height: 0.18 },
        timing: { startRatio: 0, endRatio: 1 },
      }],
      composition: {
        replaceBase: true,
        layers: [{
          id: "matte", role: "matte-fill", contentDescription: "mountain texture", zIndex: 5,
          timing: { startRatio: 0, endRatio: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 }, fit: "cover",
          matteTextOverlayIndex: 0,
        }],
      },
    })] });
    expect(report.issues.map((issue) => issue.code)).toContain("MATTE_Z_MISMATCH");
  });

  it("normalizes matte depth and preserves text during an explicit covering phase", () => {
    const candidate = {
      id: "semantic-repair", referenceUrl: "fixture", totalDuration: 4, aspectRatio: "16:9",
      segments: [segment({
        textOverlays: [{
          text: "MOUNTAIN", style: "bold", position: "center", animation: "static",
          fillMode: "media-matte", zIndex: 1, appearance: { fontSizeRatio: 0.16 },
          geometry: { x: 0.5, y: 0.5, width: 0.56, height: 0.18 },
          timing: { startRatio: 0, endRatio: 0.5 },
        }],
        composition: {
          replaceBase: true,
          layers: [
            { id: "matte", role: "matte-fill", contentDescription: "mountain texture", zIndex: 5, timing: { startRatio: 0, endRatio: 0.5 }, viewport: { x: 0, y: 0, width: 1, height: 1 }, fit: "cover", matteTextOverlayIndex: 0 },
            { id: "panel", role: "panel", contentDescription: "panel", zIndex: 1, timing: { startRatio: 0.5, endRatio: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 }, fit: "cover", motion: { keyframes: [{ timeRatio: 0, viewport: { x: 0, y: 0, width: 0.01, height: 1 } }, { timeRatio: 0.2, viewport: { x: 0, y: 0, width: 1, height: 1 } }] } },
          ],
          phases: [
            { id: "title", label: "title", startRatio: 0, endRatio: 0.5, activeLayerIds: ["matte"], activeTextOverlayIndices: [0] },
            { id: "cover", label: "panel fully covering underlying title text", startRatio: 0.5, endRatio: 1, activeLayerIds: ["panel"], activeTextOverlayIndices: [] },
          ],
        },
      })],
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "unknown", genre: "unknown" },
      overallStyle: { colorGrading: "neutral", pacing: "moderate" as const, mood: "unknown", genre: "unknown" },
      createdAt: "2026-08-14T00:00:00.000Z",
    } satisfies EditBlueprint;
    const reconciled = reconcileBlueprintSemantics(candidate);
    const scene = reconciled.blueprint.segments[0]!;
    expect(scene.composition?.layers.find((layer) => layer.id === "matte")?.zIndex).toBe(1);
    expect(scene.composition?.layers.find((layer) => layer.id === "panel")?.zIndex).toBe(2);
    expect(scene.composition?.phases?.[1]?.activeTextOverlayIndices).toEqual([0]);
    expect(scene.textOverlays[0]?.timing?.endRatio).toBe(1);
    expect(validateBlueprintIntegrity(reconciled.blueprint).ok).toBe(true);
  });

  it("rejects a font-width guess that contradicts measured glyph geometry", () => {
    const candidate = {
      id: "font-geometry", referenceUrl: "fixture", totalDuration: 4, aspectRatio: "16:9",
      referenceWidth: 1916, referenceHeight: 1078,
      segments: [segment({
        textOverlays: [{
          text: "MOUNTAIN", style: "bold", position: "center", animation: "static",
          appearance: {
            fontFamilyClass: "display", fontFamilyHint: "Anton", fontWidth: "condensed",
            fontWeight: 800, fontSizeRatio: 0.18,
          },
          geometry: { x: 0.5, y: 0.5, width: 0.51, height: 0.18 },
        }],
      })],
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "unknown", genre: "unknown" },
      overallStyle: { colorGrading: "neutral", pacing: "moderate" as const, mood: "unknown", genre: "unknown" },
      createdAt: "2026-08-14T00:00:00.000Z",
    } satisfies EditBlueprint;
    const reconciled = reconcileBlueprintSemantics(candidate);
    expect(reconciled.blueprint.segments[0]!.textOverlays[0]!.appearance).toMatchObject({
      fontFamilyHint: "Archivo Black",
      fontWidth: "wide",
    });
    expect(reconciled.warnings.some((warning) => warning.startsWith("NORMALIZED_FONT_GEOMETRY"))).toBe(true);
  });

  it("converts cumulative text boxes from top-left evidence into center coordinates", () => {
    const candidate = {
      id: "text-origin", referenceUrl: "fixture", totalDuration: 4, aspectRatio: "16:9",
      segments: [segment({
        textOverlays: [
          ["M", 0.45, 0.1],
          ["MOU", 0.38, 0.24],
          ["MOUNTAIN", 0.24, 0.51],
        ].map(([text, x, width]) => ({
          text: String(text), style: "bold" as const, position: "center" as const, animation: "static",
          appearance: {
            fontFamilyClass: "display" as const, fontFamilyHint: "Anton", fontWidth: "condensed" as const,
            fontWeight: 800, fontSizeRatio: 0.18,
          },
          geometry: { x: Number(x), y: 0.4, width: Number(width), height: 0.18 },
        })),
      })],
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "unknown", genre: "unknown" },
      overallStyle: { colorGrading: "neutral", pacing: "moderate" as const, mood: "unknown", genre: "unknown" },
      createdAt: "2026-08-14T00:00:00.000Z",
    } satisfies EditBlueprint;
    const reconciled = reconcileBlueprintSemantics(candidate);
    const final = reconciled.blueprint.segments[0]!.textOverlays.at(-1)!;
    expect(final.geometry?.x).toBeCloseTo(0.495, 3);
    expect(final.geometry?.y).toBeCloseTo(0.49, 3);
    expect(reconciled.blueprint.segments[0]!.textOverlays[0]!.appearance?.fontFamilyHint).toBe("Archivo Black");
    expect(reconciled.warnings.some((warning) => warning.startsWith("NORMALIZED_TEXT_BOX_ORIGIN"))).toBe(true);
  });

  it("canonicalizes typography for the same title persisting across a chunk boundary", () => {
    const candidate = {
      id: "boundary-title", referenceUrl: "fixture", totalDuration: 8, aspectRatio: "16:9",
      segments: [
        segment({
          index: 0,
          textOverlays: [{
            text: "ESCAPE", style: "bold", position: "center", animation: "static",
            timing: { startRatio: 0.5, endRatio: 1 },
            appearance: { fontFamilyHint: "Anton", fontWeight: 700, fontSizeRatio: 0.15, color: "#FFFFFF", confidence: 0.6 },
          }],
        }),
        segment({
          index: 1, startTime: 4,
          textOverlays: [{
            text: "ESCAPE", style: "minimal", position: "center", animation: "static",
            timing: { startRatio: 0, endRatio: 0.4 },
            appearance: { fontFamilyHint: "Bebas Neue", fontWeight: 800, fontSizeRatio: 0.15, color: "#F8F8F8", confidence: 0.95 },
          }],
        }),
      ],
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "unknown", genre: "unknown" },
      overallStyle: { colorGrading: "neutral", pacing: "moderate" as const, mood: "unknown", genre: "unknown" },
      createdAt: "2026-08-16T00:00:00.000Z",
    } satisfies EditBlueprint;
    const reconciled = reconcileBlueprintSemantics(candidate);
    expect(reconciled.blueprint.segments[0]!.textOverlays[0]).toMatchObject({
      style: "minimal",
      appearance: { fontFamilyHint: "Bebas Neue", fontWeight: 800, color: "#F8F8F8" },
    });
    expect(reconciled.warnings.some((warning) => warning.startsWith("NORMALIZED_BOUNDARY_TYPOGRAPHY"))).toBe(true);
  });

  it("uses local component evidence to reject a flattened three-panel phase", () => {
    const blueprint = {
      segments: [segment({
        composition: {
          replaceBase: true,
          layers: [0, 1, 2].map((index) => ({
            id: `panel-${index}`, role: "panel" as const, contentDescription: "static panel", zIndex: index,
            timing: { startRatio: 0, endRatio: 1 }, viewport: { x: index / 3, y: 0, width: 1 / 3, height: 1 }, fit: "cover" as const,
            motion: { keyframes: [
              { timeRatio: 0, opacity: 0 }, { timeRatio: 0.1, opacity: 1 },
            ] },
          })),
          phases: [{ id: "final", label: "final", startRatio: 0, endRatio: 1, activeLayerIds: ["panel-0", "panel-1", "panel-2"], activeTextOverlayIndices: [] }],
        },
      })],
      analysisEvidence: {
        schemaVersion: 1, provider: "tempo-local-cv", analysisFps: 12, width: 192, height: 108,
        scenes: [{ sceneIndex: 0, startTime: 0, endTime: 4, frames: [], eventTimes: [], maxVisibleComponents: 4 }],
      },
    } satisfies Pick<EditBlueprint, "segments" | "analysisEvidence">;
    expect(validateBlueprintIntegrity(blueprint).issues.map((issue) => issue.code))
      .toContain("VISIBLE_LAYER_COUNT_MISMATCH");
  });

  it("reconciles sampled-frame panels and invalid mattes without inventing motion", () => {
    const fallback = {
      id: "fallback",
      referenceUrl: "https://example.com/reference",
      totalDuration: 6,
      aspectRatio: "16:9",
      segments: [segment({
        duration: 6,
        textOverlays: [],
        composition: {
          replaceBase: true,
          layers: [
            ...[0, 1, 2, 3].map((index) => ({
              id: `panel-${index}`,
              role: "panel" as const,
              contentDescription: "panel appears in a four image grid",
              zIndex: index,
              timing: { startRatio: 0.4 + index * 0.05, endRatio: 1 },
              viewport: { x: (index % 2) * 0.5, y: Math.floor(index / 2) * 0.5, width: 0.5, height: 0.5 },
              fit: "cover" as const,
            })),
            {
              id: "bad-matte",
              role: "matte-fill" as const,
              contentDescription: "unverified matte",
              zIndex: 5,
              timing: { startRatio: 0, endRatio: 1 },
              viewport: { x: 0, y: 0, width: 1, height: 1 },
              fit: "cover" as const,
              matteTextOverlayIndex: 7,
            },
          ],
        },
      })],
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "unknown", genre: "unknown" },
      overallStyle: { colorGrading: "neutral", pacing: "moderate" as const, mood: "unknown", genre: "unknown" },
      createdAt: "2026-08-14T00:00:00.000Z",
    } satisfies EditBlueprint;

    const reconciled = reconcileSampledFallbackBlueprint(fallback);
    const scene = reconciled.blueprint.segments[0]!;
    expect(scene.composition?.layers.map((layer) => layer.id)).not.toContain("bad-matte");
    expect(scene.composition?.phases?.length).toBeGreaterThan(1);
    expect(scene.composition?.layers.every((layer) => !layer.motion)).toBe(true);
    expect(reconciled.warnings.some((warning) => warning.includes("DROPPED_INVALID_MATTE"))).toBe(true);

    const report = validateBlueprintIntegrity(reconciled.blueprint, {
      allowDegradedMeasurements: true,
    });
    expect(report.ok).toBe(true);
    expect(report.issues.some((issue) =>
      issue.code === "PANEL_MOTION_REQUIRED" && issue.severity === "warning"
    )).toBe(true);
  });

  it("keeps missing panel motion fatal outside sampled-frame fallback mode", () => {
    const candidate = {
      segments: [segment({
        composition: {
          replaceBase: true,
          layers: [{
            id: "panel",
            role: "panel",
            contentDescription: "panel enters",
            zIndex: 0,
            timing: { startRatio: 0.5, endRatio: 1 },
            viewport: { x: 0, y: 0, width: 1, height: 1 },
            fit: "cover",
          }],
          phases: [{ id: "phase", label: "visible", startRatio: 0.5, endRatio: 1, activeLayerIds: ["panel"], activeTextOverlayIndices: [] }],
        },
      })],
    } satisfies Pick<EditBlueprint, "segments">;
    expect(validateBlueprintIntegrity(candidate).ok).toBe(false);
  });
});
