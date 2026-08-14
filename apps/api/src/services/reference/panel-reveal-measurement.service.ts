import { execFile } from "child_process";
import { promisify } from "util";
import type {
  BlueprintMediaLayer,
  BlueprintNormalizedRect,
  BlueprintSegment,
  EditBlueprint,
} from "@tempo/types";
import { hasGeometryChange } from "./blueprint-reconciliation.service.js";

const exec = promisify(execFile);
const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 180;
const DEFAULT_FPS = 30;
const MAX_KEYFRAMES = 12;

export type PanelRevealDirection = "left-to-right" | "right-to-left" | "top-to-bottom" | "bottom-to-top";

export interface MeasuredPanelReveal {
  direction: PanelRevealDirection;
  startFrame: number;
  endFrame: number;
  progress: number[];
  focalPoint: { x: number; y: number };
  confidence: number;
}

interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pixelRect(rect: BlueprintNormalizedRect, width: number, height: number): PixelRect {
  const x = clamp(Math.round(rect.x * width), 0, width - 1);
  const y = clamp(Math.round(rect.y * height), 0, height - 1);
  return {
    x,
    y,
    width: clamp(Math.round(rect.width * width), 2, width - x),
    height: clamp(Math.round(rect.height * height), 2, height - y),
  };
}

function activeProfile(
  frame: Uint8Array,
  baseline: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  rect: PixelRect,
  axis: "x" | "y"
): boolean[] {
  const length = axis === "x" ? rect.width : rect.height;
  const fullCross = axis === "x" ? rect.height : rect.width;
  // Editorial titles typically straddle the center. Measure panel edges in
  // the outer portion of their final cell so moving glyph footage cannot be
  // mistaken for a reveal approaching from the opposite side.
  const useLeadingOuterBand = axis === "x"
    ? rect.y + rect.height / 2 <= frameHeight / 2
    : rect.x + rect.width / 2 <= frameWidth / 2;
  const cross = Math.max(2, Math.round(fullCross * 0.65));
  const crossStart = useLeadingOuterBand ? 0 : fullCross - cross;
  const raw = new Array<boolean>(length).fill(false);
  for (let coordinate = 0; coordinate < length; coordinate++) {
    let changed = 0;
    let difference = 0;
    for (let offset = 0; offset < cross; offset++) {
      const crossCoordinate = crossStart + offset;
      const x = axis === "x" ? rect.x + coordinate : rect.x + crossCoordinate;
      const y = axis === "x" ? rect.y + crossCoordinate : rect.y + coordinate;
      const index = y * frameWidth + x;
      const delta = Math.abs(frame[index]! - baseline[index]!);
      difference += delta;
      if (delta >= 12) changed++;
    }
    raw[coordinate] = changed / cross >= 0.22 || difference / cross >= 15;
  }
  return raw.map((_value, index) => {
    let votes = 0;
    let count = 0;
    for (let nearby = Math.max(0, index - 2); nearby <= Math.min(length - 1, index + 2); nearby++) {
      if (raw[nearby]) votes++;
      count++;
    }
    return votes >= Math.ceil(count * 0.6);
  });
}

function edgeProgress(profile: boolean[], fromStart: boolean): number {
  const allowedGap = Math.max(2, Math.round(profile.length * 0.025));
  let edge = fromStart ? -1 : profile.length;
  let gap = 0;
  if (fromStart) {
    for (let index = 0; index < profile.length; index++) {
      if (profile[index]) {
        edge = index;
        gap = 0;
      } else if (edge >= 0 && ++gap > allowedGap) {
        break;
      }
    }
    return edge < 0 ? 0 : (edge + 1) / profile.length;
  }
  for (let index = profile.length - 1; index >= 0; index--) {
    if (profile[index]) {
      edge = index;
      gap = 0;
    } else if (edge < profile.length && ++gap > allowedGap) {
      break;
    }
  }
  return edge >= profile.length ? 0 : (profile.length - edge) / profile.length;
}

