import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { EditBlueprint, MediaAsset, ProjectSettings } from "@tempo/types";
import {
  evaluateKnownReferenceBlueprint,
  evaluateReferenceBlueprint,
  type ReferenceBlueprintBenchmarkSpec,
} from "./reference-blueprint-benchmark.service.js";
import { reconcileMeasuredPanelReveals } from "./panel-reveal-measurement.service.js";
import { compileRecreationDraft } from "./recreation-compiler.service.js";
import type { AssetMapping } from "./asset-matching.service.js";

function benchmarkPath(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), "benchmarks/reference-analysis/mountain-grid-v1", name),
    path.resolve(process.cwd(), "../../benchmarks/reference-analysis/mountain-grid-v1", name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0]!;
}

async function fixture<T>(name: string): Promise<T> {
  const candidates = [
    path.resolve(process.cwd(), "benchmarks/reference-analysis/mountain-grid-v1", name),
    path.resolve(process.cwd(), "../../benchmarks/reference-analysis/mountain-grid-v1", name),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8")) as T;
    } catch {
      // Try the package-local working directory layout.
    }
  }
  throw new Error(`Benchmark fixture ${name} was not found`);
}

describe("provider-neutral reference blueprint benchmark", () => {
  it("accepts the reviewed mountain-grid gold blueprint", async () => {
    const spec = await fixture<ReferenceBlueprintBenchmarkSpec>("benchmark.json");
    const gold = await fixture<EditBlueprint>("gold-blueprint.json");
    const report = evaluateReferenceBlueprint(gold, spec);
    expect(report.passed, JSON.stringify(report.issues, null, 2)).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(98);
    expect(report.metrics.directionAccuracy).toBe(1);
    expect(report.metrics.zRelationAccuracy).toBe(1);
  });

  it("automatically gates a real URL that belongs to a retained benchmark", async () => {
    const gold = structuredClone(await fixture<EditBlueprint>("gold-blueprint.json"));
    gold.referenceUrl = "https://www.instagram.com/reel/Db3wQtRhrj0/";
    const known = await evaluateKnownReferenceBlueprint(gold);
    expect(known?.spec.id).toBe("mountain-grid-v1");
    expect(known?.report.passed).toBe(true);
  });

  it("identifies the degenerate motion and inverted matte depth seen in the provider regression", async () => {
    const spec = await fixture<ReferenceBlueprintBenchmarkSpec>("benchmark.json");
    const candidate = structuredClone(await fixture<EditBlueprint>("gold-blueprint.json"));
    const scene = candidate.segments[0]!;
    for (const layer of scene.composition!.layers) {
      if (layer.role === "matte-fill") layer.zIndex = layer.matteTextOverlayIndex || 0;
      if (layer.role !== "panel") continue;
      layer.focalPoint = { x: 0.5, y: 0.5 };
      layer.motion = { keyframes: [
        { timeRatio: 0, viewport: { ...layer.viewport }, easing: "hold" },
        { timeRatio: 1, viewport: { ...layer.viewport }, easing: "hold" },
      ] };
    }
    scene.textOverlays.at(-1)!.timing!.endRatio = 0.824;
    const report = evaluateReferenceBlueprint(candidate, spec);
    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "PANEL_DIRECTION_MISMATCH",
      "PANEL_TRAJECTORY_MISMATCH",
      "PANEL_Z_ORDER_MISMATCH",
      "PANEL_MOTION_REQUIRED",
      "MATTE_Z_MISMATCH",
    ]));
  });

  it("recovers the four real reveal trajectories from retained reference pixels", async () => {
    const spec = await fixture<ReferenceBlueprintBenchmarkSpec>("benchmark.json");
    const candidate = structuredClone(await fixture<EditBlueprint>("gold-blueprint.json"));
    for (const layer of candidate.segments[0]!.composition!.layers) {
      if (layer.role !== "panel") continue;
      layer.focalPoint = { x: 0.5, y: 0.5 };
      layer.motion = { keyframes: [
        { timeRatio: 0, viewport: { ...layer.viewport }, easing: "hold" },
        { timeRatio: 1, viewport: { ...layer.viewport }, easing: "hold" },
      ] };
    }
    const reconciled = await reconcileMeasuredPanelReveals(
      benchmarkPath("reference.mp4"),
      candidate,
      { fps: spec.reference.fps }
    );
    const report = evaluateReferenceBlueprint(reconciled.blueprint, spec);
    expect(reconciled.warnings.filter((warning) => warning.startsWith("MEASURED_PANEL_REVEAL"))).toHaveLength(4);
    expect(report.metrics.directionAccuracy, JSON.stringify({ warnings: reconciled.warnings, issues: report.issues }, null, 2)).toBe(1);
    expect(report.metrics.focalPointAccuracy, JSON.stringify({ warnings: reconciled.warnings, issues: report.issues }, null, 2)).toBe(1);
    expect(report.metrics.panelTimingMaeFrames).toBeLessThanOrEqual(1);
    expect(report.metrics.revealProgressMae).toBeLessThanOrEqual(spec.thresholds.revealProgressMae);
  });

  it("overrides plausible but incorrect provider motion with stronger local evidence", async () => {
    const spec = await fixture<ReferenceBlueprintBenchmarkSpec>("benchmark.json");
    const candidate = structuredClone(await fixture<EditBlueprint>("gold-blueprint.json"));
    const panels = candidate.segments[0]!.composition!.layers.filter((layer) => layer.role === "panel");
    for (const [index, layer] of panels.entries()) {
      layer.focalPoint = { x: 0.5, y: 0.5 };
      layer.motion = index < 2
        ? { keyframes: [
            { timeRatio: 0, viewport: { ...layer.viewport }, easing: "hold" },
            { timeRatio: 1, viewport: { ...layer.viewport }, easing: "hold" },
          ] }
        : { keyframes: [
            {
              timeRatio: 0,
              viewport: {
                ...layer.viewport,
                x: layer.viewport.x + layer.viewport.width / 2,
                width: layer.viewport.width / 2,
              },
              easing: "ease-out",
            },
            { timeRatio: 0.15, viewport: { ...layer.viewport }, easing: "hold" },
            { timeRatio: 1, viewport: { ...layer.viewport }, easing: "hold" },
          ] };
    }
    const scene = candidate.segments[0]!;
    const finalPhase = scene.composition!.phases!.find((phase) => phase.id === "phase-panel-bl")!;
    finalPhase.label = "Bottom-left panel enters and completes 2x2 grid";
    finalPhase.endRatio = 1;
    finalPhase.activeTextOverlayIndices = [];
    finalPhase.activeLayerIds = finalPhase.activeLayerIds.filter((id) => id !== "matte-mountain");
    scene.composition!.phases = scene.composition!.phases!.filter((phase) => phase.id !== "phase-grid-hold");
    scene.textOverlays.at(-1)!.timing!.endRatio = finalPhase.startRatio;
    scene.composition!.layers.find((layer) => layer.id === "matte-mountain")!.timing.endRatio = finalPhase.startRatio;

    const reconciled = await reconcileMeasuredPanelReveals(
      benchmarkPath("reference.mp4"),
      candidate,
      { fps: spec.reference.fps }
    );
    const report = evaluateReferenceBlueprint(reconciled.blueprint, spec);
    expect(reconciled.warnings.filter((warning) => warning.startsWith("MEASURED_PANEL_REVEAL"))).toHaveLength(4);
    expect(report.metrics.directionAccuracy).toBe(1);
    expect(report.metrics.focalPointAccuracy).toBe(1);
    expect(report.metrics.revealProgressMae).toBeLessThanOrEqual(spec.thresholds.revealProgressMae);
    expect(reconciled.warnings.some((warning) => warning.startsWith("INFERRED_PANEL_TEXT_OCCLUSION"))).toBe(true);
    expect(reconciled.blueprint.segments[0]!.textOverlays.at(-1)!.timing!.endRatio * scene.duration)
      .toBeCloseTo(5.667, 2);
  });

  it("materializes the gold blueprint without losing depth, motion, anchors, or title lifetime", async () => {
    const spec = await fixture<ReferenceBlueprintBenchmarkSpec>("benchmark.json");
    const gold = await fixture<EditBlueprint>("gold-blueprint.json");
    const source = (id: string): MediaAsset => ({
      id,
      projectId: "benchmark-project",
      name: `${id}.mp4`,
      type: "video",
      url: `/benchmark/${id}.mp4`,
      thumbnailUrl: null,
      proxyUrl: null,
      waveformUrl: null,
      duration: 20,
      status: "ready",
      metadata: { fileSize: 1, mimeType: "video/mp4", width: 1916, height: 1078 },
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    const assets = [source("mountain-a"), source("mountain-b")];
    const layers = gold.segments[0]!.composition!.layers;
    const mappings: AssetMapping[] = layers.map((layer, index) => ({
      segmentIndex: 0,
      layerId: layer.id,
      role: layer.role,
      assetId: assets[index % assets.length]!.id,
      assetName: assets[index % assets.length]!.name,
      inPoint: 0,
      duration: gold.totalDuration,
      confidence: 1,
    }));
    const settings: ProjectSettings = {
      width: 1916,
      height: 1078,
      fps: spec.reference.fps,
      duration: 0,
      backgroundColor: "#000000",
      sampleRate: 44100,
    };
    const draft = await compileRecreationDraft(
      { id: "benchmark-project", name: "mountain-grid-v1", settings, tracks: [] },
      assets,
      gold,
      mappings
    );
    const trackFor = (clipId: string) => draft.state.tracks.find((track) =>
      track.clips.some((clip) => clip.id === clipId)
    )!;
    const compiledLayers = draft.state.tracks.flatMap((track) => track.clips)
      .filter((clip) => clip.referenceEditBinding?.kind === "composition-layer");
    const title = draft.state.tracks.flatMap((track) => track.clips).find((clip) =>
      clip.referenceEditBinding?.kind === "text-overlay" &&
      clip.referenceEditBinding.overlayIndex === 5
    )!;
    const matte = compiledLayers.find((clip) => clip.referenceEditBinding?.layerId === "matte-mountain")!;
    expect(title.startTime + title.duration).toBeCloseTo(5.667, 2);
    expect(matte.startTime + matte.duration).toBeCloseTo(5.667, 2);
    for (const expected of spec.panels) {
      const clip = compiledLayers.find((candidate) => candidate.referenceEditBinding?.layerId === expected.id)!;
      expect(clip.mediaLayout?.focalPoint).toEqual(expected.focalPoint);
      expect(clip.keyframes.filter((keyframe) => keyframe.property.startsWith("mediaLayout.viewport.")).length).toBeGreaterThan(8);
      expect(clip.keyframes.some((keyframe) => keyframe.property === "opacity" && Number(keyframe.value) === 0)).toBe(false);
      expect(trackFor(clip.id).order).toBeGreaterThan(trackFor(matte.id).order);
    }
  });
});
