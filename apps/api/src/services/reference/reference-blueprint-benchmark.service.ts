import type {
  BlueprintMediaLayer,
  BlueprintNormalizedRect,
  BlueprintSegment,
  EditBlueprint,
} from "@tempo/types";
import { readdir, readFile } from "fs/promises";
import path from "path";
import type { PanelRevealDirection } from "./panel-reveal-measurement.service.js";
import { validateBlueprintIntegrity } from "./blueprint-reconciliation.service.js";

export interface ReferenceBlueprintBenchmarkSpec {
  schemaVersion: 1;
  id: string;
  name: string;
  reference: {
    file: string;
    sha256: string;
    sourceUrlContains?: string[];
    width: number;
    height: number;
    fps: number;
    visualDuration: number;
    containerDuration: number;
  };
  segment: { index: number; startTime: number; duration: number; backgroundColor: string };
  typography: {
    states: Array<{ text: string; startTime: number; endTime: number }>;
    fillMode: "solid" | "media-matte";
    fontFamilyHint: string;
    fontWeight: number;
    fontSizeRatio: number;
    strokeWidthRatio: number;
    geometry: BlueprintNormalizedRect;
    zIndex: number;
  };
  panels: Array<{
    id: string;
    viewport: BlueprintNormalizedRect;
    zeroTime: number;
    fullTime: number;
    direction: PanelRevealDirection;
    focalPoint: { x: number; y: number };
    zAboveText: boolean;
    progress: number[];
  }>;
  thresholds: {
    eventTimingFrames: number;
    textTimingFrames: number;
    viewportIoU: number;
    revealProgressMae: number;
    focalPointTolerance: number;
    requireExactTextStates: boolean;
    requireAllDirections: boolean;
    requireAllZRelations: boolean;
    requireMonotonicVisibility: boolean;
  };
  notes?: string[];
}

export interface KnownReferenceBenchmarkResult {
  spec: ReferenceBlueprintBenchmarkSpec;
  report: ReferenceBlueprintBenchmarkReport;
}