function directionProgress(
  frame: Uint8Array,
  baseline: Uint8Array,
  frameWidth: number,
  rect: PixelRect,
  direction: PanelRevealDirection
): number {
  const horizontal = direction === "left-to-right" || direction === "right-to-left";
  const frameHeight = Math.floor(frame.length / frameWidth);
  const profile = activeProfile(frame, baseline, frameWidth, frameHeight, rect, horizontal ? "x" : "y");
  return edgeProgress(profile, direction === "left-to-right" || direction === "top-to-bottom");
}

function monotonic(values: readonly number[]): number[] {
  let maximum = 0;
  return values.map((value) => {
    maximum = Math.max(maximum, clamp(value, 0, 1));
    return maximum;
  });
}

function trajectoryScore(values: readonly number[]): number {
  const first = values.findIndex((value) => value >= 0.03);
  const full = values.findIndex((value) => value >= 0.97);
  if (first < 0 || full <= first) return -1_000;
  const interval = values.slice(first, full + 1);
  const intermediate = interval.filter((value) => value > 0.03 && value < 0.97).length;
  const distinct = new Set(interval.map((value) => Math.round(value * 40))).size;
  const movement = interval.reduce((sum, value, index) =>
    index === 0 ? sum : sum + Math.max(0, value - interval[index - 1]!), 0);
  return intermediate * 3 + distinct * 2 + movement * 10 - first * 0.1;
}

function normalizedCorrelation(a: number[], b: number[]): number {
  if (a.length < 8 || a.length !== b.length) return -1;
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < a.length; index++) {
    const av = a[index]! - meanA;
    const bv = b[index]! - meanB;
    numerator += av * bv;
    varianceA += av * av;
    varianceB += bv * bv;
  }
  return numerator / Math.sqrt(Math.max(1e-9, varianceA * varianceB));
}

function rectSamples(frame: Uint8Array, frameWidth: number, rect: PixelRect): number[] {
  const values: number[] = [];
  for (let y = rect.y; y < rect.y + rect.height; y += 2) {
    for (let x = rect.x; x < rect.x + rect.width; x += 2) values.push(frame[y * frameWidth + x]!);
  }
  return values;
}

function measuredFocalPoint(
  frames: readonly Uint8Array[],
  frameWidth: number,
  rect: PixelRect,
  direction: PanelRevealDirection,
  startFrame: number,
  endFrame: number,
  progress: readonly number[]
): { x: number; y: number } {
  let sampleOffset = 1;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < progress.length - 1; index++) {
    const next = Math.abs(progress[index]! - 0.42);
    if (next < distance) {
      distance = next;
      sampleOffset = index;
    }
  }
  const frame = frames[startFrame + sampleOffset];
  const final = frames[endFrame];
  if (!frame || !final) return { x: 0.5, y: 0.5 };
  const amount = clamp(progress[sampleOffset] || 0.42, 0.1, 0.9);
  const horizontal = direction === "left-to-right" || direction === "right-to-left";
  if (horizontal) {
    const width = clamp(Math.round(rect.width * amount), 2, rect.width);
    const current = direction === "left-to-right"
      ? { ...rect, width }
      : { ...rect, x: rect.x + rect.width - width, width };
    const left = { ...rect, width };
    const right = { ...rect, x: rect.x + rect.width - width, width };
    const currentSamples = rectSamples(frame, frameWidth, current);
    const leftScore = normalizedCorrelation(currentSamples, rectSamples(final, frameWidth, left));
    const rightScore = normalizedCorrelation(currentSamples, rectSamples(final, frameWidth, right));
    return { x: rightScore > leftScore + 0.08 ? 1 : leftScore > rightScore + 0.08 ? 0 : 0.5, y: 0.5 };
  }
  const height = clamp(Math.round(rect.height * amount), 2, rect.height);
  const current = direction === "top-to-bottom"
    ? { ...rect, height }
    : { ...rect, y: rect.y + rect.height - height, height };
  const top = { ...rect, height };
  const bottom = { ...rect, y: rect.y + rect.height - height, height };
  const currentSamples = rectSamples(frame, frameWidth, current);
  const topScore = normalizedCorrelation(currentSamples, rectSamples(final, frameWidth, top));
  const bottomScore = normalizedCorrelation(currentSamples, rectSamples(final, frameWidth, bottom));
  return { x: 0.5, y: bottomScore > topScore + 0.08 ? 1 : topScore > bottomScore + 0.08 ? 0 : 0.5 };
}

