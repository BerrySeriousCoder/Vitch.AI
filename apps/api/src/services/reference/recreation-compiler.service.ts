import type {
  AudioMixer,
  BlueprintSegment,
  Clip,
  EditBlueprint,
  EditLikeThisAudioPolicy,
  GraphicLayout,
  MediaAsset,
  ProjectSettings,
  ReferenceEditBinding,
  StyleDNA,
  Track,
  Transition,
} from "@tempo/types";
import {
  estimateTextBounds,
  reflowTracksForComposition,
  resolveDeliveryProfile,
  resolveGraphicGeometry,
  validateGraphicGeometry,
  validateTimeline,
  matchGoogleFontFamily,
  googleFontId,
  fontFamilyCss,
  getTransitionType,
  interpolateValue,
} from "@tempo/editor-core";
import {
  createProjectState,
  getToolExecutor,
  type ProjectState,
} from "../ai/tools/index.js";
import type { AssetMapping } from "./asset-matching.service.js";
import { adaptTextOverlaysForDelivery } from "./reference-layout-adaptation.service.js";

export interface RecreationProjectContext {
  id: string;
  name: string;
  settings: ProjectSettings;
  tracks: Track[];
  transitions?: Transition[];
  sequences?: import("@tempo/types").Sequence[];
  cameras?: import("@tempo/types").Camera3D[];
  lights?: import("@tempo/types").Light3D[];
  markers?: import("@tempo/types").TimelineMarker[];
  brandKit?: import("@tempo/types").BrandKit | null;
  graphicTemplates?: import("@tempo/types").GraphicTemplate[];
  audioMixer?: AudioMixer;
  editBlueprint?: EditBlueprint | null;
  styleDna?: StyleDNA | null;
  editPlan?: import("@tempo/types").EditPlan | null;
  styleDnaLibrary?: ProjectState["styleDnaLibrary"];
}

export interface RecreationManifestEntry {
  clipId: string;
  binding: ReferenceEditBinding;
}

export interface RecreationManifest {
  schemaVersion: 1;
  blueprintId: string;
  videoTrackId: string;
  textTrackId?: string;
  musicTrackId?: string;
  audioPolicy: EditLikeThisAudioPolicy;
  soundtrackAssetId?: string;
  entries: RecreationManifestEntry[];
  createdAt: string;
}

export interface RecreationAudioOptions {
  policy: EditLikeThisAudioPolicy;
  /** Resolved project asset used for reference or uploaded soundtrack modes. */
  soundtrackAssetId?: string;
}

export interface RecreationDraft {
  state: ProjectState;
  settings: ProjectSettings;
  manifest: RecreationManifest;
  warnings: string[];
}

export interface RecreationConformanceIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  clipId?: string;
  segmentIndex?: number;
}

export interface RecreationConformanceReport {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: RecreationConformanceIssue[];
  checkedSegments: number;
  checkedTextOverlays: number;
}

const MIN_SPEED = 0.25;
const MAX_SPEED = 4;
const EPSILON = 0.04;