export interface BenchmarkIssue {
  code: string;
  category: "structure" | "typography" | "timing" | "composition" | "motion" | "validation";
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ReferenceBlueprintBenchmarkReport {
  benchmarkId: string;
  candidate: { blueprintId: string; provider?: string };
  passed: boolean;
  score: number;
  metrics: {
    exactTextStates: boolean;
    textTimingMaeFrames: number;
    typographyMatches: number;
    matchedPanels: number;
    meanViewportIoU: number;
    panelTimingMaeFrames: number;
    directionAccuracy: number;
    focalPointAccuracy: number;
    zRelationAccuracy: number;
    revealProgressMae: number;
    monotonicPanelCount: number;
    integrityErrors: number;
  };
  issues: BenchmarkIssue[];
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function rectIoU(a: BlueprintNormalizedRect, b: BlueprintNormalizedRect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function centeredRect(rect: BlueprintNormalizedRect): BlueprintNormalizedRect {
  return {
    x: rect.x - rect.width / 2,
    y: rect.y - rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

function easing(name: string | undefined, time: number): number {
  const t = clamp(time);
  if (name === "hold") return 0;
  if (name === "ease-in") return t * t;
  if (name === "ease-out") return 1 - (1 - t) * (1 - t);
  if (name === "ease-in-out") return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t;
}

function valueAt(layer: BlueprintMediaLayer, timeRatio: number, property: keyof BlueprintNormalizedRect): number {
  const keys = (layer.motion?.keyframes || [])
    .filter((keyframe) => keyframe.viewport)
    .sort((a, b) => a.timeRatio - b.timeRatio);
  if (!keys.length) return layer.viewport[property];
  if (timeRatio <= keys[0]!.timeRatio) return keys[0]!.viewport![property];
  if (timeRatio >= keys[keys.length - 1]!.timeRatio) return keys[keys.length - 1]!.viewport![property];
  for (let index = 0; index < keys.length - 1; index++) {
    const previous = keys[index]!;
    const next = keys[index + 1]!;
    if (timeRatio < previous.timeRatio || timeRatio > next.timeRatio) continue;
    const span = Math.max(1e-9, next.timeRatio - previous.timeRatio);
    const amount = easing(next.easing, (timeRatio - previous.timeRatio) / span);
    return previous.viewport![property] + (next.viewport![property] - previous.viewport![property]) * amount;
  }
  return layer.viewport[property];
}

function viewportAt(layer: BlueprintMediaLayer, timeRatio: number): BlueprintNormalizedRect {
  return {
    x: valueAt(layer, timeRatio, "x"),
    y: valueAt(layer, timeRatio, "y"),
    width: valueAt(layer, timeRatio, "width"),
    height: valueAt(layer, timeRatio, "height"),
  };
}

function inferDirection(layer: BlueprintMediaLayer): PanelRevealDirection | undefined {
  const first = layer.motion?.keyframes.find((keyframe) => keyframe.viewport)?.viewport;
  if (!first) return undefined;
  const final = layer.viewport;
  if (final.width - first.width > 0.05) {
    const leftStable = Math.abs(first.x - final.x) <= 0.02;
    const rightStable = Math.abs(first.x + first.width - final.x - final.width) <= 0.02;
    if (leftStable && !rightStable) return "left-to-right";
    if (rightStable && !leftStable) return "right-to-left";
  }
  if (final.height - first.height > 0.05) {
    const topStable = Math.abs(first.y - final.y) <= 0.02;
    const bottomStable = Math.abs(first.y + first.height - final.y - final.height) <= 0.02;
    if (topStable && !bottomStable) return "top-to-bottom";
    if (bottomStable && !topStable) return "bottom-to-top";
  }
  return undefined;
}

function panelProgress(layer: BlueprintMediaLayer, direction: PanelRevealDirection, absoluteTime: number, segment: BlueprintSegment): number {
  const start = segment.startTime + layer.timing.startRatio * segment.duration;
  const lifetime = Math.max(0.001, (layer.timing.endRatio - layer.timing.startRatio) * segment.duration);
  const viewport = viewportAt(layer, clamp((absoluteTime - start) / lifetime));
  return direction === "left-to-right" || direction === "right-to-left"
    ? clamp(viewport.width / layer.viewport.width)
    : clamp(viewport.height / layer.viewport.height);
}

function fullMotionTime(layer: BlueprintMediaLayer, segment: BlueprintSegment): number | undefined {
  const final = layer.viewport;
  const keyframe = (layer.motion?.keyframes || []).find((sample) => sample.viewport &&
    Math.abs(sample.viewport.x - final.x) <= 0.02 &&
    Math.abs(sample.viewport.y - final.y) <= 0.02 &&
    Math.abs(sample.viewport.width - final.width) <= 0.02 &&
    Math.abs(sample.viewport.height - final.height) <= 0.02
  );
  if (!keyframe) return undefined;
  const lifetime = (layer.timing.endRatio - layer.timing.startRatio) * segment.duration;
  return segment.startTime + layer.timing.startRatio * segment.duration + keyframe.timeRatio * lifetime;
}

function nearestPanel(
  layers: readonly BlueprintMediaLayer[],
  expected: BlueprintNormalizedRect,
  used: Set<string>
): BlueprintMediaLayer | undefined {
  return layers
    .filter((layer) => layer.role === "panel" && !used.has(layer.id))
    .map((layer) => ({ layer, iou: rectIoU(layer.viewport, expected) }))
    .sort((a, b) => b.iou - a.iou)[0]?.layer;
}

function mean(values: readonly number[], fallback = 0): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

/** Compare any provider's blueprint against a provider-neutral, measured gold contract. */
export function evaluateReferenceBlueprint(
  candidate: EditBlueprint,
  benchmark: ReferenceBlueprintBenchmarkSpec
): ReferenceBlueprintBenchmarkReport {
  const issues: BenchmarkIssue[] = [];
  const segment = candidate.segments.find((value) => value.index === benchmark.segment.index);
  if (!segment) {
    return {
      benchmarkId: benchmark.id,
      candidate: { blueprintId: candidate.id, provider: candidate.analysisUsage?.model },
      passed: false,
      score: 0,
      metrics: { exactTextStates: false, textTimingMaeFrames: Infinity, typographyMatches: 0, matchedPanels: 0, meanViewportIoU: 0, panelTimingMaeFrames: Infinity, directionAccuracy: 0, focalPointAccuracy: 0, zRelationAccuracy: 0, revealProgressMae: 1, monotonicPanelCount: 0, integrityErrors: 1 },
      issues: [{ code: "SEGMENT_MISSING", category: "structure", message: `Benchmark segment ${benchmark.segment.index} is absent` }],
    };
  }

  const expectedTexts = benchmark.typography.states.map((state) => state.text);
  const actualTexts = segment.textOverlays.map((overlay) => overlay.text);
  const exactTextStates = JSON.stringify(expectedTexts) === JSON.stringify(actualTexts);
  if (!exactTextStates) issues.push({ code: "TEXT_STATES_MISMATCH", category: "typography", message: "Editorial text states differ", expected: expectedTexts, actual: actualTexts });
  const textTimingErrors: number[] = [];
  for (let index = 0; index < benchmark.typography.states.length; index++) {
    const expected = benchmark.typography.states[index]!;
    const actual = segment.textOverlays[index];
    if (!actual?.timing) {
      textTimingErrors.push(benchmark.reference.fps);
      continue;
    }
    textTimingErrors.push(Math.abs(segment.startTime + actual.timing.startRatio * segment.duration - expected.startTime) * benchmark.reference.fps);
    textTimingErrors.push(Math.abs(segment.startTime + actual.timing.endRatio * segment.duration - expected.endTime) * benchmark.reference.fps);
  }
  const textTimingMaeFrames = mean(textTimingErrors, Infinity);
  if (textTimingMaeFrames > benchmark.thresholds.textTimingFrames) issues.push({ code: "TEXT_TIMING_MISMATCH", category: "timing", message: `Text timing MAE is ${textTimingMaeFrames.toFixed(2)} frames`, expected: benchmark.thresholds.textTimingFrames, actual: textTimingMaeFrames });

  const finalText = segment.textOverlays.find((overlay) => overlay.text === benchmark.typography.states.at(-1)?.text);
  const measuredTextRect = finalText?.geometry?.width !== undefined && finalText.geometry.height !== undefined
    ? { x: finalText.geometry.x, y: finalText.geometry.y, width: finalText.geometry.width, height: finalText.geometry.height }
    : undefined;
  const typographyChecks = [
    finalText?.fillMode === benchmark.typography.fillMode,
    finalText?.appearance?.fontFamilyHint?.toLowerCase() === benchmark.typography.fontFamilyHint.toLowerCase(),
    Math.abs((finalText?.appearance?.fontWeight || 0) - benchmark.typography.fontWeight) <= 100,
    Math.abs((finalText?.appearance?.fontSizeRatio || 0) - benchmark.typography.fontSizeRatio) <= 0.02,
    Math.abs((finalText?.appearance?.strokeWidthRatio || 0) - benchmark.typography.strokeWidthRatio) <= 0.005,
    Boolean(measuredTextRect) && rectIoU(
      centeredRect(measuredTextRect!),
      centeredRect(benchmark.typography.geometry)
    ) >= 0.85,
  ];
  const typographyMatches = typographyChecks.filter(Boolean).length / typographyChecks.length;
  if (typographyMatches < 1) issues.push({ code: "TYPOGRAPHY_STYLE_MISMATCH", category: "typography", message: `Only ${typographyChecks.filter(Boolean).length}/${typographyChecks.length} typography properties match` });

  const panelLayers = segment.composition?.layers.filter((layer) => layer.role === "panel") || [];
  const used = new Set<string>();
  const viewportScores: number[] = [];
  const timingErrors: number[] = [];
  const directionScores: number[] = [];
  const focalScores: number[] = [];
  const zScores: number[] = [];
  const trajectoryErrors: number[] = [];
  let monotonicPanelCount = 0;
  for (const expected of benchmark.panels) {
    const layer = nearestPanel(panelLayers, expected.viewport, used);
    if (!layer) {
      issues.push({ code: "PANEL_MISSING", category: "structure", message: `No panel matches ${expected.id}` });
      continue;
    }
    used.add(layer.id);
    const iou = rectIoU(layer.viewport, expected.viewport);
    viewportScores.push(iou);
    if (iou < benchmark.thresholds.viewportIoU) issues.push({ code: "PANEL_VIEWPORT_MISMATCH", category: "composition", message: `${expected.id} viewport IoU is ${iou.toFixed(3)}`, expected: expected.viewport, actual: layer.viewport });
    const zero = segment.startTime + layer.timing.startRatio * segment.duration;
    const full = fullMotionTime(layer, segment);
    timingErrors.push(Math.abs(zero - expected.zeroTime) * benchmark.reference.fps);
    timingErrors.push(full === undefined ? benchmark.reference.fps : Math.abs(full - expected.fullTime) * benchmark.reference.fps);
    const direction = inferDirection(layer);
    directionScores.push(direction === expected.direction ? 1 : 0);
    if (direction !== expected.direction) issues.push({ code: "PANEL_DIRECTION_MISMATCH", category: "motion", message: `${expected.id} reveal direction differs`, expected: expected.direction, actual: direction || "none" });
    const focalError = Math.hypot((layer.focalPoint?.x ?? 0.5) - expected.focalPoint.x, (layer.focalPoint?.y ?? 0.5) - expected.focalPoint.y);
    focalScores.push(focalError <= benchmark.thresholds.focalPointTolerance ? 1 : 0);
    if (focalError > benchmark.thresholds.focalPointTolerance) issues.push({ code: "PANEL_FOCAL_POINT_MISMATCH", category: "motion", message: `${expected.id} crop anchor differs`, expected: expected.focalPoint, actual: layer.focalPoint || { x: 0.5, y: 0.5 } });
    const visibleTextZ = Math.max(benchmark.typography.zIndex, ...((segment.composition?.layers || []).filter((candidateLayer) => candidateLayer.role === "matte-fill").map((candidateLayer) => candidateLayer.zIndex)));
    const zOk = !expected.zAboveText || layer.zIndex > visibleTextZ;
    zScores.push(zOk ? 1 : 0);
    if (!zOk) issues.push({ code: "PANEL_Z_ORDER_MISMATCH", category: "composition", message: `${expected.id} is not above the title composite`, expected: `>${visibleTextZ}`, actual: layer.zIndex });
    const sampled = expected.progress.map((_value, frame) =>
      panelProgress(layer, expected.direction, expected.zeroTime + frame / benchmark.reference.fps, segment)
    );
    trajectoryErrors.push(...sampled.map((value, index) => Math.abs(value - expected.progress[index]!)));
    if (sampled.every((value, index) => index === 0 || value + 0.01 >= sampled[index - 1]!)) monotonicPanelCount++;
  }

  const matchedPanels = used.size;
  const meanViewportIoU = mean(viewportScores);
  const panelTimingMaeFrames = mean(timingErrors, Infinity);
  const directionAccuracy = mean(directionScores);
  const focalPointAccuracy = mean(focalScores);
  const zRelationAccuracy = mean(zScores);
  const revealProgressMae = mean(trajectoryErrors, 1);
  if (panelTimingMaeFrames > benchmark.thresholds.eventTimingFrames) issues.push({ code: "PANEL_TIMING_MISMATCH", category: "timing", message: `Panel timing MAE is ${panelTimingMaeFrames.toFixed(2)} frames`, expected: benchmark.thresholds.eventTimingFrames, actual: panelTimingMaeFrames });
  if (revealProgressMae > benchmark.thresholds.revealProgressMae) issues.push({ code: "PANEL_TRAJECTORY_MISMATCH", category: "motion", message: `Reveal edge MAE is ${revealProgressMae.toFixed(4)}`, expected: benchmark.thresholds.revealProgressMae, actual: revealProgressMae });
  if (monotonicPanelCount !== benchmark.panels.length) issues.push({ code: "NON_MONOTONIC_VISIBILITY", category: "motion", message: `${monotonicPanelCount}/${benchmark.panels.length} panels reveal monotonically` });

  const integrity = validateBlueprintIntegrity(candidate);
  const integrityErrors = integrity.issues.filter((issue) => issue.severity === "error").length;
  for (const issue of integrity.issues.filter((value) => value.severity === "error")) {
    issues.push({ code: issue.code, category: "validation", message: issue.message });
  }

  const weighted = [
    [exactTextStates ? 1 : 0, 15],
    [clamp(1 - textTimingMaeFrames / Math.max(1, benchmark.thresholds.textTimingFrames * 4)), 10],
    [typographyMatches, 10],
    [matchedPanels / benchmark.panels.length, 10],
    [meanViewportIoU, 10],
    [clamp(1 - panelTimingMaeFrames / Math.max(1, benchmark.thresholds.eventTimingFrames * 4)), 10],
    [directionAccuracy, 10],
    [focalPointAccuracy, 5],
    [zRelationAccuracy, 10],
    [clamp(1 - revealProgressMae / Math.max(0.001, benchmark.thresholds.revealProgressMae * 4)), 10],
  ] as const;
  const score = Math.round(weighted.reduce((sum, [value, weight]) => sum + value * weight, 0));
  const passed = exactTextStates &&
    textTimingMaeFrames <= benchmark.thresholds.textTimingFrames &&
    typographyMatches === 1 &&
    matchedPanels === benchmark.panels.length &&
    meanViewportIoU >= benchmark.thresholds.viewportIoU &&
    panelTimingMaeFrames <= benchmark.thresholds.eventTimingFrames &&
    directionAccuracy === 1 &&
    focalPointAccuracy === 1 &&
    zRelationAccuracy === 1 &&
    revealProgressMae <= benchmark.thresholds.revealProgressMae &&
    monotonicPanelCount === benchmark.panels.length &&
    integrityErrors === 0;
  return {
    benchmarkId: benchmark.id,
    candidate: { blueprintId: candidate.id, provider: candidate.analysisUsage?.model },
    passed,
    score,
    metrics: { exactTextStates, textTimingMaeFrames, typographyMatches, matchedPanels, meanViewportIoU, panelTimingMaeFrames, directionAccuracy, focalPointAccuracy, zRelationAccuracy, revealProgressMae, monotonicPanelCount, integrityErrors },
    issues,
  };
}

/**
 * Discover retained benchmark contracts and score matching real reference URLs.
 * Absence of the benchmark directory is non-fatal in packaged deployments.
 */
export async function evaluateKnownReferenceBlueprint(
  candidate: EditBlueprint
): Promise<KnownReferenceBenchmarkResult | undefined> {
  const roots = [
    path.resolve(process.cwd(), "benchmarks/reference-analysis"),
    path.resolve(process.cwd(), "../../benchmarks/reference-analysis"),
  ];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const spec = JSON.parse(
          await readFile(path.join(root, entry, "benchmark.json"), "utf8")
        ) as ReferenceBlueprintBenchmarkSpec;
        const matchers = spec.reference.sourceUrlContains || [];
        if (!matchers.length || !matchers.some((matcher) => candidate.referenceUrl.includes(matcher))) continue;
        return { spec, report: evaluateReferenceBlueprint(candidate, spec) };
      } catch {
        // A malformed optional benchmark must not break unrelated references.
      }
    }
  }
  return undefined;
}