/** Measure an anchored, monotonic panel expansion from decoded gray frames. */
export function measurePanelRevealFromFrames(input: {
  frames: readonly Uint8Array[];
  width: number;
  height: number;
  viewport: BlueprintNormalizedRect;
  searchStartFrame: number;
  searchEndFrame: number;
}): MeasuredPanelReveal | undefined {
  const start = clamp(input.searchStartFrame, 0, input.frames.length - 2);
  const end = clamp(input.searchEndFrame, start + 1, input.frames.length - 1);
  const baseline = input.frames[start];
  if (!baseline) return undefined;
  const rect = pixelRect(input.viewport, input.width, input.height);
  const directions: PanelRevealDirection[] = ["left-to-right", "right-to-left", "top-to-bottom", "bottom-to-top"];
  let selected: { direction: PanelRevealDirection; values: number[]; score: number } | undefined;
  for (const direction of directions) {
    const values = monotonic(input.frames.slice(start, end + 1).map((frame) =>
      directionProgress(frame, baseline, input.width, rect, direction)
    ));
    const score = trajectoryScore(values);
    if (!selected || score > selected.score) selected = { direction, values, score };
  }
  if (!selected || selected.score < 10) return undefined;
  const first = selected.values.findIndex((value) => value >= 0.03);
  const full = selected.values.findIndex((value) => value >= 0.97);
  if (first < 0 || full <= first) return undefined;
  const startFrame = Math.max(start, start + first - 1);
  const endFrame = start + full;
  const offset = startFrame - start;
  const progress = monotonic(selected.values.slice(offset, full + 1));
  progress[0] = 0;
  progress[progress.length - 1] = 1;
  const focalPoint = measuredFocalPoint(
    input.frames,
    input.width,
    rect,
    selected.direction,
    startFrame,
    endFrame,
    progress
  );
  const intermediate = progress.filter((value) => value > 0.05 && value < 0.95).length;
  return {
    direction: selected.direction,
    startFrame,
    endFrame,
    progress,
    focalPoint,
    confidence: clamp(0.65 + intermediate * 0.025, 0.65, 0.97),
  };
}

function viewportAtProgress(
  finalViewport: BlueprintNormalizedRect,
  direction: PanelRevealDirection,
  progress: number
): BlueprintNormalizedRect {
  const amount = clamp(progress, 0.002, 1);
  if (direction === "left-to-right") return { ...finalViewport, width: finalViewport.width * amount };
  if (direction === "right-to-left") {
    const width = finalViewport.width * amount;
    return { ...finalViewport, x: finalViewport.x + finalViewport.width - width, width };
  }
  if (direction === "top-to-bottom") return { ...finalViewport, height: finalViewport.height * amount };
  const height = finalViewport.height * amount;
  return { ...finalViewport, y: finalViewport.y + finalViewport.height - height, height };
}

function sampledOffsets(length: number): number[] {
  const count = Math.min(MAX_KEYFRAMES, length);
  return [...new Set(Array.from({ length: count }, (_value, index) =>
    Math.round(index * (length - 1) / Math.max(1, count - 1))
  ))];
}

async function decodeGraySegment(
  videoPath: string,
  segment: BlueprintSegment,
  fps: number,
  signal?: AbortSignal
): Promise<Uint8Array[]> {
  const { stdout } = await exec("ffmpeg", [
    "-v", "error",
    "-i", videoPath,
    "-ss", String(segment.startTime),
    "-t", String(segment.duration),
    "-an",
    "-vf", `fps=${fps},scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT}:flags=area`,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, signal });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const frameSize = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
  const count = Math.floor(bytes.length / frameSize);
  return Array.from({ length: count }, (_value, index) =>
    new Uint8Array(bytes.buffer, bytes.byteOffset + index * frameSize, frameSize)
  );
}

function nextMeasuredBoundary(
  blueprint: EditBlueprint,
  segment: BlueprintSegment,
  localStart: number,
  fallback: number
): number {
  const events = blueprint.analysisEvidence?.scenes
    .find((scene) => scene.sceneIndex === segment.index)?.eventTimes || [];
  const next = events
    .map((time) => time - segment.startTime)
    .filter((time) => time > localStart + 0.08)
    .sort((a, b) => a - b)[0];
  return next ?? fallback;
}