function assetDuration(asset: MediaAsset): number | undefined {
  const value = asset.duration ?? asset.metadata?.duration;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Edit Like This copies creative structure, never the delivery contract.
 * Dimensions/profile are explicit user choices and must not mutate merely
 * because a reference has a different raster or platform URL.
 */
export function settingsForReference(
  current: ProjectSettings,
  blueprint: EditBlueprint
): ProjectSettings {
  const selectedProfile = resolveDeliveryProfile(current);
  return {
    ...current,
    duration: Math.max(current.duration || 0, blueprint.totalDuration),
    deliveryProfile: { ...selectedProfile, fps: current.fps },
  };
}

function resultPayload(result: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(result);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  state: ProjectState,
  required = true
): Promise<Record<string, unknown> | null> {
  const executor = getToolExecutor(name);
  if (!executor) throw new Error(`Recreation compiler tool ${name} is unavailable`);
  const response = await Promise.resolve(executor(args, state));
  const payload = resultPayload(response.result);
  const failed = /^Error\b/i.test(response.result) || payload?.ok === false;
  if (failed && required) {
    throw new Error(
      `Recreation compiler ${name} failed: ${String(payload?.error || payload?.message || response.result)}`
    );
  }
  return failed ? null : payload;
}

function findClip(state: ProjectState, clipId: string): Clip {
  const clip = state.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
  if (!clip) throw new Error(`Recreation compiler lost generated clip ${clipId}`);
  return clip;
}

function boundedGeometry(
  overlay: BlueprintSegment["textOverlays"][number]
): GraphicLayout {
  const geometry = overlay.geometry;
  if (
    geometry && Number.isFinite(geometry.x) && Number.isFinite(geometry.y) &&
    geometry.x >= 0 && geometry.x <= 1 && geometry.y >= 0 && geometry.y <= 1
  ) {
    return {
      schemaVersion: 1,
      mode: "normalized",
      x: geometry.x,
      y: geometry.y,
      ...(geometry.width && geometry.width > 0 ? { width: Math.min(1, geometry.width) } : {}),
      ...(geometry.height && geometry.height > 0 ? { height: Math.min(1, geometry.height) } : {}),
      safety: "title",
      overflow: "clamp",
      source: "import",
    };
  }
  return {
    schemaVersion: 1,
    mode: "zone",
    zone: overlay.position === "bottom" ? "lower-third" : overlay.position === "top" ? "top" : "center",
    alignX: "center",
    alignY: "center",
    widthRatio: 0.9,
    safety: "title",
    overflow: "clamp",
    source: "import",
  };
}

function animationPreset(animation: string | undefined): string | null {
  const key = String(animation || "none").toLowerCase();
  if (key === "none" || key === "static") return null;
  if (key === "slide-up") return "slide-in-up";
  if (["fade-in", "slide-in-up", "slide-in-left", "scale-up", "bounce", "glitch"].includes(key)) return key;
  return null;
}

function textFontSelection(appearance: BlueprintSegment["textOverlays"][number]["appearance"]): {
  fontId: string;
  fontFamily: string;
} {
  const family = matchGoogleFontFamily({
    hint: appearance?.fontFamilyHint,
    category: appearance?.fontFamilyClass,
    width: appearance?.fontWidth,
    role: "title",
  });
  return { fontId: googleFontId(family), fontFamily: fontFamilyCss(family) };
}

/** Fit glyphs to measured reference geometry when the model omitted font size. */
export function inferredTextFontSize(
  overlay: BlueprintSegment["textOverlays"][number],
  settings: Pick<ProjectSettings, "width" | "height">
): number {
  const explicit = overlay.appearance?.fontSizeRatio;
  if (explicit) return Math.max(16, Math.round(settings.height * explicit));
  const text = (overlay.appearance?.uppercase ? overlay.text.toUpperCase() : overlay.text).trim();
  const geometry = overlay.geometry;
  // Canvas font size is close to line box height; width fitting uses a
  // conservative average glyph advance and lets measured height cap it.
  const fromHeight = geometry?.height ? geometry.height * settings.height * 0.9 : Number.POSITIVE_INFINITY;
  const widthClass = overlay.appearance?.fontWidth;
  const averageAdvance = widthClass === "condensed" ? 0.48 : widthClass === "wide" ? 0.72 : 0.6;
  const fromWidth = geometry?.width && text.length
    ? geometry.width * settings.width / Math.max(1, text.length * averageAdvance)
    : Number.POSITIVE_INFINITY;
  const measured = Math.min(fromHeight, fromWidth);
  if (Number.isFinite(measured)) return Math.max(16, Math.round(measured));
  return Math.max(16, Math.round(settings.height * (overlay.style === "bold" ? 0.055 : 0.043)));
}

function effectiveTextZIndex(segment: BlueprintSegment, overlayIndex: number): number {
  const overlay = segment.textOverlays[overlayIndex]!;
  if (overlay.zIndex !== undefined) return overlay.zIndex;
  const matte = segment.composition?.layers.find((layer) =>
    layer.role === "matte-fill" && layer.matteTextOverlayIndex === overlayIndex
  );
  return matte?.zIndex ?? 50;
}

function colorWithOpacity(color: string, opacity: number): string {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return color;
  return `rgba(${parseInt(match[1]!, 16)}, ${parseInt(match[2]!, 16)}, ${parseInt(match[3]!, 16)}, ${opacity})`;
}

function transitionType(value: BlueprintSegment["transitionToNext"]): string | null {
  if (value === "cut" || value === "none") return null;
  if (value === "fade" || value === "dissolve") return "crossfade";
  if (value === "zoom") return "zoom-smash";
  if (value === "swipe") return "wipe";
  if (value === "whip") return "whip";
  if (value === "glitch") return "glitch";
  return null;
}

function impactTime(blueprint: EditBlueprint, id: string | undefined): number | undefined {
  if (!id) return undefined;
  return blueprint.audioAnalysis.impacts?.find((impact) => impact.id === id)?.time;
}

function phaseRange(
  _segment: BlueprintSegment,
  phase: NonNullable<NonNullable<BlueprintSegment["composition"]>["phases"]>[number],
  _blueprint: EditBlueprint
): { startRatio: number; endRatio: number } {
  // Phase ratios describe continuous layer lifetime. Audio anchors are useful
  // for authoring/analysis provenance, but must never move one side of a
  // visibility interval independently and create compiler-generated flicker.
  // Motion keyframes still resolve their own syncEventIds exactly.
  return {
    startRatio: Math.max(0, Math.min(1, phase.startRatio)),
    endRatio: Math.max(0, Math.min(1, phase.endRatio)),
  };
}

function effectiveLayerTiming(
  segment: BlueprintSegment,
  layer: NonNullable<BlueprintSegment["composition"]>["layers"][number],
  blueprint: EditBlueprint
): { startRatio: number; endRatio: number } {
  const phases = (segment.composition?.phases || []).filter((phase) => phase.activeLayerIds.includes(layer.id));
  if (!phases.length) return layer.timing;
  const ranges = phases.map((phase) => phaseRange(segment, phase, blueprint));
  return {
    startRatio: Math.max(0, Math.min(layer.timing.startRatio, ...ranges.map((range) => range.startRatio))),
    endRatio: Math.min(1, Math.max(layer.timing.endRatio, ...ranges.map((range) => range.endRatio))),
  };
}

function effectiveTextTiming(
  segment: BlueprintSegment,
  overlayIndex: number,
  blueprint: EditBlueprint
): { startRatio: number; endRatio: number } {
  const overlay = segment.textOverlays[overlayIndex]!;
  const phases = (segment.composition?.phases || []).filter((phase) =>
    phase.activeTextOverlayIndices.includes(overlayIndex)
  );
  const base = { startRatio: overlay.timing?.startRatio ?? 0, endRatio: overlay.timing?.endRatio ?? 1 };
  if (!phases.length || overlay.sequenceMode === "exclusive") return base;
  const ranges = phases.map((phase) => phaseRange(segment, phase, blueprint));
  return {
    // A phase describes whether an overlay may be visible; its authored timing
    // remains the authority for when the overlay enters. Moving the start back
    // to the beginning of a broad phase turns word-by-word captions into a pile
    // of full-scene clips. Non-exclusive titles may persist through a later
    // phase, but they must never appear before their measured entrance.
    startRatio: Math.max(0, base.startRatio),
    endRatio: Math.min(1, Math.max(base.endRatio, ...ranges.map((range) => range.endRatio))),
  };
}

/**
 * Materialize explicit phase membership as stepped opacity states. This keeps a
 * layer alive across overlapping phases without pretending that it was visible
 * in every gap between its first and last appearance.
 */
async function applyPhaseVisibility(
  clipId: string,
  segment: BlueprintSegment,
  isActive: (phase: NonNullable<NonNullable<BlueprintSegment["composition"]>["phases"]>[number]) => boolean,
  clipStartTime: number,
  clipDuration: number,
  blueprint: EditBlueprint,
  state: ProjectState
): Promise<void> {
  const phases = segment.composition?.phases;
  if (!phases?.length) return;
  const ranged = phases.map((phase) => ({ phase, ...phaseRange(segment, phase, blueprint) }));
  const localBoundaries = new Set<number>([0]);
  for (const range of ranged) {
    for (const ratio of [range.startRatio, range.endRatio]) {
      const time = segment.startTime + ratio * segment.duration - clipStartTime;
      if (time > 0.0005 && time < clipDuration - 0.0005) localBoundaries.add(time);
    }
  }
  const activeAt = (localTime: number) => {
    const absolute = clipStartTime + Math.min(clipDuration, localTime + 0.0001);
    const ratio = (absolute - segment.startTime) / segment.duration;
    return ranged.some((range) =>
      isActive(range.phase) && ratio >= range.startRatio - 0.0001 && ratio < range.endRatio - 0.0001
    );
  };
  const clip = findClip(state, clipId);
  const originalOpacity = clip.keyframes
    .filter((keyframe) => keyframe.property === "opacity")
    .sort((a, b) => a.time - b.time);
  for (const keyframe of originalOpacity) localBoundaries.add(keyframe.time);
  const sampleOriginalOpacity = (time: number): number => {
    if (!originalOpacity.length) return clip.opacity;
    const sampled = interpolateValue(originalOpacity, time, "opacity");
    return typeof sampled === "number" && Number.isFinite(sampled) ? sampled : clip.opacity;
  };
  const orderedTimes = [...localBoundaries].sort((a, b) => a - b);
  if (orderedTimes.every((time) => activeAt(time))) return;
  clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.property !== "opacity");
  let previousActive: boolean | undefined;
  for (const time of orderedTimes) {
    const active = activeAt(time);
    const original = originalOpacity.find((keyframe) => Math.abs(keyframe.time - time) < 0.0005);
    if (previousActive === active && !original) continue;
    await executeTool("add_keyframe", {
      clipId,
      property: "opacity",
      time: Math.max(0, Math.min(clipDuration, time)),
      value: active ? sampleOriginalOpacity(time) : 0,
      easing: previousActive === active && original ? original.easing : "hold",
      ...(previousActive === active && original?.bezierHandles
        ? { bezierHandles: original.bezierHandles }
        : {}),
    }, state);
    previousActive = active;
  }
}

async function applyMeasuredMotion(
  clipId: string,
  motion: NonNullable<BlueprintSegment["composition"]>["layers"][number]["motion"] | undefined,
  duration: number,
  settings: ProjectSettings,
  state: ProjectState,
  timeWindow: { start: number; duration: number } = { start: 0, duration },
  sync?: { blueprint: EditBlueprint; clipStartTime: number }
): Promise<void> {
  if (!motion?.keyframes.length) return;
  for (const sample of motion.keyframes) {
    const anchored = sync ? impactTime(sync.blueprint, sample.syncEventId) : undefined;
    const time = Math.max(0, Math.min(duration,
      anchored === undefined
        ? timeWindow.start + sample.timeRatio * timeWindow.duration
        : anchored - sync!.clipStartTime
    ));
    const easing = sample.easing || "linear";
    const values: Array<[string, number]> = [];
    if (sample.viewport) {
      values.push(
        ["mediaLayout.viewport.x", sample.viewport.x],
        ["mediaLayout.viewport.y", sample.viewport.y],
        ["mediaLayout.viewport.width", sample.viewport.width],
        ["mediaLayout.viewport.height", sample.viewport.height]
      );
    }
    if (sample.opacity !== undefined) values.push(["opacity", sample.opacity]);
    if (sample.offsetXRatio !== undefined) values.push(["transform.x", sample.offsetXRatio * settings.width]);
    if (sample.offsetYRatio !== undefined) values.push(["transform.y", sample.offsetYRatio * settings.height]);
    if (sample.scaleX !== undefined) values.push(["transform.scaleX", sample.scaleX]);
    if (sample.scaleY !== undefined) values.push(["transform.scaleY", sample.scaleY]);
    if (sample.rotation !== undefined) values.push(["transform.rotation", sample.rotation]);
    for (const [property, value] of values) {
      await executeTool("add_keyframe", { clipId, property, time, value, easing }, state);
    }
  }
}