function withMeasuredMotion(
  layer: BlueprintMediaLayer,
  measurement: MeasuredPanelReveal,
  segmentDuration: number,
  fps: number
): BlueprintMediaLayer {
  const startLocal = measurement.startFrame / fps;
  const endLocal = measurement.endFrame / fps;
  const endRatio = layer.timing.endRatio;
  const startRatio = clamp(startLocal / segmentDuration, 0, endRatio - 0.001);
  const lifetime = Math.max(0.01, (endRatio - startRatio) * segmentDuration);
  const offsets = sampledOffsets(measurement.progress.length);
  const keyframes = offsets.map((offset) => ({
    timeRatio: clamp((startLocal + offset / fps - startLocal) / lifetime, 0, 1),
    viewport: viewportAtProgress(layer.viewport, measurement.direction, measurement.progress[offset]!),
    opacity: 1,
    easing: "linear" as const,
  }));
  keyframes[0]!.viewport = viewportAtProgress(layer.viewport, measurement.direction, 0);
  keyframes[keyframes.length - 1]!.viewport = { ...layer.viewport };
  return {
    ...layer,
    timing: { ...layer.timing, startRatio },
    focalPoint: measurement.focalPoint,
    motion: { keyframes, confidence: measurement.confidence },
  };
}

/**
 * Reconcile every multi-panel entrance against locally measured edge tracks.
 * The provider owns scene/layer semantics; pixels own geometry and time. A
 * changing provider trajectory is not treated as correct merely because it is
 * non-static: when local evidence is available it replaces provider geometry.
 */