async function applyMeasuredTextAnimation(
  clipId: string,
  overlay: BlueprintSegment["textOverlays"][number],
  duration: number,
  settings: ProjectSettings,
  state: ProjectState,
  blueprint: EditBlueprint,
  clipStartTime: number,
  animationWindow: { start: number; duration: number } = { start: 0, duration }
): Promise<boolean> {
  const recipe = overlay.animationSpec;
  if (!recipe?.channels.length) return false;
  await executeTool("set_text_animators", {
    clipId,
    split: recipe.unit === "whole" ? "none" : recipe.unit,
    animators: recipe.channels.map((channel) => ({
      property: channel.property,
      from: channel.from,
      to: channel.to,
      offsetSec: animationWindow.start + channel.offsetRatio * animationWindow.duration,
      durationSec: Math.max(0.01, channel.durationRatio * animationWindow.duration),
      staggerSec: channel.staggerRatio * animationWindow.duration,
      ...(channel.unitSyncEventIds?.length
        ? (() => {
            const resolved = channel.unitSyncEventIds.map((id) => impactTime(blueprint, id));
            return resolved.every((time): time is number => time !== undefined)
              ? { unitStartTimes: resolved.map((time) => Math.max(0, time - clipStartTime)) }
              : {};
          })()
        : channel.unitStartRatios?.length
          ? { unitStartTimes: channel.unitStartRatios.map((ratio) => animationWindow.start + ratio * animationWindow.duration) }
          : {}),
      ...(channel.keyframes && channel.keyframes.length >= 2
        ? { valueKeyframes: channel.keyframes.map((keyframe) => ({ timeSec: keyframe.timeRatio * animationWindow.duration, value: keyframe.value, easing: keyframe.easing || "linear" })) }
        : {}),
      ease: channel.easing || "linear",
    })),
  }, state);
  await applyMeasuredMotion(clipId, recipe.motion, duration, settings, state, animationWindow, { blueprint, clipStartTime });
  return true;
}

const DEFAULT_AUDIO_POLICY: EditLikeThisAudioPolicy = {
  soundtrack: "none",
  sourceAudio: "keep",
  soundtrackVolume: 0.85,
  sourceVolume: 1,
  duckLevel: 0.25,
};

function usableSpeed(
  asset: MediaAsset,
  mapping: AssetMapping,
  segment: BlueprintSegment
): { speed: number; sourceOffset: number; warning?: string } {
  if (asset.type === "image") return { speed: 1, sourceOffset: 0 };
  const duration = assetDuration(asset);
  if (!duration) throw new Error(`Media ${asset.name} has no known duration; source bounds cannot be validated`);
  const requested = Math.max(MIN_SPEED, Math.min(MAX_SPEED, Number(segment.speed) || 1));
  const sourceOffset = Math.max(0, Math.min(mapping.inPoint, duration));
  const available = Math.max(0, duration - sourceOffset);
  if (available + EPSILON >= segment.duration * requested) return { speed: requested, sourceOffset };
  const adjusted = available / segment.duration;
  if (adjusted < MIN_SPEED - EPSILON) {
    throw new Error(
      `Mapped media ${asset.name} has only ${available.toFixed(2)}s after its in-point; segment ${segment.index} needs at least ${(segment.duration * MIN_SPEED).toFixed(2)}s even at ${MIN_SPEED}x`
    );
  }
  const speed = Math.max(MIN_SPEED, Math.min(requested, adjusted));
  return {
    speed,
    sourceOffset,
    warning: `Segment ${segment.index} speed changed from ${requested.toFixed(2)}x to ${speed.toFixed(2)}x to stay inside ${asset.name}`,
  };
}

/**
 * Deterministically builds the reference cut before the creative model runs.
 * The agent receives concrete clip IDs and may polish, but cannot be the only
 * mechanism responsible for assembling the requested timeline.
 */
export async function compileRecreationDraft(
  project: RecreationProjectContext,
  mediaAssets: MediaAsset[],
  blueprint: EditBlueprint,
  mappings: AssetMapping[],
  audioOptions?: RecreationAudioOptions
): Promise<RecreationDraft> {
  const audioPolicy = audioOptions?.policy || DEFAULT_AUDIO_POLICY;
  const settings = settingsForReference(project.settings, blueprint);
  const formatChanged = settings.width !== project.settings.width || settings.height !== project.settings.height;
  const adaptedTracks = formatChanged
    ? reflowTracksForComposition(project.tracks, project.settings, settings)
    : project.tracks;
  const state = createProjectState(adaptedTracks, project.audioMixer, {
    settings,
    editBlueprint: blueprint,
    styleDna: project.styleDna ?? null,
    mediaAssets,
    projectId: project.id,
    transitions: project.transitions || [],
    sequences: project.sequences || [],
    cameras: project.cameras || [],
    lights: project.lights || [],
    markers: project.markers || [],
    brandKit: project.brandKit ?? null,
    graphicTemplates: project.graphicTemplates || [],
    editPlan: project.editPlan ?? null,
    styleDnaLibrary: project.styleDnaLibrary || [],
    beatTimes: blueprint.audioAnalysis.beats.map((beat) => beat.time),
  });
  const warnings: string[] = [];
  const deliveryTextBySegment = new Map<number, BlueprintSegment["textOverlays"]>();
  for (const segment of blueprint.segments) {
    const adapted = adaptTextOverlaysForDelivery(blueprint, segment, settings);
    deliveryTextBySegment.set(segment.index, adapted.overlays);
    warnings.push(...adapted.warnings);
  }
  if (formatChanged && project.tracks.some((track) => track.clips.length > 0)) {
    warnings.push(`Reflowed existing pixel-space layers from ${project.settings.width}x${project.settings.height} to ${settings.width}x${settings.height}`);
  }
  const entries: RecreationManifestEntry[] = [];

  // Reruns replace only prior generated reference surfaces and preserve user work.
  const priorGeneratedIds = new Set(
    state.tracks.flatMap((track) => track.clips)
      .filter((clip) => clip.referenceEditBinding)
      .map((clip) => clip.id)
  );
  // Older drafts predate support-layer bindings. These names are reserved for
  // deterministic recreation surfaces, so remove those whole tracks on rerun.
  const legacyGeneratedTrackIds = new Set(
    state.tracks
      .filter((track) => /^Reference (Title Cards|Composite Backgrounds|Layer \d+:)/.test(track.name))
      .map((track) => track.id)
  );
  if (priorGeneratedIds.size || legacyGeneratedTrackIds.size) {
    for (const track of state.tracks) {
      track.clips = track.clips.filter((clip) => !priorGeneratedIds.has(clip.id));
    }
    state.transitions = (state.transitions || []).filter(
      (item) => !priorGeneratedIds.has(item.clipAId) && !priorGeneratedIds.has(item.clipBId)
    );
    const beforeTrackIds = new Set(state.tracks.map((track) => track.id));
    state.tracks = state.tracks.filter(
      (track) => !legacyGeneratedTrackIds.has(track.id) &&
        (track.clips.length > 0 || !/^Reference (Cut|Text|Music)$/.test(track.name))
    );
    const retainedTrackIds = new Set(state.tracks.map((track) => track.id));
    for (const trackId of beforeTrackIds) {
      if (retainedTrackIds.has(trackId)) continue;
      delete state.audioMixer.trackRoles?.[trackId];
      delete state.audioMixer.trackVolumes[trackId];
      delete state.audioMixer.trackMutes[trackId];
      delete state.audioMixer.trackPans?.[trackId];
      delete state.audioMixer.trackAutomation?.[trackId];
      delete state.audioMixer.trackEq?.[trackId];
      delete state.audioMixer.trackPost?.[trackId];
    }
  }
  const unrelatedClipCount = state.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => !clip.referenceEditBinding).length;
  if (unrelatedClipCount > 0) {
    warnings.push(`Preserved ${unrelatedClipCount} existing user-authored clip(s); they remain composited with the generated reference cut`);
  }

  const videoTrackResult = await executeTool("add_track", { name: "Reference Cut", type: "video" }, state);
  const videoTrackId = String(videoTrackResult?.trackId || "");
  if (!videoTrackId) throw new Error("Recreation compiler did not receive a video track id");
  state.audioMixer.trackRoles = {
    ...(state.audioMixer.trackRoles || {}),
    [videoTrackId]: audioPolicy.sourceAudio === "duck" ? "voice" : "other",
  };

  const mappingBySegment = new Map(
    mappings.filter((mapping) => !mapping.layerId).map((mapping) => [mapping.segmentIndex, mapping])
  );
  const clipBySegment = new Map<number, string>();
  for (const segment of [...blueprint.segments].sort((a, b) => a.startTime - b.startTime)) {
    if (segment.composition?.replaceBase && segment.composition.layers.length > 0) continue;
    const mapping = mappingBySegment.get(segment.index);
    if (!mapping) throw new Error(`No asset mapping exists for blueprint segment ${segment.index}`);
    const asset = mediaAssets.find((candidate) => candidate.id === mapping.assetId);
    if (!asset) throw new Error(`Mapped media ${mapping.assetId} for segment ${segment.index} is missing`);
    const range = usableSpeed(asset, mapping, segment);
    if (range.warning) warnings.push(range.warning);
    const result = await executeTool("add_clip", {
      trackId: videoTrackId,
      sourceMediaId: mapping.assetId,
      startTime: segment.startTime,
      duration: segment.duration,
      sourceOffset: range.sourceOffset,
      speed: range.speed,
    }, state);
    const clipId = String(result?.clipId || "");
    if (!clipId) throw new Error(`Recreation compiler did not receive a clip id for segment ${segment.index}`);
    const binding: ReferenceEditBinding = {
      blueprintId: blueprint.id,
      kind: "segment",
      segmentIndex: segment.index,
      mappedAssetId: mapping.assetId,
      expectedStartTime: segment.startTime,
      expectedDuration: segment.duration,
      expectedSourceOffset: range.sourceOffset,
      requestedSpeed: segment.speed,
    };
    const clip = findClip(state, clipId);
    clip.referenceEditBinding = binding;
    clip.muted = audioPolicy.sourceAudio === "mute";
    clip.volume = audioPolicy.sourceAudio === "mute" ? 0 : audioPolicy.sourceVolume;
    // Express the intent, not a precomputed UV rectangle. Preview and export
    // resolve this against the decoded display dimensions, so rotation/SAR and
    // later relinks cannot turn a valid cover into a stretched frame.
    clip.mediaLayout = {
      schemaVersion: 1,
      fit: "cover",
      focalPoint: { x: 0.5, y: 0.5 },
    };
    if (asset.type !== "image" && !(Number(asset.metadata?.width) > 0 && Number(asset.metadata?.height) > 0)) {
      warnings.push(`Media ${asset.name} has no source dimensions; cover will resolve from decoded dimensions at render time`);
    }
    entries.push({ clipId, binding });
    clipBySegment.set(segment.index, clipId);
  }

  let textTrackId: string | undefined;
  const textTrackByZ = new Map<number, string>();
  let titleCardTrackId: string | undefined;
  const textCount = blueprint.segments.reduce((sum, segment) => sum + segment.textOverlays.length, 0);
  const needsFullFrameCards = blueprint.segments.some((segment) =>
    segment.textOverlays.some((overlay) => overlay.backgroundMode === "full-frame")
  );
  if (needsFullFrameCards) {
    const cardTrack = await executeTool("add_track", { name: "Reference Title Cards", type: "shape" }, state);
    titleCardTrackId = String(cardTrack?.trackId || "");
    if (!titleCardTrackId) throw new Error("Recreation compiler did not receive a title-card track id");
  }

  const compositionBackgrounds = blueprint.segments.filter((segment) => segment.composition?.backgroundColor);
  if (compositionBackgrounds.length > 0) {
    const backgroundTrack = await executeTool("add_track", { name: "Reference Composite Backgrounds", type: "shape" }, state);
    const backgroundTrackId = String(backgroundTrack?.trackId || "");
    if (!backgroundTrackId) throw new Error("Recreation compiler did not receive a composite-background track id");
    for (const segment of compositionBackgrounds) {
      const backgroundResult = await executeTool("add_shape_clip", {
        trackId: backgroundTrackId,
        shape: "rect",
        startTime: segment.startTime,
        duration: segment.duration,
        fill: segment.composition!.backgroundColor,
        stroke: "transparent",
        strokeWidth: 0,
        width: settings.width,
        height: settings.height,
      }, state);
      const clipId = String(backgroundResult?.clipId || "");
      if (!clipId) throw new Error(`Recreation compiler did not receive a background clip id for segment ${segment.index}`);
      const binding: ReferenceEditBinding = {
        blueprintId: blueprint.id,
        kind: "support-layer",
        segmentIndex: segment.index,
        layerId: "composition-background",
        expectedStartTime: segment.startTime,
        expectedDuration: segment.duration,
      };
      findClip(state, clipId).referenceEditBinding = binding;
      entries.push({ clipId, binding });
    }
  }

  const pendingMattes: Array<{ clipId: string; segmentIndex: number; overlayIndex: number }> = [];
  const compositionLayers = blueprint.segments.flatMap((segment) =>
    (segment.composition?.layers || []).map((layer) => ({ segment, layer }))
  ).sort((a, b) =>
    a.segment.startTime - b.segment.startTime || a.layer.zIndex - b.layer.zIndex
  );
  for (const { segment, layer } of compositionLayers) {
    const mapping = mappings.find((candidate) =>
      candidate.segmentIndex === segment.index && candidate.layerId === layer.id
    );
    if (!mapping) {
      warnings.push(`Composition layer ${segment.index}:${layer.id} has no mapped user media and was omitted`);
      continue;
    }
    const asset = mediaAssets.find((candidate) => candidate.id === mapping.assetId);
    if (!asset) {
      warnings.push(`Composition layer ${segment.index}:${layer.id} mapped media is missing`);
      continue;
    }
    const layerTiming = effectiveLayerTiming(segment, layer, blueprint);
    const startTime = segment.startTime + layerTiming.startRatio * segment.duration;
    const duration = Math.max(0.05, (layerTiming.endRatio - layerTiming.startRatio) * segment.duration);
    const layerSegment: BlueprintSegment = {
      ...segment,
      startTime,
      duration,
      visualDescription: layer.contentDescription,
      textOverlays: [],
      composition: undefined,
      transitionSpec: undefined,
    };
    const range = usableSpeed(asset, mapping, layerSegment);
    if (range.warning) warnings.push(range.warning);
    const trackResult = await executeTool("add_track", {
      name: `Reference Layer ${segment.index}:${layer.id}`,
      type: "video",
    }, state);
    const trackId = String(trackResult?.trackId || "");
    if (!trackId) throw new Error(`Recreation compiler did not receive a track id for layer ${layer.id}`);
    const clipResult = await executeTool("add_clip", {
      trackId,
      sourceMediaId: mapping.assetId,
      startTime,
      duration,
      sourceOffset: range.sourceOffset,
      speed: range.speed,
    }, state);
    const clipId = String(clipResult?.clipId || "");
    if (!clipId) throw new Error(`Recreation compiler did not receive a clip id for layer ${layer.id}`);
    const binding: ReferenceEditBinding = {
      blueprintId: blueprint.id,
      kind: "composition-layer",
      segmentIndex: segment.index,
      layerId: layer.id,
      mappedAssetId: mapping.assetId,
      expectedStartTime: startTime,
      expectedDuration: duration,
      expectedSourceOffset: range.sourceOffset,
      requestedSpeed: segment.speed,
    };
    const clip = findClip(state, clipId);
    clip.referenceEditBinding = binding;
    clip.muted = audioPolicy.sourceAudio === "mute";
    clip.volume = audioPolicy.sourceAudio === "mute" ? 0 : audioPolicy.sourceVolume;
    clip.mediaLayout = {
      schemaVersion: 1,
      fit: layer.fit,
      focalPoint: layer.focalPoint || { x: 0.5, y: 0.5 },
      viewport: { ...layer.viewport },
    };
    const authoredMotionWindow = {
      start: Math.max(0, (layer.timing.startRatio - layerTiming.startRatio) * segment.duration),
      duration: Math.max(0.01, (layer.timing.endRatio - layer.timing.startRatio) * segment.duration),
    };
    await applyMeasuredMotion(clipId, layer.motion, duration, settings, state, authoredMotionWindow, { blueprint, clipStartTime: startTime });
    await applyPhaseVisibility(
      clipId,
      segment,
      (phase) => phase.activeLayerIds.includes(layer.id),
      startTime,
      duration,
      blueprint,
      state
    );
    if (layer.matteTextOverlayIndex !== undefined) {
      pendingMattes.push({ clipId, segmentIndex: segment.index, overlayIndex: layer.matteTextOverlayIndex });
    }
    entries.push({ clipId, binding });
  }

  if (textCount > 0) {
    const zValues = [...new Set(blueprint.segments.flatMap((segment) =>
      segment.textOverlays.map((_overlay, overlayIndex) => effectiveTextZIndex(segment, overlayIndex))
    ))].sort((a, b) => a - b);
    for (const zIndex of zValues) {
      const result = await executeTool("add_track", {
        name: zValues.length === 1 ? "Reference Text" : `Reference Text z${zIndex}`,
        type: "text",
      }, state);
      const id = String(result?.trackId || "");
      if (!id) throw new Error("Recreation compiler did not receive a text track id");
      textTrackByZ.set(zIndex, id);
      textTrackId ||= id;
    }
  }

  const textClipByOverlay = new Map<string, string>();
  for (const segment of blueprint.segments) {
    for (let overlayIndex = 0; overlayIndex < segment.textOverlays.length; overlayIndex++) {
      const overlay = deliveryTextBySegment.get(segment.index)?.[overlayIndex] || segment.textOverlays[overlayIndex]!;
      if (!overlay.text.trim()) continue;
      const textTiming = effectiveTextTiming(segment, overlayIndex, blueprint);
      const startRatio = Math.max(0, Math.min(1, textTiming.startRatio));
      const endRatio = Math.max(startRatio, Math.min(1, textTiming.endRatio));
      const overlayStart = segment.startTime + startRatio * segment.duration;
      const overlayDuration = Math.max(0.05, (endRatio - startRatio) * segment.duration);
      const appearance = overlay.appearance;
      const font = textFontSelection(appearance);
      const fontSize = inferredTextFontSize(overlay, settings);
      const displayText = appearance?.uppercase ? overlay.text.toUpperCase() : overlay.text;
      if (
        overlay.backgroundMode === "full-frame" && titleCardTrackId &&
        appearance?.backgroundColor && (appearance.backgroundOpacity ?? 0) > 0
      ) {
        const cardResult = await executeTool("add_shape_clip", {
          trackId: titleCardTrackId,
          shape: "rect",
          startTime: overlayStart,
          duration: overlayDuration,
          fill: appearance.backgroundColor,
          stroke: "transparent",
          strokeWidth: 0,
          width: settings.width,
          height: settings.height,
        }, state);
        const cardClipId = String(cardResult?.clipId || "");
        if (cardClipId) {
          const cardClip = findClip(state, cardClipId);
          cardClip.opacity = appearance.backgroundOpacity ?? 1;
          const cardBinding: ReferenceEditBinding = {
            blueprintId: blueprint.id,
            kind: "support-layer",
            segmentIndex: segment.index,
            overlayIndex,
            layerId: "title-card",
            expectedStartTime: overlayStart,
            expectedDuration: overlayDuration,
          };
          cardClip.referenceEditBinding = cardBinding;
          await applyPhaseVisibility(
            cardClipId,
            segment,
            (phase) => phase.activeTextOverlayIndices.includes(overlayIndex),
            overlayStart,
            overlayDuration,
            blueprint,
            state
          );
          entries.push({ clipId: cardClipId, binding: cardBinding });
        }
      }
      const result = await executeTool("add_text_clip", {
        trackId: textTrackByZ.get(effectiveTextZIndex(segment, overlayIndex)) || textTrackId,
        text: displayText,
        startTime: overlayStart,
        duration: overlayDuration,
        fontSize,
        fontId: font.fontId,
        fontFamily: font.fontFamily,
        fontWeight: String(appearance?.fontWeight ?? (overlay.style === "minimal" ? 500 : 800)),
        color: appearance?.color ?? "#FFFFFF",
        stroke: appearance?.strokeColor ?? "#000000",
        strokeWidth: Math.max(0, Math.round(fontSize * (appearance?.strokeWidthRatio ?? 0.03))),
        textAlign: appearance?.textAlign ?? "center",
        letterSpacing: Math.round(fontSize * (appearance?.letterSpacingRatio ?? 0)),
        ...(overlay.backgroundMode !== "full-frame" && appearance?.backgroundColor && (appearance.backgroundOpacity ?? 0) > 0
          ? { backgroundColor: appearance.backgroundColor }
          : {}),
        ...(appearance?.shadow ? { shadow: `0 ${Math.max(1, Math.round(fontSize * 0.04))}px ${Math.max(2, Math.round(fontSize * 0.12))}px rgba(0,0,0,0.65)` } : {}),
      }, state);
      const clipId = String(result?.clipId || "");
      if (!clipId) throw new Error(`Recreation compiler did not receive a text clip id for segment ${segment.index}`);
      const binding: ReferenceEditBinding = {
        blueprintId: blueprint.id,
        kind: "text-overlay",
        segmentIndex: segment.index,
        overlayIndex,
        expectedStartTime: overlayStart,
        expectedDuration: overlayDuration,
      };
      const clip = findClip(state, clipId);
      clip.referenceEditBinding = binding;
      clip.layout = boundedGeometry(overlay);
      if (clip.textParams && overlay.backgroundMode !== "full-frame" && appearance?.backgroundColor && (appearance.backgroundOpacity ?? 0) > 0) {
        clip.textParams.backgroundColor = colorWithOpacity(
          appearance.backgroundColor,
          appearance.backgroundOpacity ?? 1
        );
      }
      if (appearance?.rotation) clip.transform.rotation = appearance.rotation;
      entries.push({ clipId, binding });
      textClipByOverlay.set(`${segment.index}:${overlayIndex}`, clipId);
      const authoredTextStartRatio = Math.max(0, Math.min(1, overlay.timing?.startRatio ?? 0));
      const authoredTextEndRatio = Math.max(authoredTextStartRatio, Math.min(1, overlay.timing?.endRatio ?? 1));
      const animationWindow = {
        start: Math.max(0, (authoredTextStartRatio - startRatio) * segment.duration),
        duration: Math.max(0.01, (authoredTextEndRatio - authoredTextStartRatio) * segment.duration),
      };
      const measured = await applyMeasuredTextAnimation(
        clipId,
        overlay,
        overlayDuration,
        settings,
        state,
        blueprint,
        overlayStart,
        animationWindow
      );
      const presetId = animationPreset(overlay.animation);
      if (!measured && presetId) {
        await executeTool("apply_animation_preset", { clipId, presetId }, state, false);
      }
      await applyPhaseVisibility(
        clipId,
        segment,
        (phase) => phase.activeTextOverlayIndices.includes(overlayIndex),
        overlayStart,
        overlayDuration,
        blueprint,
        state
      );
      const opacityKeys = findClip(state, clipId).keyframes.filter((keyframe) => keyframe.property === "opacity");
      if (opacityKeys.length && opacityKeys.every((keyframe) => Number(keyframe.value) <= 0)) {
        throw new Error(
          `Blueprint text ${segment.index}:${overlayIndex} (“${overlay.text}”) is permanently hidden by its composition phases`
        );
      }
    }
  }

  for (const pending of pendingMattes) {
    const matteClipId = textClipByOverlay.get(`${pending.segmentIndex}:${pending.overlayIndex}`);
    if (!matteClipId) {
      warnings.push(`Composition matte ${pending.segmentIndex}:${pending.overlayIndex} has no matching text overlay`);
      continue;
    }
    await executeTool("set_track_matte", {
      clipId: pending.clipId,
      matteClipId,
      type: "alpha",
    }, state);
  }

  const ordered = [...blueprint.segments].sort((a, b) => a.startTime - b.startTime);
  for (let index = 0; index < ordered.length - 1; index++) {
    const segment = ordered[index]!;
    const next = ordered[index + 1]!;
    const clipAId = clipBySegment.get(segment.index);
    const clipBId = clipBySegment.get(next.index);
    if (!clipAId || !clipBId) continue;
    const spec = segment.transitionSpec;
    const measuredDuration = spec?.durationRatio
      ? Math.min(segment.duration, next.duration) * spec.durationRatio
      : Math.min(0.4, segment.duration * 0.2, next.duration * 0.2);
    const duration = Math.max(0.08, Math.min(2, measuredDuration));
    const requestedPreset = spec?.presetType && getTransitionType(spec.presetType)
      ? spec.presetType
      : null;
    const type = requestedPreset || (!spec ? transitionType(segment.transitionToNext) : null);
    if (!type && spec && (spec.outgoing || spec.incoming)) {
      const clipA = findClip(state, clipAId);
      const clipB = findClip(state, clipBId);
      await applyMeasuredMotion(
        clipAId,
        spec.outgoing,
        clipA.duration,
        settings,
        state,
        { start: Math.max(0, clipA.duration - duration), duration },
        { blueprint, clipStartTime: clipA.startTime }
      );
      await applyMeasuredMotion(
        clipBId,
        spec.incoming,
        clipB.duration,
        settings,
        state,
        { start: 0, duration },
        { blueprint, clipStartTime: clipB.startTime }
      );
      continue;
    }
    if (!type) continue;
    const applied = await executeTool("add_transition", {
      clipAId,
      clipBId,
      type,
      duration,
      ...(spec?.direction ? { direction: spec.direction } : {}),
      ...(spec?.softness !== undefined ? { softness: spec.softness } : {}),
      allowHold: true,
    }, state, false);
    if (!applied) warnings.push(`Transition ${type} after segment ${segment.index} could not be applied safely; kept a hard cut`);
  }

  let musicTrackId: string | undefined;
  const soundtrackAsset = audioOptions?.soundtrackAssetId
    ? mediaAssets.find((asset) => asset.id === audioOptions.soundtrackAssetId)
    : undefined;
  if (audioPolicy.soundtrack !== "none" && !soundtrackAsset) {
    throw new Error(`The selected ${audioPolicy.soundtrack} soundtrack asset is unavailable`);
  }
  if (soundtrackAsset && soundtrackAsset.type !== "audio") {
    throw new Error(`Soundtrack asset ${soundtrackAsset.name} is not an audio asset`);
  }
  if (soundtrackAsset && (assetDuration(soundtrackAsset) || 0) + EPSILON < blueprint.totalDuration) {
    throw new Error(
      `Soundtrack ${soundtrackAsset.name} is shorter than the ${blueprint.totalDuration.toFixed(2)}s reference edit`
    );
  }
  if (soundtrackAsset && blueprint.totalDuration > 0) {
    const result = await executeTool("add_music_track", {
      sourceMediaId: soundtrackAsset.id,
      startTime: 0,
      duration: blueprint.totalDuration,
      sourceOffset: 0,
      volume: audioPolicy.soundtrackVolume,
      fadeInSec: Math.min(0.25, blueprint.totalDuration / 4),
      fadeOutSec: Math.min(0.5, blueprint.totalDuration / 4),
      trackName: "Reference Music",
    }, state);
    const clipId = String(result?.clipId || "");
    musicTrackId = String(result?.trackId || "");
    if (!clipId || !musicTrackId) throw new Error("Recreation compiler did not receive music clip/track ids");
    const binding: ReferenceEditBinding = {
      blueprintId: blueprint.id,
      kind: "music-bed",
      segmentIndex: -1,
      mappedAssetId: soundtrackAsset.id,
      expectedStartTime: 0,
      expectedDuration: blueprint.totalDuration,
      expectedSourceOffset: 0,
      requestedSpeed: 1,
    };
    findClip(state, clipId).referenceEditBinding = binding;
    entries.push({ clipId, binding });
    state.audioMixer.trackRoles = {
      ...(state.audioMixer.trackRoles || {}),
      [musicTrackId]: "music",
    };
    if (audioPolicy.sourceAudio === "duck") {
      state.audioMixer.duck = {
        enabled: true,
        mode: "sidechain",
        level: audioPolicy.duckLevel,
        attackSec: 0.12,
        releaseSec: 0.25,
      };
    }
  }

  const structuralErrors = validateTimeline(
    state.tracks,
    state.transitions || [],
    state.sequences || []
  ).filter((issue) => issue.severity === "error");
  if (structuralErrors.length) {
    throw new Error(`Compiled recreation is structurally invalid: ${structuralErrors.map((issue) => issue.message).join("; ")}`);
  }

  // Materialize the blueprint's single global z-order domain into track order.
  // Every composition surface already owns a track; text is split by zIndex.
  const visualZ = new Map<string, number>();
  visualZ.set(videoTrackId, -1_000);
  for (const [zIndex, trackId] of textTrackByZ) visualZ.set(trackId, zIndex);
  for (const track of state.tracks) {
    if (track.name === "Reference Composite Backgrounds") visualZ.set(track.id, -900);
    if (track.name === "Reference Title Cards") visualZ.set(track.id, -800);
    const textZ = track.name.match(/^Reference Text z(-?\d+)$/);
    if (textZ) visualZ.set(track.id, Number(textZ[1]));
    const bound = track.clips.find((clip) => clip.referenceEditBinding?.kind === "composition-layer");
    if (bound?.referenceEditBinding) {
      const segment = blueprint.segments.find((candidate) => candidate.index === bound.referenceEditBinding!.segmentIndex);
      const layer = segment?.composition?.layers.find((candidate) => candidate.id === bound.referenceEditBinding!.layerId);
      if (layer) visualZ.set(track.id, layer.zIndex);
    }
  }
  const unrelatedMax = state.tracks
    .filter((track) => !visualZ.has(track.id) && track.type !== "audio")
    .reduce((max, track) => Math.max(max, track.order), -1);
  const generatedBase = unrelatedMax + 1;
  for (const track of state.tracks) {
    const z = visualZ.get(track.id);
    if (z !== undefined) track.order = generatedBase + (z + 1_000) / 1_000;
  }
  state.tracks.sort((a, b) => a.order - b.order);

  return {
    state,
    settings,
    manifest: {
      schemaVersion: 1,
      blueprintId: blueprint.id,
      videoTrackId,
      ...(textTrackId ? { textTrackId } : {}),
      ...(musicTrackId ? { musicTrackId } : {}),
      audioPolicy,
      ...(soundtrackAsset ? { soundtrackAssetId: soundtrackAsset.id } : {}),
      entries,
      createdAt: new Date().toISOString(),
    },
    warnings,
  };
}