export async function reconcileMeasuredPanelReveals(
  videoPath: string,
  blueprint: EditBlueprint,
  options: { signal?: AbortSignal; fps?: number } = {}
): Promise<{ blueprint: EditBlueprint; warnings: string[] }> {
  const fps = clamp(Math.round(options.fps || DEFAULT_FPS), 24, 60);
  const warnings: string[] = [];
  const segments = [...blueprint.segments];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!;
    const composition = segment.composition;
    const panels = composition?.layers
      .filter((layer) => layer.role === "panel" && layer.timing.startRatio > 0.01)
      .sort((a, b) => a.timing.startRatio - b.timing.startRatio) || [];
    if (panels.length < 2 || !composition) continue;
    const frames = await decodeGraySegment(videoPath, segment, fps, options.signal);
    if (frames.length < 3) continue;
    const replacements = new Map<string, BlueprintMediaLayer>();
    const completionRatios = new Map<string, number>();
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
      const panel = panels[panelIndex]!;
      const approximate = panel.timing.startRatio * segment.duration;
      const nextPanel = panels[panelIndex + 1];
      const fallbackEnd = nextPanel
        ? nextPanel.timing.startRatio * segment.duration + 0.12
        : approximate + 0.9;
      const boundary = nextMeasuredBoundary(blueprint, segment, approximate, fallbackEnd);
      const measurement = measurePanelRevealFromFrames({
        frames,
        width: ANALYSIS_WIDTH,
        height: ANALYSIS_HEIGHT,
        viewport: panel.viewport,
        searchStartFrame: Math.max(0, Math.round(approximate * fps) - 3),
        searchEndFrame: Math.min(frames.length - 1, Math.round((boundary + 0.1) * fps)),
      });
      if (!measurement) {
        warnings.push(
          `PANEL_REVEAL_MEASUREMENT_SKIPPED: scene ${segment.index} layer ${panel.id} ` +
          `window ${Math.max(0, approximate - 3 / fps).toFixed(3)}-${Math.min(segment.duration, boundary + 0.1).toFixed(3)}s ` +
          `providerGeometry=${hasGeometryChange(panel) ? "changing" : "static"}`
        );
        continue;
      }
      replacements.set(panel.id, withMeasuredMotion(panel, measurement, segment.duration, fps));
      completionRatios.set(panel.id, clamp((measurement.endFrame / fps) / segment.duration, 0, 1));
      warnings.push(
        `MEASURED_PANEL_REVEAL: scene ${segment.index} layer ${panel.id} ${measurement.direction} ` +
        `${(measurement.startFrame / fps).toFixed(3)}-${(measurement.endFrame / fps).toFixed(3)}s ` +
        `focal(${measurement.focalPoint.x.toFixed(1)},${measurement.focalPoint.y.toFixed(1)})`
      );
    }
    if (!replacements.size) continue;
    const textEndRatios = new Map<number, number>();
    const matteEndRatios = new Map<string, number>();
    const phases = composition.phases?.flatMap((phase, phaseIndex, source) => {
      const previousText = source[phaseIndex - 1]?.activeTextOverlayIndices || [];
      const explicitOcclusion = /(?:cover|occlud).*(?:text|title|word|letter|glyph)|(?:text|title|word|letter|glyph).*(?:cover|occlud)/i.test(phase.label);
      const inferredText = phase.activeTextOverlayIndices.length === 0 ? previousText : [];
      const inferredOcclusion = inferredText.some((overlayIndex) => {
        const overlay = segment.textOverlays[overlayIndex];
        const matte = composition.layers.find((layer) =>
          layer.role === "matte-fill" && layer.matteTextOverlayIndex === overlayIndex
        );
        const textZ = Math.max(overlay?.zIndex ?? -100, matte?.zIndex ?? -100);
        return phase.activeLayerIds.some((id) => {
          const panel = composition.layers.find((layer) => layer.id === id);
          return panel?.role === "panel" && completionRatios.has(id) && panel.zIndex > textZ;
        });
      });
      if (!explicitOcclusion && !inferredOcclusion) {
        return [{ ...phase }];
      }
      const activeTextOverlayIndices = phase.activeTextOverlayIndices.length
        ? phase.activeTextOverlayIndices
        : inferredText;
      const completion = phase.activeLayerIds
        .map((id) => completionRatios.get(id))
        .filter((value): value is number => value !== undefined && value > phase.startRatio && value < phase.endRatio - 0.005)
        .sort((a, b) => b - a)[0];
      if (completion === undefined || activeTextOverlayIndices.length === 0) return [{ ...phase }];
      const matteIds = activeTextOverlayIndices.flatMap((overlayIndex) => {
        textEndRatios.set(overlayIndex, completion);
        const matte = composition.layers.find((layer) =>
          layer.role === "matte-fill" && layer.matteTextOverlayIndex === overlayIndex
        );
        if (matte) matteEndRatios.set(matte.id, completion);
        return matte ? [matte.id] : [];
      });
      if (inferredOcclusion) {
        warnings.push(`INFERRED_PANEL_TEXT_OCCLUSION: scene ${segment.index} phase ${phase.id}`);
      }
      warnings.push(`SPLIT_FULL_OCCLUSION_HOLD: scene ${segment.index} phase ${phase.id} at ${(completion * segment.duration).toFixed(3)}s`);
      return [
        {
          ...phase,
          endRatio: completion,
          activeLayerIds: [...new Set([...phase.activeLayerIds, ...matteIds])],
          activeTextOverlayIndices,
        },
        {
          ...phase,
          id: `${phase.id}-occluded-hold`,
          label: "Completed foreground grid hold",
          startRatio: completion,
          activeLayerIds: phase.activeLayerIds.filter((id) => !matteIds.includes(id)),
          activeTextOverlayIndices: [],
        },
      ];
    });
    const textOverlays = segment.textOverlays.map((overlay, overlayIndex) => {
      const endRatio = textEndRatios.get(overlayIndex);
      return endRatio === undefined || !overlay.timing
        ? overlay
        : { ...overlay, timing: { ...overlay.timing, endRatio } };
    });
    segments[segmentIndex] = {
      ...segment,
      textOverlays,
      composition: {
        ...composition,
        layers: composition.layers.map((layer) => {
          const replacement = replacements.get(layer.id) || layer;
          const endRatio = matteEndRatios.get(layer.id);
          return endRatio === undefined
            ? replacement
            : { ...replacement, timing: { ...replacement.timing, endRatio } };
        }),
        ...(phases ? { phases } : {}),
      },
    };
  }
  return { blueprint: { ...blueprint, segments }, warnings };
}