function consumedSourceDuration(clip: Clip): number {
  const hold = clip.hold?.durationSec || 0;
  return Math.max(0, clip.duration - hold) * Math.abs(clip.speed || 1);
}

/** Deterministic postcondition gate for reference assembly. */
export function validateRecreationConformance(
  state: Pick<ProjectState, "tracks" | "transitions" | "sequences" | "mediaAssets" | "settings" | "audioMixer">,
  blueprint: EditBlueprint,
  manifest: RecreationManifest
): RecreationConformanceReport {
  const issues: RecreationConformanceIssue[] = [];
  const clips = state.tracks.flatMap((track) => track.clips);
  const trackByClipId = new Map(state.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, track] as const)));
  const assets = new Map((state.mediaAssets || []).map((asset) => [asset.id, asset]));
  const manifestById = new Map(manifest.entries.map((entry) => [entry.clipId, entry]));
  const deliveryProfile = state.settings ? resolveDeliveryProfile(state.settings) : null;

  for (const entry of manifest.entries) {
    const clip = clips.find((candidate) => candidate.id === entry.clipId);
    const binding = entry.binding;
    if (!clip) {
      issues.push({ severity: "error", code: "missing_generated_clip", message: `Generated ${binding.kind} clip is missing`, clipId: entry.clipId, segmentIndex: binding.segmentIndex });
      continue;
    }
    if (clip.referenceEditBinding?.blueprintId !== blueprint.id) {
      issues.push({ severity: "error", code: "binding_lost", message: `Clip ${clip.id} lost its reference binding`, clipId: clip.id, segmentIndex: binding.segmentIndex });
    }
    if (Math.abs(clip.startTime - binding.expectedStartTime) > EPSILON) {
      issues.push({ severity: "error", code: "segment_start_mismatch", message: `Segment ${binding.segmentIndex} starts at ${clip.startTime.toFixed(3)}s, expected ${binding.expectedStartTime.toFixed(3)}s`, clipId: clip.id, segmentIndex: binding.segmentIndex });
    }
    if (clip.duration + EPSILON < binding.expectedDuration) {
      issues.push({ severity: "error", code: "segment_too_short", message: `Segment ${binding.segmentIndex} is ${clip.duration.toFixed(3)}s, expected at least ${binding.expectedDuration.toFixed(3)}s`, clipId: clip.id, segmentIndex: binding.segmentIndex });
    }
    if (binding.kind === "segment" || binding.kind === "composition-layer" || binding.kind === "music-bed") {
      if (clip.sourceMediaId !== binding.mappedAssetId) {
        issues.push({ severity: "error", code: "mapped_asset_mismatch", message: `Segment ${binding.segmentIndex} no longer uses its mapped media`, clipId: clip.id, segmentIndex: binding.segmentIndex });
      }
      const asset = clip.sourceMediaId ? assets.get(clip.sourceMediaId) : undefined;
      const duration = asset && asset.type !== "image" ? assetDuration(asset) : undefined;
      if (duration !== undefined && clip.sourceOffset + consumedSourceDuration(clip) > duration + EPSILON) {
        issues.push({ severity: "error", code: "source_range_overrun", message: `Segment ${binding.segmentIndex} consumes source past ${duration.toFixed(3)}s`, clipId: clip.id, segmentIndex: binding.segmentIndex });
      }
    } else if (binding.kind === "text-overlay") {
      const expectedSegment = blueprint.segments.find((segment) => segment.index === binding.segmentIndex);
      const expectedOverlay = expectedSegment && state.settings
        ? adaptTextOverlaysForDelivery(blueprint, expectedSegment, state.settings)
          .overlays[binding.overlayIndex ?? -1]
        : expectedSegment?.textOverlays[binding.overlayIndex ?? -1];
      const expectedText = expectedOverlay?.appearance?.uppercase
        ? expectedOverlay.text.toUpperCase()
        : expectedOverlay?.text;
      if (!clip.textParams?.text.trim()) {
        issues.push({ severity: "error", code: "text_missing", message: `Text overlay ${binding.segmentIndex}:${binding.overlayIndex} is empty`, clipId: clip.id, segmentIndex: binding.segmentIndex });
      } else if (expectedText !== undefined && clip.textParams.text !== expectedText) {
        issues.push({ severity: "error", code: "text_transcription_mismatch", message: `Text overlay ${binding.segmentIndex}:${binding.overlayIndex} no longer matches the reference transcription`, clipId: clip.id, segmentIndex: binding.segmentIndex });
      }
      if (!clip.layout) {
        issues.push({ severity: "error", code: "text_layout_missing", message: `Text overlay ${binding.segmentIndex}:${binding.overlayIndex} has no deterministic layout`, clipId: clip.id, segmentIndex: binding.segmentIndex });
      } else if (deliveryProfile && clip.textParams) {
        const geometry = resolveGraphicGeometry(deliveryProfile, clip.layout, estimateTextBounds(clip.textParams));
        for (const layoutIssue of validateGraphicGeometry(deliveryProfile, clip.layout, geometry)) {
          issues.push({
            severity: layoutIssue.severity === "error" ? "error" : "warning",
            code: `graphic_${layoutIssue.code}`,
            message: layoutIssue.message,
            clipId: clip.id,
            segmentIndex: binding.segmentIndex,
          });
        }
      }
      if (expectedOverlay && state.settings) {
        const expectedFontSize = inferredTextFontSize(expectedOverlay, state.settings);
        if (Math.abs(Number(clip.textParams?.fontSize || 0) - expectedFontSize) > Math.max(3, expectedFontSize * 0.08)) {
          issues.push({
            severity: "error",
            code: "text_size_mismatch",
            message: `Text overlay ${binding.segmentIndex}:${binding.overlayIndex} no longer matches measured glyph geometry`,
            clipId: clip.id,
            segmentIndex: binding.segmentIndex,
          });
        }
      }
      const opacityKeys = clip.keyframes.filter((keyframe) => keyframe.property === "opacity");
      if (opacityKeys.length && opacityKeys.every((keyframe) => Number(keyframe.value) <= 0)) {
        issues.push({
          severity: "error",
          code: "text_permanently_hidden",
          message: `Text overlay ${binding.segmentIndex}:${binding.overlayIndex} is permanently transparent`,
          clipId: clip.id,
          segmentIndex: binding.segmentIndex,
        });
      }
    }
    if (binding.kind === "segment" || binding.kind === "composition-layer") {
      const shouldMute = manifest.audioPolicy.sourceAudio === "mute";
      if (Boolean(clip.muted) !== shouldMute) {
        issues.push({
          severity: "error",
          code: "AUDIO_POLICY_SOURCE_MUTE_CHANGED",
          message: `Generated segment ${binding.segmentIndex} no longer follows the source-audio mute policy`,
          clipId: clip.id,
          segmentIndex: binding.segmentIndex,
        });
      }
      const expectedVolume = shouldMute ? 0 : manifest.audioPolicy.sourceVolume;
      if (Math.abs(Number(clip.volume ?? 1) - expectedVolume) > 0.01) {
        issues.push({
          severity: "error",
          code: "AUDIO_POLICY_SOURCE_VOLUME_CHANGED",
          message: `Generated segment ${binding.segmentIndex} source volume changed from the explicit audio policy`,
          clipId: clip.id,
          segmentIndex: binding.segmentIndex,
        });
      }
    }
    if (binding.kind === "music-bed") {
      if (
        clip.muted ||
        Math.abs(Number(clip.volume ?? 1) - manifest.audioPolicy.soundtrackVolume) > 0.01
      ) {
        issues.push({
          severity: "error",
          code: "AUDIO_POLICY_SOUNDTRACK_LEVEL_CHANGED",
          message: "The bound soundtrack level no longer matches the explicit audio policy",
          clipId: clip.id,
        });
      }
    }
  }

  if (manifest.audioPolicy.soundtrack !== "none") {
    const musicEntry = manifest.entries.find((entry) => entry.binding.kind === "music-bed");
    if (!musicEntry || !manifest.musicTrackId || !manifest.soundtrackAssetId) {
      issues.push({
        severity: "error",
        code: "AUDIO_POLICY_SOUNDTRACK_MISSING",
        message: "The explicit soundtrack policy is missing its bound music track",
      });
    } else if (state.audioMixer?.trackRoles?.[manifest.musicTrackId] !== "music") {
      issues.push({
        severity: "error",
        code: "AUDIO_POLICY_MUSIC_ROLE_CHANGED",
        message: "The soundtrack track is no longer classified as music",
      });
    }
  }
  if (manifest.audioPolicy.sourceAudio === "duck") {
    const duck = state.audioMixer?.duck;
    if (
      state.audioMixer?.trackRoles?.[manifest.videoTrackId] !== "voice" ||
      !duck?.enabled ||
      duck.mode !== "sidechain" ||
      Math.abs(Number(duck.level) - manifest.audioPolicy.duckLevel) > 0.01
    ) {
      issues.push({
        severity: "error",
        code: "AUDIO_POLICY_DUCK_CHANGED",
        message: "Dialogue ducking no longer matches the explicit audio policy",
      });
    }
  }

  for (const clip of clips) {
    const binding = clip.referenceEditBinding;
    if (binding?.blueprintId === blueprint.id && !manifestById.has(clip.id)) {
      issues.push({ severity: "warning", code: "untracked_generated_clip", message: `Reference-bound clip ${clip.id} is not in the recreation manifest`, clipId: clip.id, segmentIndex: binding.segmentIndex });
    }
  }

  for (const segment of blueprint.segments) {
    const composition = segment.composition;
    if (!composition) continue;
    for (const layer of composition.layers) {
      const entry = manifest.entries.find((candidate) =>
        candidate.binding.kind === "composition-layer" &&
        candidate.binding.segmentIndex === segment.index &&
        candidate.binding.layerId === layer.id
      );
      if (!entry) {
        issues.push({ severity: "error", code: "composition_layer_missing", message: `Composition layer ${segment.index}:${layer.id} was not compiled`, segmentIndex: segment.index });
        continue;
      }
      const clip = clips.find((candidate) => candidate.id === entry.clipId);
      if (!clip) continue;
      const viewport = clip.mediaLayout?.viewport;
      if (!viewport || ["x", "y", "width", "height"].some((key) =>
        Math.abs(Number(viewport[key as keyof typeof viewport]) - Number(layer.viewport[key as keyof typeof layer.viewport])) > 0.015
      )) {
        issues.push({ severity: "error", code: "composition_viewport_mismatch", message: `Composition layer ${segment.index}:${layer.id} lost its measured viewport`, clipId: clip.id, segmentIndex: segment.index });
      }
      if (layer.motion?.keyframes.length && !clip.keyframes.some((keyframe) =>
        keyframe.property.startsWith("mediaLayout.viewport.") || keyframe.property.startsWith("transform.") || keyframe.property === "opacity"
      )) {
        issues.push({ severity: "error", code: "composition_motion_missing", message: `Composition layer ${segment.index}:${layer.id} lost its measured motion`, clipId: clip.id, segmentIndex: segment.index });
      }
      if (layer.matteTextOverlayIndex !== undefined) {
        const textEntry = manifest.entries.find((candidate) =>
          candidate.binding.kind === "text-overlay" &&
          candidate.binding.segmentIndex === segment.index &&
          candidate.binding.overlayIndex === layer.matteTextOverlayIndex
        );
        if (!textEntry || clip.trackMatte?.sourceClipId !== textEntry.clipId) {
          issues.push({ severity: "error", code: "composition_matte_missing", message: `Matte layer ${segment.index}:${layer.id} lost its text source`, clipId: clip.id, segmentIndex: segment.index });
        }
      }
      const expectedZ = layer.zIndex;
      const actualOrder = trackByClipId.get(clip.id)?.order;
      if (actualOrder === undefined || !Number.isFinite(actualOrder)) {
        issues.push({ severity: "error", code: "composition_z_order_missing", message: `Composition layer ${segment.index}:${layer.id} has no track order`, clipId: clip.id, segmentIndex: segment.index });
      } else {
        for (let overlayIndex = 0; overlayIndex < segment.textOverlays.length; overlayIndex++) {
          const overlay = segment.textOverlays[overlayIndex]!;
          const overlayEntry = manifest.entries.find((candidate) => candidate.binding.kind === "text-overlay" && candidate.binding.segmentIndex === segment.index && candidate.binding.overlayIndex === overlayIndex);
          const overlayOrder = overlayEntry ? trackByClipId.get(overlayEntry.clipId)?.order : undefined;
          if (overlayOrder === undefined) continue;
          const overlayZ = effectiveTextZIndex(segment, overlayIndex);
          if ((expectedZ > overlayZ && actualOrder <= overlayOrder) || (expectedZ < overlayZ && actualOrder >= overlayOrder)) {
            issues.push({ severity: "error", code: "composition_z_order_mismatch", message: `Layer ${layer.id} and text ${overlayIndex} do not follow the blueprint global z-order`, clipId: clip.id, segmentIndex: segment.index });
          }
        }
      }
    }
  }

  for (const issue of validateTimeline(state.tracks, state.transitions || [], state.sequences || [])) {
    if (issue.severity === "info") continue;
    const issueTrack = state.tracks.find((track) => track.id === issue.trackId);
    const generatedTextOverlap = issue.code === "overlap_without_transition" &&
      issueTrack?.type === "text" &&
      issueTrack.clips.some((clip) =>
        clip.id === issue.clipId &&
        clip.referenceEditBinding?.blueprintId === blueprint.id &&
        clip.referenceEditBinding.kind === "text-overlay"
      );
    issues.push({
      // Same-track generated text has ambiguous paint order. In a reference
      // recreation it is never safe to wave this away as a generic warning:
      // intentional simultaneous typography must use explicit depth tracks.
      severity: issue.severity === "error" || generatedTextOverlap ? "error" : "warning",
      code: `timeline_${issue.code}`,
      message: issue.message,
      clipId: issue.clipId,
    });
  }

  const profile = state.settings?.deliveryProfile;
  if (!profile || profile.width !== state.settings?.width || profile.height !== state.settings?.height) {
    issues.push({ severity: "error", code: "delivery_profile_mismatch", message: "Project dimensions and frozen delivery profile do not match" });
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  return {
    ok: errors === 0,
    errors,
    warnings: issues.length - errors,
    issues,
    checkedSegments: manifest.entries.filter((entry) => entry.binding.kind === "segment").length,
    checkedTextOverlays: manifest.entries.filter((entry) => entry.binding.kind === "text-overlay").length,
  };
}
