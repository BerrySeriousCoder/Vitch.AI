import {
  GoogleGenAI,
  MediaResolution,
  ThinkingLevel,
  type GenerateContentResponseUsageMetadata,
} from "@google/genai";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import type {
  AudioAnalysis,
  BlueprintSegment,
  MediaAudioTranscript,
  ReferenceAnalysisEvidence,
  ReferenceAnalysisUsage,
} from "@tempo/types";
import { GOOGLE_FONT_FAMILIES } from "@tempo/editor-core";
import { env } from "../../config/env.js";
import {
  ANALYSIS_PROXY_TARGET_BYTES,
  generateAnalysisVideoProxy,
  probe,
} from "../../utils/ffmpeg.js";
import { logger } from "../../utils/logger.js";
import type { SceneSegment } from "./scene-detection.service.js";
import {
  sanitizeSegmentData,
  type PartialSegmentData,
} from "./vision-analysis.service.js";
import { chooseReliableSegment, validateBlueprintIntegrity } from "./blueprint-reconciliation.service.js";

// Gemini currently accepts at most 24 FPS for native video metadata. Use that
// ceiling for the one authoritative analysis pass instead of duplicating every
// animated scene through a lower-FPS primary and a second temporal pass.
export const FULL_DETAIL_FPS = 24;
// Start with balanced ~30-second groups. A 57-second reference therefore gets
// two globally coherent requests; only a malformed/incomplete response causes
// its failed range to be divided again at a detected scene boundary.
export const FULL_DETAIL_CHUNK_TARGET_SECONDS = 30;
export const FULL_DETAIL_CHUNK_MAX_SCENES = 20;
export const FULL_DETAIL_CHUNK_CONTEXT_SECONDS = 1;
export const GLOBAL_CONTEXT_MAX_FRAMES = 12;
// Gemini's video metadata API rejects values above 24 FPS. Use the maximum
// supported focused rate for short structural reinspection passes.
export const FOCUSED_DETAIL_FPS = 24;
const MODEL_PRICING_USD_PER_MILLION: Record<
  string,
  { input: number; output: number; longInput?: number; longOutput?: number }
> = {
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, longInput: 4, longOutput: 18 },
};

// A 12 MiB source expands to roughly 16 MiB as base64, leaving headroom for
// the reconstruction prompt inside Gemini's 20 MiB inline request envelope.
export const MAX_INLINE_VIDEO_BYTES = 12 * 1024 * 1024;

export interface WholeVideoAnalysis {
  scenes: PartialSegmentData[];
  usage: ReferenceAnalysisUsage;
}

export interface WholeVideoAnalysisCheckpoint {
  schemaVersion: 1;
  promptVersion: string;
  model: string;
  sceneSignature: string;
  rawScenes: Record<string, unknown>;
  usage: ReferenceAnalysisUsage;
  updatedAt: string;
}

const ANALYSIS_PROMPT_VERSION = "2026-08-20-text-geometry-coverage-v2";

export interface FullDetailAnalysisChunk {
  index: number;
  scenes: SceneSegment[];
  startTime: number;
  endTime: number;
  contextStartTime: number;
  contextEndTime: number;
}

export interface ParsedSceneResponse {
  scenes: unknown[];
  complete: boolean;
  error?: string;
}

export interface ReferenceRangeInspection {
  analysis: string;
  reconstructionSpec?: Record<string, unknown>;
  usage: ReferenceAnalysisUsage;
}

export function needsInlineVideoProxy(fileSize: number): boolean {
  return !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_INLINE_VIDEO_BYTES;
}

/**
 * Keep proven short references on one request. Longer references start as
 * balanced groups divided only at deterministic edit boundaries. Provider
 * failures are subdivided later, so simple long references are not fragmented
 * pre-emptively. A single long detected scene always remains intact.
 */
export function planFullDetailAnalysisChunks(
  scenes: SceneSegment[],
  totalDuration = scenes.reduce((max, scene) => Math.max(max, scene.endTime), 0),
  options: { targetSeconds?: number; maxScenes?: number; contextSeconds?: number } = {}
): FullDetailAnalysisChunk[] {
  if (!scenes.length) return [];
  const targetSeconds = Math.max(1, options.targetSeconds ?? FULL_DETAIL_CHUNK_TARGET_SECONDS);
  const maxScenes = Math.max(1, Math.floor(options.maxScenes ?? FULL_DETAIL_CHUNK_MAX_SCENES));
  const context = Math.max(0, options.contextSeconds ?? FULL_DETAIL_CHUNK_CONTEXT_SECONDS);
  const spanStart = scenes[0]!.startTime;
  const spanEnd = scenes[scenes.length - 1]!.endTime;
  const spanDuration = Math.max(0.001, spanEnd - spanStart);
  const desiredGroups = Math.min(
    scenes.length,
    Math.max(1, Math.ceil(spanDuration / targetSeconds), Math.ceil(scenes.length / maxScenes))
  );
  const groups: SceneSegment[][] = [];
  let cursor = 0;

  for (let groupIndex = 0; groupIndex < desiredGroups; groupIndex++) {
    const groupsLeft = desiredGroups - groupIndex;
    const scenesLeft = scenes.length - cursor;
    if (groupsLeft === 1) {
      groups.push(scenes.slice(cursor));
      break;
    }
    const minimumTake = Math.max(1, scenesLeft - maxScenes * (groupsLeft - 1));
    const maximumTake = Math.min(maxScenes, scenesLeft - (groupsLeft - 1));
    const idealEnd = spanStart + spanDuration * ((groupIndex + 1) / desiredGroups);
    let take = minimumTake;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let candidate = minimumTake; candidate <= maximumTake; candidate++) {
      const boundary = scenes[cursor + candidate - 1]!.endTime;
      const distance = Math.abs(boundary - idealEnd);
      if (distance < bestDistance) {
        bestDistance = distance;
        take = candidate;
      }
    }
    groups.push(scenes.slice(cursor, cursor + take));
    cursor += take;
  }

  return groups.map((group, index) => {
    const startTime = group[0]!.startTime;
    const endTime = group[group.length - 1]!.endTime;
    return {
      index,
      scenes: group,
      startTime,
      endTime,
      contextStartTime: Math.max(0, startTime - context),
      contextEndTime: Math.max(endTime, Math.min(totalDuration, endTime + context)),
    };
  });
}

export function bisectSceneGroupAtMidpoint(
  targetScenes: SceneSegment[]
): [SceneSegment[], SceneSegment[]] {
  if (targetScenes.length < 2) return [[...targetScenes], []];
  const start = targetScenes[0]!.startTime;
  const end = targetScenes[targetScenes.length - 1]!.endTime;
  const midpoint = start + (end - start) / 2;
  let splitAt = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < targetScenes.length; index++) {
    const distance = Math.abs(targetScenes[index - 1]!.endTime - midpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      splitAt = index;
    }
  }
  return [targetScenes.slice(0, splitAt), targetScenes.slice(splitAt)];
}

/** Recover only syntactically complete scene objects from a truncated JSON array. */
export function parseSceneResponse(raw: string): ParsedSceneResponse {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!Array.isArray(parsed?.scenes)) {
      return {
        scenes: [],
        complete: false,
        error: "Response contract requires a root scenes array",
      };
    }
    return {
      scenes: parsed.scenes,
      complete: true,
    };
  } catch (error) {
    const key = raw.indexOf('"scenes"');
    const arrayStart = key >= 0 ? raw.indexOf("[", key) : -1;
    if (arrayStart < 0) {
      return { scenes: [], complete: false, error: error instanceof Error ? error.message : String(error) };
    }
    const scenes: unknown[] = [];
    let objectStart = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = arrayStart + 1; index < raw.length; index++) {
      const character = raw[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") {
        if (depth === 0) objectStart = index;
        depth++;
      } else if (character === "}" && depth > 0) {
        depth--;
        if (depth === 0 && objectStart >= 0) {
          try {
            scenes.push(JSON.parse(raw.slice(objectStart, index + 1)));
          } catch {
            // A malformed object is retried from its own bounded scene range.
          }
          objectStart = -1;
        }
      }
    }
    return {
      scenes,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildInlineVideoPart(
  data: string,
  fps: number,
  range?: { startTime: number; endTime: number }
) {
  return {
    inlineData: { mimeType: "video/mp4", data },
    videoMetadata: {
      fps: Math.max(2, Math.min(24, Number(fps) || FULL_DETAIL_FPS)),
      ...(range ? {
        startOffset: `${Math.max(0, range.startTime)}s`,
        endOffset: `${Math.max(range.startTime, range.endTime)}s`,
      } : {}),
    },
  };
}

interface PreparedInlineVideo {
  data: string;
  byteLength: number;
  source: "original" | "analysis-proxy";
  cleanup: () => Promise<void>;
}

async function prepareInlineVideo(videoPath: string, signal?: AbortSignal): Promise<PreparedInlineVideo> {
  if (signal?.aborted) throw new DOMException("Reference analysis cancelled", "AbortError");
  const sourceInfo = await stat(videoPath);
  let selectedPath = videoPath;
  let source: PreparedInlineVideo["source"] = "original";
  let workDir: string | undefined;
  try {
    if (needsInlineVideoProxy(sourceInfo.size)) {
      const metadata = await probe(videoPath);
      if (!metadata.duration) throw new Error("Reference duration is unavailable for analysis proxy generation");
      workDir = await mkdtemp(path.join(os.tmpdir(), "tempo-gemini-video-"));
      selectedPath = path.join(workDir, "analysis-proxy.mp4");
      const generated = await generateAnalysisVideoProxy(
        videoPath,
        selectedPath,
        metadata.duration,
        { targetBytes: ANALYSIS_PROXY_TARGET_BYTES, signal }
      );
      if (!generated) throw new Error("Could not generate an inline analysis proxy");
      source = "analysis-proxy";
    }
    const bytes = await readFile(selectedPath);
    if (bytes.byteLength > MAX_INLINE_VIDEO_BYTES) {
      throw new Error(`Inline analysis video is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB; maximum is 12 MiB`);
    }
    logger.info({
      source,
      originalBytes: sourceInfo.size,
      analysisBytes: bytes.byteLength,
      model: env.GEMINI_VIDEO_ANALYSIS_MODEL,
    }, "Prepared inline Gemini video");
    return {
      data: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      source,
      cleanup: async () => {
        if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

interface FullDetailPromptWindow {
  startTime: number;
  endTime: number;
  contextStartTime: number;
  contextEndTime: number;
}

export function selectGlobalContextScenes(
  scenes: SceneSegment[],
  maximum = GLOBAL_CONTEXT_MAX_FRAMES
): SceneSegment[] {
  const limit = Math.max(1, Math.floor(maximum));
  if (scenes.length <= limit) return [...scenes];
  if (limit === 1) return [scenes[Math.floor((scenes.length - 1) / 2)]!];
  const selected = new Map<number, SceneSegment>();
  for (let index = 0; index < limit; index++) {
    const position = Math.round(index * (scenes.length - 1) / (limit - 1));
    selected.set(position, scenes[position]!);
  }
  return [...selected.entries()].sort(([left], [right]) => left - right).map(([, scene]) => scene);
}

async function buildGlobalStoryboardParts(scenes: SceneSegment[]): Promise<any[]> {
  const selected = selectGlobalContextScenes(scenes);
  const parts: any[] = [{
    text: "GLOBAL REFERENCE STORYBOARD. These ordered stills span the complete reference and establish recurring typography, color, layer identity, and editorial language. Use them for continuity only; measure timing and motion from the 24 FPS target video that follows.",
  }];
  for (const scene of selected) {
    try {
      const data = await readFile(scene.thumbnailPath);
      parts.push({ text: `Global scene ${scene.index}, midpoint near ${(scene.startTime + scene.duration / 2).toFixed(3)}s:` });
      parts.push({
        inlineData: {
          mimeType: /\.png$/i.test(scene.thumbnailPath) ? "image/png" : "image/jpeg",
          data: data.toString("base64"),
        },
      });
    } catch (error: any) {
      logger.warn({ err: error?.message, sceneIndex: scene.index }, "Global storyboard frame unavailable");
    }
  }
  return parts;
}

function transcriptForPrompt(
  transcript?: MediaAudioTranscript,
  window?: Pick<FullDetailPromptWindow, "contextStartTime" | "contextEndTime">
): string {
  if (!transcript || transcript.error || transcript.segments.length === 0) {
    return "No reliable external transcript is available. Listen to the video audio directly.";
  }
  const confidences = transcript.segments
    .map((segment) => segment.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const averageConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : undefined;
  if (
    transcript.kind === "music_instrumental" ||
    transcript.kind === "unknown" ||
    (averageConfidence !== undefined && averageConfidence < 0.5)
  ) {
    return `External ASR was ignored (${transcript.kind}, confidence=${averageConfidence?.toFixed(2) || "unavailable"}). Verify speech directly from the video.`;
  }
  if (transcript.words?.length) {
    const words = window
      ? transcript.words.filter((word) => word.end >= window.contextStartTime && word.start <= window.contextEndTime)
      : transcript.words;
    return words
      .map((word) => `[${word.start.toFixed(3)}-${word.end.toFixed(3)}] ${word.text}`)
      .join(" ")
      .slice(0, 80_000);
  }
  const segments = window
    ? transcript.segments.filter((segment) => segment.end >= window.contextStartTime && segment.start <= window.contextEndTime)
    : transcript.segments;
  return segments
    .map((segment) => `[${segment.start.toFixed(3)}-${segment.end.toFixed(3)}] ${segment.text}`)
    .join("\n")
    .slice(0, 80_000);
}

function evidenceForPrompt(evidence?: ReferenceAnalysisEvidence): string {
  if (!evidence) return "Local pixel evidence unavailable.";
  return evidence.scenes.map((scene) => {
    const changing = scene.frames
      .filter((frame) => frame.changeScore >= 0.025 || frame.components.length >= 2)
      .sort((a, b) => b.changeScore - a.changeScore)
      .slice(0, 12)
      .sort((a, b) => a.time - b.time)
      .map((frame) => ({
        t: Number(frame.time.toFixed(3)),
        delta: Number(frame.changeScore.toFixed(4)),
        black: Number(frame.blackRatio.toFixed(3)),
        foreground: frame.foreground,
        largeRegions: frame.components.filter((rect) => rect.width * rect.height >= 0.06),
        flow: frame.flow && {
          dx: Number(frame.flow.dx.toFixed(4)),
          dy: Number(frame.flow.dy.toFixed(4)),
          magnitude: Number(frame.flow.magnitude.toFixed(4)),
        },
      }));
    const text = scene.textObservations?.slice(0, 40).map((item) => ({
      t: Number(item.time.toFixed(3)),
      text: item.text,
      confidence: Number(item.confidence.toFixed(3)),
      rect: item.rect,
    }));
    return `scene ${scene.sceneIndex}: eventTimes=${scene.eventTimes.map((time) => time.toFixed(3)).join(",") || "none"}; maxLargeRegions=${scene.maxVisibleComponents}; keyFrames=${JSON.stringify(changing)}; measuredText=${JSON.stringify(text || [])}`;
  }).join("\n").slice(0, 80_000);
}

function evidenceForScenes(
  evidence: ReferenceAnalysisEvidence | undefined,
  scenes: SceneSegment[]
): ReferenceAnalysisEvidence | undefined {
  if (!evidence) return undefined;
  const indices = new Set(scenes.map((scene) => scene.index));
  return { ...evidence, scenes: evidence.scenes.filter((scene) => indices.has(scene.sceneIndex)) };
}

function buildPrompt(
  scenes: SceneSegment[],
  transcript?: MediaAudioTranscript,
  audio?: AudioAnalysis,
  evidence?: ReferenceAnalysisEvidence,
  window?: FullDetailPromptWindow,
  globalScenes?: SceneSegment[]
): string {
  const boundaries = scenes
    .map((scene) => `${scene.index}: ${scene.startTime.toFixed(3)}-${(scene.startTime + scene.duration).toFixed(3)}s`)
    .join("\n");
  const scope = window
    ? `The ordered stills provide GLOBAL continuity context from the complete reference. Analyze the attached ${window.contextStartTime.toFixed(3)}-${window.contextEndTime.toFixed(3)}s TARGET VIDEO at FULL DETAIL as part of that continuous timeline. The target scenes occupy ${window.startTime.toFixed(3)}-${window.endTime.toFixed(3)}s; surrounding frames are transition context only. Return one scene object for every listed target index, in the same order, and do not emit context-only scenes.`
    : "Analyze the COMPLETE attached reference video as one continuous timeline. Return one scene object for every listed index, in the same order.";
  const impacts = (audio?.impacts || []).filter((impact) =>
    !window || (impact.time >= window.contextStartTime && impact.time <= window.contextEndTime)
  );
  const globalSceneMap = window && globalScenes?.length
    ? globalScenes.map((scene) =>
        `${scene.index}:${scene.startTime.toFixed(3)}-${scene.endTime.toFixed(3)}s`
      ).join(", ")
    : "not needed; target is the complete reference";
  return `${scope} The supplied scene boundaries come from deterministic FFmpeg cut detection. All supplied boundaries, transcript times, impact times, and evidence times are absolute reference timestamps.

GLOBAL SCENE MAP (continuity context only): ${globalSceneMap}

The FFmpeg boundaries are edit cuts, not a license to flatten everything between two cuts. A single listed scene may contain several timed compositing phases, animated panels, masks, or text states. Preserve those internal events with normalized timing and measured keyframes.

Most important: capture EVERY editorial text state, including extremely short title cards and word-by-word text. Editorial text is text added by the editor, not signs/UI inside filmed footage. Preserve exact spelling and case. When words replace one another, emit EACH visible word as a separate textOverlays item with sequenceMode="exclusive", the same sequenceGroupId, and its own timing. Do not combine those words into one sentence. Analyze every overlay independently: one reference may use several typefaces.

GEOMETRY CONTRACT: textOverlays.geometry.x/y are the CENTER of the text box in normalized full-frame coordinates. Local measuredText rect.x/y are TOP-LEFT OCR coordinates. Convert OCR rectangles to centres with x=rect.x+rect.width/2 and y=rect.y+rect.height/2. Never copy OCR rect.x/y directly into geometry.x/y. Before returning, check every simultaneously visible text box for unintended intersection; preserve intentional reference overlap only when it is visibly present in the attached frames.

TEXT MOTION: animation is not a style label. Populate animationSpec whenever text changes over time. Set unit to char/word/line/whole and report every independently animated channel with normalized offsetRatio, durationRatio, and staggerRatio. Use channels such as opacity, offsetX/Y, scale, rotation, tracking, or blur. Put whole-layer movement in animationSpec.motion keyframes. If the word remains centered, OMIT whole-layer motion—never invent a zoom, drift, or bounce. For fontFamilyHint choose the closest exact family from the shortlist. Give every text overlay a global zIndex using the same ordering domain as composition layers; panels that visibly cover text must have a higher zIndex.

MEDIA INSIDE TEXT: if moving footage or an image is visible only inside glyphs, set text fillMode="media-matte" and emit a composition layer with role="matte-fill" and matteTextOverlayIndex pointing to that text item. Do not describe it as ordinary transparent text.

MULTI-LAYER COMPOSITING: whenever two or more videos/images are visible at once, emit composition.layers. Each layer needs a stable id, role, independent contentDescription for user-asset matching, zIndex, normalized timing, final viewport, cover/contain fit, and motion keyframes for every observed geometry change. A 2x2 layout is four layers, not one full-frame "split-screen" effect. Use viewport x/y/width/height against the complete frame. Layer timing is its complete lifetime, NOT its entrance duration. Motion timeRatio is relative to that lifetime, so a 0.55-second reveal on a layer which persists for 3 seconds must reach its final viewport near timeRatio 0.18 and then hold; never place the final entrance keyframe at 1 merely because the layer survives to the scene end. For growing panels, measure at least start, midpoint, and final geometry. Start and final viewport values must be numerically different. Set focalPoint to the observed crop anchor: a left-to-right expansion which initially shows the source's right edge uses focalPoint.x=1; right-to-left showing the left edge uses x=0; top-to-bottom showing the bottom uses y=1. Set replaceBase=true when these layers fully define the scene.

COMPOSITION PHASES: do not infer that an earlier layer disappears merely because a later layer begins. Emit composition.phases for every distinct visibility/overlap state. Each phase lists all active layer ids and text overlay indices. This is how you preserve text underneath panels, a background continuing behind picture-in-picture, or a matte continuing while overlays cover it. Phase membership never replaces authored text timing: never widen exclusive word captions to a phase, never move a cumulative title's start earlier, and extend only the end of a genuinely persistent static/cumulative title. Exclusive overlays in one sequenceGroupId must have non-overlapping timing intervals.

TEXT COVERAGE SELF-CHECK: every high-confidence measuredText observation in the target range must map to a temporally active textOverlays item, and every textOverlays item must be active in at least one composition phase. If transcript words are also visibly rendered, preserve the rendered text independently of the audio transcript. Do not end a caption sequence early merely because the scene is near a chunk boundary.

NUMERIC SELF-AUDIT: before returning JSON, compare the fields against your own description. If a phase says a panel covers text, the panel zIndex must be strictly higher than both the text zIndex and its linked matte-fill zIndex. A linked matte-fill and its text overlay use the same visual zIndex. If you describe reveal/grow/slide motion, at least one numeric property must change between keyframes. Never encode two identical keyframes as motion.

OUTPUT DISCIPLINE: full detail means complete structured layers, phases, typography, timing, and keyframes—not repeated prose. Keep visualDescription and contentDescription concise, never restate numeric fields in prose, and emit exactly one root object with a scenes array. Do not use an alternative root key such as scene, results, or analysis.

AUDIO-EVENT SYNC: the supplied impact list contains measured transients even when no regular BPM exists. Use those exact ids when a character, word, scale hit, flash, panel arrival, or cut visibly lands on an impact. Text channels use unitSyncEventIds in rendered-unit order. Layer/whole-text keyframes use syncEventId. Use easing="hold" when values step/hit rather than interpolate smoothly. Do not call irregular impacts a beat grid.

TRANSITIONS: use transitionSpec.presetType only when the observed transition genuinely matches a registered semantic type. Otherwise describe measured outgoing/incoming motion keyframes, direction, durationRatio, and easing. Never replace an unknown transition with a vaguely similar preset.

For each scene return:
{"index":0,"shotType":"close-up|medium|wide|extreme-close-up|bird-eye|other","motionType":"static|pan|zoom-in|zoom-out|shake|whip-pan|tracking|rotate","motionConfidence":0.0,"transitionToNext":"cut|fade|dissolve|zoom|whip|glitch|swipe|none","transitionConfidence":0.0,"transitionSpec":{"durationRatio":0.1,"direction":"left|right|up|down","softness":0.0,"easing":"hold|linear|ease-in|ease-out|ease-in-out","presetType":"optional exact registry-style name","outgoing":{"keyframes":[{"timeRatio":0,"syncEventId":"optional-impact-id","viewport":{"x":0,"y":0,"width":1,"height":1},"opacity":1,"offsetXRatio":0,"offsetYRatio":0,"scaleX":1,"scaleY":1,"rotation":0,"easing":"ease-in-out"}]},"incoming":{"keyframes":[]},"confidence":0.9},"energyLevel":50,"visualDescription":"...","colorPalette":["#RRGGBB"],"effects":[],"textOverlays":[{"text":"EXACT text","style":"bold|minimal|kinetic|typewriter|glitch|bounce","position":"top|center|bottom|custom","animation":"free description, not a preset requirement","fillMode":"solid|media-matte","zIndex":0,"animationSpec":{"unit":"whole|char|word|line","channels":[{"property":"opacity|offsetX|offsetY|scale|rotation|tracking|blur","from":0,"to":1,"offsetRatio":0,"durationRatio":0.05,"staggerRatio":0.08,"unitStartRatios":[0.1,0.2],"unitSyncEventIds":["impact-0","impact-1"],"keyframes":[{"timeRatio":0,"value":0,"easing":"hold"},{"timeRatio":0.02,"value":1.35,"easing":"hold"},{"timeRatio":0.08,"value":1,"easing":"ease-out"}],"easing":"hold|linear|ease-in|ease-out|ease-in-out"}],"motion":{"keyframes":[]},"confidence":0.9},"sequenceMode":"static|cumulative|exclusive","sequenceGroupId":"optional-id","backgroundMode":"text-box|full-frame","appearance":{"fontFamilyClass":"sans|serif|display|monospace|handwritten","fontFamilyHint":"Bebas Neue","fontWidth":"condensed|normal|wide","fontWeight":700,"fontSizeRatio":0.06,"color":"#FFFFFF","strokeColor":"#000000","strokeWidthRatio":0,"backgroundColor":"#000000","backgroundOpacity":1,"textAlign":"center","letterSpacingRatio":0,"uppercase":false,"shadow":false,"rotation":0,"confidence":0.9},"geometry":{"x":0.5,"y":0.5,"width":0.6,"height":0.12,"confidence":0.9},"timing":{"startRatio":0,"endRatio":1,"confidence":0.9}}],"composition":{"replaceBase":true,"backgroundColor":"#000000","confidence":0.9,"layers":[{"id":"panel-tl","role":"background|panel|matte-fill|overlay","contentDescription":"independent visible source description","zIndex":0,"timing":{"startRatio":0.4,"endRatio":1,"confidence":0.9},"viewport":{"x":0,"y":0,"width":0.5,"height":0.5},"fit":"cover|contain","focalPoint":{"x":0.5,"y":0.5},"matteTextOverlayIndex":0,"motion":{"confidence":0.9,"keyframes":[{"timeRatio":0,"syncEventId":"impact-4","viewport":{"x":0.25,"y":0,"width":0.001,"height":0.5},"opacity":1,"easing":"hold"},{"timeRatio":0.25,"viewport":{"x":0,"y":0,"width":0.5,"height":0.5}}]}}],"phases":[{"id":"text-form","label":"characters form over black","startRatio":0,"endRatio":0.5,"activeLayerIds":["matte-fill"],"activeTextOverlayIndices":[0]},{"id":"panel-cover","label":"panels cover persistent text","startRatio":0.5,"endRatio":1,"syncEventId":"impact-4","activeLayerIds":["matte-fill","panel-tl"],"activeTextOverlayIndices":[0]}]},"speed":1,"speedConfidence":0.0}

GOOGLE-FONT SHORTLIST (use exact spelling for fontFamilyHint):
${GOOGLE_FONT_FAMILIES.join(", ")}

Return JSON only as {"scenes":[...]}. Never omit a listed scene and never invent additional scene boundaries. Omit optional structures only when they are genuinely absent; do not emit empty fake motion.

SCENE BOUNDARIES:
${boundaries}

WORD/SEGMENT TIMED AUDIO TRANSCRIPT (alignment aid; verify against video):
${transcriptForPrompt(transcript, window)}

MEASURED AUDIO IMPACT EVENTS (ids are stable anchors, not necessarily a BPM grid):
${impacts.map((impact) => `${impact.id}@${impact.time.toFixed(3)}s strength=${impact.strength.toFixed(2)}`).join(", ") || "unavailable"}

LOCAL PIXEL EVIDENCE (deterministic measurements; use as constraints, not prose suggestions):
${evidenceForPrompt(evidence)}

TIMING RULE: When local eventTimes or measured text observations exist, treat them as the timestamp anchors. Do not replace them with rounded model estimates. Report model-only timing only where deterministic evidence is absent, and lower confidence accordingly.`;
}

function combineUsage(primary: ReferenceAnalysisUsage, detail: ReferenceAnalysisUsage): ReferenceAnalysisUsage {
  return {
    ...primary,
    videoFps: Math.max(primary.videoFps, detail.videoFps),
    promptTokens: primary.promptTokens + detail.promptTokens,
    outputTokens: primary.outputTokens + detail.outputTokens,
    thinkingTokens: primary.thinkingTokens + detail.thinkingTokens,
    totalTokens: primary.totalTokens + detail.totalTokens,
    estimatedInputUsd: Number((primary.estimatedInputUsd + detail.estimatedInputUsd).toFixed(6)),
    estimatedOutputUsd: Number((primary.estimatedOutputUsd + detail.estimatedOutputUsd).toFixed(6)),
    estimatedTranscriptionUsd: Number((primary.estimatedTranscriptionUsd + detail.estimatedTranscriptionUsd).toFixed(6)),
    estimatedTotalUsd: Number((primary.estimatedTotalUsd + detail.estimatedTotalUsd).toFixed(6)),
  };
}

function asBlueprintSegment(
  value: PartialSegmentData,
  boundary: SceneSegment,
  index: number
): BlueprintSegment {
  return {
    index,
    startTime: boundary.startTime,
    duration: boundary.duration,
    ...value,
    onBeat: false,
  };
}

export function estimateReferenceUsage(
  usage: GenerateContentResponseUsageMetadata | undefined,
  transcriptionUsd = 0,
  videoFps = FULL_DETAIL_FPS,
  model = env.GEMINI_VIDEO_ANALYSIS_MODEL
): ReferenceAnalysisUsage {
  const promptTokens = usage?.promptTokenCount || 0;
  const outputTokens = usage?.candidatesTokenCount || 0;
  const thinkingTokens = usage?.thoughtsTokenCount || 0;
  const pricing = MODEL_PRICING_USD_PER_MILLION[model] ||
    MODEL_PRICING_USD_PER_MILLION["gemini-3.7-flash"]!;
  const longContext = promptTokens > 200_000;
  const inputRate = longContext && pricing.longInput ? pricing.longInput : pricing.input;
  const outputRate = longContext && pricing.longOutput ? pricing.longOutput : pricing.output;
  const estimatedInputUsd = (promptTokens / 1_000_000) * inputRate;
  const estimatedOutputUsd = ((outputTokens + thinkingTokens) / 1_000_000) * outputRate;
  return {
    model,
    videoFps,
    mediaResolution: "high",
    promptTokens,
    outputTokens,
    thinkingTokens,
    totalTokens: usage?.totalTokenCount || promptTokens + outputTokens + thinkingTokens,
    estimatedInputUsd: Number(estimatedInputUsd.toFixed(6)),
    estimatedOutputUsd: Number(estimatedOutputUsd.toFixed(6)),
    estimatedTranscriptionUsd: Number(transcriptionUsd.toFixed(6)),
    estimatedTotalUsd: Number((estimatedInputUsd + estimatedOutputUsd + transcriptionUsd).toFixed(6)),
  };
}

/** Analyze every scene at full detail, using bounded requests for long references. */
export async function analyzeWholeVideo(
  videoPath: string,
  scenes: SceneSegment[],
  transcript?: MediaAudioTranscript,
  audio?: AudioAnalysis,
  options: {
    signal?: AbortSignal;
    evidence?: ReferenceAnalysisEvidence;
    checkpoint?: WholeVideoAnalysisCheckpoint;
    onCheckpoint?: (checkpoint: WholeVideoAnalysisCheckpoint) => void | Promise<void>;
  } = {}
): Promise<WholeVideoAnalysis> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  let prepared: PreparedInlineVideo | undefined;
  const sceneSignature = scenes.map((scene) =>
    `${scene.index}:${scene.startTime.toFixed(3)}:${scene.endTime.toFixed(3)}`
  ).join("|");
  const canResume = options.checkpoint?.schemaVersion === 1 &&
    options.checkpoint.promptVersion === ANALYSIS_PROMPT_VERSION &&
    options.checkpoint.model === env.GEMINI_VIDEO_ANALYSIS_MODEL &&
    options.checkpoint.sceneSignature === sceneSignature;
  let usage = canResume ? options.checkpoint!.usage : estimateReferenceUsage(undefined, 0);
  const transcriptionUsd = transcript?.usage?.estimatedCostUsd || 0;
  const usageWithTranscription = (): ReferenceAnalysisUsage => ({
    ...usage,
    estimatedTranscriptionUsd: Number(transcriptionUsd.toFixed(6)),
    estimatedTotalUsd: Number((usage.estimatedInputUsd + usage.estimatedOutputUsd + transcriptionUsd).toFixed(6)),
  });
  try {
    prepared = await prepareInlineVideo(videoPath, options.signal);
    const totalDuration = scenes.reduce((max, scene) => Math.max(max, scene.endTime), 0);
    const chunks = planFullDetailAnalysisChunks(scenes, totalDuration);
    const globalStoryboardParts = chunks.length > 1
      ? await buildGlobalStoryboardParts(scenes)
      : [];
    logger.info({
      sceneCount: scenes.length,
      duration: Number(totalDuration.toFixed(3)),
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        sceneIndices: chunk.scenes.map((scene) => scene.index),
        range: [chunk.startTime, chunk.endTime],
        contextRange: [chunk.contextStartTime, chunk.contextEndTime],
      })),
    }, chunks.length > 1 ? "Planned full-detail reference chunks" : "Reference fits one full-detail request");

    const requestScenes = async (
      targetScenes: SceneSegment[],
      label: string
    ): Promise<unknown[]> => {
      if (options.signal?.aborted) throw new DOMException("Reference analysis cancelled", "AbortError");
      const startTime = targetScenes[0]!.startTime;
      const endTime = targetScenes[targetScenes.length - 1]!.endTime;
      const completeReference = targetScenes.length === scenes.length &&
        startTime <= scenes[0]!.startTime && endTime >= scenes[scenes.length - 1]!.endTime;
      const window: FullDetailPromptWindow | undefined = completeReference ? undefined : {
        startTime,
        endTime,
        contextStartTime: Math.max(0, startTime - FULL_DETAIL_CHUNK_CONTEXT_SECONDS),
        contextEndTime: Math.min(totalDuration, endTime + FULL_DETAIL_CHUNK_CONTEXT_SECONDS),
      };
      const response = await ai.models.generateContent({
        model: env.GEMINI_VIDEO_ANALYSIS_MODEL,
        contents: [{
          role: "user",
          parts: [
            ...(window ? globalStoryboardParts : []),
            ...(window ? [{ text: "TARGET VIDEO — analyze this range at the maximum supported 24 FPS:" }] : []),
            buildInlineVideoPart(
              prepared!.data,
              FULL_DETAIL_FPS,
              window ? { startTime: window.contextStartTime, endTime: window.contextEndTime } : undefined
            ),
            {
              text: buildPrompt(
                targetScenes,
                transcript,
                audio,
                evidenceForScenes(options.evidence, targetScenes),
                window,
                scenes
              ),
            },
          ],
        }],
        config: {
          responseMimeType: "application/json",
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          abortSignal: options.signal,
          httpOptions: {
            timeout: 180_000,
            retryOptions: {
              attempts: 2,
              initialDelay: 1,
              maxDelay: 3,
              expBase: 2,
              jitter: 0.25,
            },
          },
        },
      });
      usage = combineUsage(usage, estimateReferenceUsage(response.usageMetadata, 0, FULL_DETAIL_FPS));
      const raw = response.text || "{}";
      const parsed = parseSceneResponse(raw);
      const finishReason = response.candidates?.[0]?.finishReason;
      const expectedIndices = new Set(targetScenes.map((scene) => scene.index));
      const returnedIndices = parsed.scenes.flatMap((scene: any) =>
        Number.isInteger(scene?.index) ? [scene.index as number] : []
      );
      const contractValid = parsed.complete &&
        parsed.scenes.length === targetScenes.length &&
        returnedIndices.length === targetScenes.length &&
        new Set(returnedIndices).size === targetScenes.length &&
        returnedIndices.every((index) => expectedIndices.has(index));
      logger.info({
        label,
        sceneIndices: targetScenes.map((scene) => scene.index),
        range: [startTime, endTime],
        responseChars: raw.length,
        finishReason,
        recoveredScenes: parsed.scenes.length,
        completeJson: parsed.complete,
        contractValid,
        usage: estimateReferenceUsage(response.usageMetadata, 0, FULL_DETAIL_FPS),
      }, "Full-detail reference chunk response received");
      if (!contractValid) {
        logger.warn({
          label,
          sceneIndices: targetScenes.map((scene) => scene.index),
          responseChars: raw.length,
          finishReason,
          recoveredScenes: parsed.scenes.length,
          err: parsed.error,
        }, "Reference chunk violated the scene response contract; adaptively dividing only missing scenes");
      }
      return parsed.scenes;
    };

    const collected = new Map<number, unknown>(canResume
      ? Object.entries(options.checkpoint!.rawScenes)
        .filter(([index]) => Number.isInteger(Number(index)))
        .map(([index, value]) => [Number(index), value] as const)
      : []);
    const emitCheckpoint = async () => {
      if (!options.onCheckpoint) return;
      await options.onCheckpoint({
        schemaVersion: 1,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        model: env.GEMINI_VIDEO_ANALYSIS_MODEL,
        sceneSignature,
        rawScenes: Object.fromEntries([...collected.entries()].sort(([left], [right]) => left - right)),
        usage: usageWithTranscription(),
        updatedAt: new Date().toISOString(),
      });
    };
    if (collected.size) {
      logger.info({ resumedScenes: [...collected.keys()].sort((a, b) => a - b) }, "Resuming full-detail analysis from durable scene checkpoints");
    }
    const accept = (rawScenes: unknown[], targetScenes: SceneSegment[]) => {
      const targetIndices = new Set(targetScenes.map((scene) => scene.index));
      for (const raw of rawScenes as any[]) {
        if (!raw || typeof raw !== "object" || !Number.isInteger(raw.index)) continue;
        if (!targetIndices.has(raw.index) || collected.has(raw.index)) continue;
        collected.set(raw.index, raw);
      }
    };
    const analyzeAdaptiveGroup = async (
      targetScenes: SceneSegment[],
      label: string,
      depth = 0
    ): Promise<void> => {
      targetScenes = targetScenes.filter((scene) => !collected.has(scene.index));
      if (!targetScenes.length) return;
      let lastError: unknown;
      const attempts = targetScenes.length === 1 ? 2 : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          accept(await requestScenes(targetScenes, `${label}-attempt-${attempt}`), targetScenes);
          await emitCheckpoint();
        } catch (error: any) {
          if (error?.name === "AbortError" || options.signal?.aborted) throw error;
          lastError = error;
        }
        const missing = targetScenes.filter((scene) => !collected.has(scene.index));
        if (!missing.length) return;
        if (targetScenes.length > 1) break;
      }
      const missing = targetScenes.filter((scene) => !collected.has(scene.index));
      if (missing.length > 1) {
        const [left, right] = bisectSceneGroupAtMidpoint(missing);
        logger.warn({
          label,
          depth,
          missingSceneIndices: missing.map((scene) => scene.index),
          subdivisions: [left.map((scene) => scene.index), right.map((scene) => scene.index)],
        }, "Adaptively subdividing failed full-detail range at a detected scene boundary");
        await analyzeAdaptiveGroup(left, `${label}-left`, depth + 1);
        await analyzeAdaptiveGroup(right, `${label}-right`, depth + 1);
        return;
      }
      const scene = missing[0]!;
      throw new Error(
        `Full-detail reference analysis failed for scene ${scene.index} (${scene.startTime.toFixed(3)}-${scene.endTime.toFixed(3)}s)`,
        { cause: lastError }
      );
    };

    for (const chunk of chunks) {
      await analyzeAdaptiveGroup(chunk.scenes, `detail-chunk-${chunk.index}`);
    }
    const rawScenes = [...collected.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, raw]) => raw);
    const byIndex = new Map<number, any>(
      rawScenes.map((scene: any, position: number) => [Number.isInteger(scene?.index) ? scene.index : position, scene])
    );
    if (byIndex.size !== scenes.length) {
      throw new Error(`Full-detail model returned ${byIndex.size}/${scenes.length} detailed scene analyses`);
    }
    const normalized = scenes.map((scene) => sanitizeSegmentData(byIndex.get(scene.index) || {}));

    let integrity = validateBlueprintIntegrity({
      segments: normalized.map((value, index) => ({
        index,
        startTime: scenes[index]?.startTime || 0,
        duration: scenes[index]?.duration || 1,
        ...value,
        onBeat: false,
      })),
      analysisEvidence: options.evidence,
    }, { allowRepairableSemantics: true });
    // Do not discard valid full-detail scenes when one interval is incomplete.
    // Re-open only failed deterministic scene ranges at native editorial detail.
    if (!integrity.ok) {
      const failedScenes = [...new Set(integrity.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.segmentIndex))]
        .slice(0, 4);
      for (const sceneIndex of failedScenes) {
        const boundary = scenes[sceneIndex];
        if (!boundary) continue;
        const issueCodes = integrity.issues
          .filter((issue) => issue.segmentIndex === sceneIndex && issue.severity === "error")
          .map((issue) => issue.code);
        try {
          const focusWindow: FullDetailPromptWindow = {
            startTime: boundary.startTime,
            endTime: boundary.endTime,
            contextStartTime: Math.max(0, boundary.startTime - FULL_DETAIL_CHUNK_CONTEXT_SECONDS),
            contextEndTime: Math.min(totalDuration, boundary.endTime + FULL_DETAIL_CHUNK_CONTEXT_SECONDS),
          };
          const focusedResponse = await ai.models.generateContent({
            model: env.GEMINI_VIDEO_ANALYSIS_MODEL,
            contents: [{
              role: "user",
              parts: [
                ...globalStoryboardParts,
                ...(globalStoryboardParts.length
                  ? [{ text: "FOCUSED TARGET VIDEO — repair only this failed structural interval at 24 FPS:" }]
                  : []),
                buildInlineVideoPart(prepared.data, FOCUSED_DETAIL_FPS, {
                  startTime: focusWindow.contextStartTime,
                  endTime: focusWindow.contextEndTime,
                }),
                {
                  text: `${buildPrompt([boundary], transcript, audio, evidenceForScenes(options.evidence, [boundary]), focusWindow, scenes)}

FOCUSED STRUCTURAL REPAIR. The prior full-detail blueprint failed these invariants: ${issueCodes.join(", ")}.
Prior scene candidate: ${JSON.stringify(normalized[sceneIndex])}
Return one corrected scene. Preserve valid prior semantics, but measure the missing matte link, font/glyph geometry, simultaneous layer inventory, global zIndex, phases, and entrance/scale keyframes. Do not merely rewrite the description.`,
                },
              ],
            }],
            config: {
              responseMimeType: "application/json",
              mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
              thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
              abortSignal: options.signal,
              httpOptions: {
                timeout: 180_000,
                retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 3, expBase: 2, jitter: 0.25 },
              },
            },
          });
          usage = combineUsage(usage, estimateReferenceUsage(focusedResponse.usageMetadata, 0, FOCUSED_DETAIL_FPS));
          const parsedFocused = parseSceneResponse(focusedResponse.text || "{}");
          const rawFocused = parsedFocused.scenes[0];
          if (!rawFocused) continue;
          const candidate = sanitizeSegmentData(rawFocused);
          const selected = chooseReliableSegment(
            asBlueprintSegment(normalized[sceneIndex]!, boundary, sceneIndex),
            asBlueprintSegment(candidate, boundary, sceneIndex),
            options.evidence
          );
          const { index: _index, startTime: _startTime, duration: _duration, onBeat: _onBeat, ...partial } = selected;
          normalized[sceneIndex] = partial;
          collected.set(sceneIndex, rawFocused);
          await emitCheckpoint();
        } catch (err: any) {
          if (err?.name === "AbortError" || options.signal?.aborted) throw err;
          logger.warn({ err: err?.message, sceneIndex, issueCodes }, "Focused reference repair unavailable");
        }
      }
      integrity = validateBlueprintIntegrity({
        segments: normalized.map((value, index) => asBlueprintSegment(value, scenes[index]!, index)),
        analysisEvidence: options.evidence,
      }, { allowRepairableSemantics: true });
    }
    if (!integrity.ok) {
      const summary = integrity.issues
        .filter((issue) => issue.severity === "error")
        .slice(0, 8)
        .map((issue) => `${issue.code}@scene${issue.segmentIndex}`)
        .join(", ");
      const error = new Error(`Reference analysis remained structurally incomplete after focused repair: ${summary}`);
      Object.defineProperty(error, "code", {
        value: "REFERENCE_ANALYSIS_INCOMPLETE",
        enumerable: true,
        configurable: true,
      });
      throw error;
    }
    const finalUsage = usageWithTranscription();
    logger.info({ sceneCount: normalized.length, usage: finalUsage }, "Full-detail reference analysis complete");
    return { scenes: normalized, usage: finalUsage };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    Object.defineProperty(err, "analysisUsage", {
      value: usageWithTranscription(),
      enumerable: true,
      configurable: true,
    });
    throw err;
  } finally {
    await prepared?.cleanup();
  }
}

/** Re-open a precise range of the retained reference for a later agent turn. */
export async function inspectReferenceVideoRange(
  videoPath: string,
  startTime: number,
  endTime: number,
  question: string,
  options: { signal?: AbortSignal; fps?: number } = {}
): Promise<ReferenceRangeInspection> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const inspectionFps = Math.max(2, Math.min(24, Number(options.fps) || FULL_DETAIL_FPS));
  let prepared: PreparedInlineVideo | undefined;
  try {
    prepared = await prepareInlineVideo(videoPath, options.signal);
    const response = await ai.models.generateContent({
      model: env.GEMINI_VIDEO_ANALYSIS_MODEL,
      contents: [{
        role: "user",
        parts: [
          buildInlineVideoPart(prepared.data, inspectionFps, { startTime, endTime }),
          {
            text: `Inspect only the attached reference range ${startTime.toFixed(3)}-${endTime.toFixed(3)} seconds. Answer this production question: ${question}

Return a production reconstruction specification, not a general description. Inventory every simultaneously visible layer and its z-order; distinguish full-frame plates, independent panels, masks/mattes, and text. Report exact text, glyph fill (solid or media), split unit (character/word/line/whole), normalized geometry, and measured channel/keyframe timing. For every video/image layer report normalized viewport x/y/width/height, fit, relative start/end, reveal direction, and geometry keyframes. Report transition duration and outgoing/incoming motion without forcing a preset name. Explicitly say when there is NO whole-layer text movement. Include absolute timestamps and normalized range ratios. Do not claim evidence you cannot see or hear.

Return JSON only:
{"summary":"...","confidence":0.0,"layers":[{"id":"...","kind":"video|image|text|shape","role":"background|panel|matte-fill|overlay","zIndex":0,"content":"...","startTime":0,"endTime":1,"viewport":{"x":0,"y":0,"width":1,"height":1},"fit":"cover|contain","matteSourceId":"optional","keyframes":[]}],"textStates":[{"text":"EXACT","fillMode":"solid|media-matte","unit":"char|word|line|whole","startTime":0,"endTime":1,"geometry":{"x":0.5,"y":0.5,"width":0.5,"height":0.1},"channels":[],"wholeLayerMotion":[]}],"transitions":[{"startTime":0,"duration":0.2,"outgoing":[],"incoming":[],"presetType":"only-if-exact"}],"audioEvidence":[],"recommendedOperations":[]}`,
          },
        ],
      }],
      config: {
        responseMimeType: "application/json",
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        abortSignal: options.signal,
      },
    });
    const raw = response.text || "{}";
    let reconstructionSpec: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reconstructionSpec = parsed;
    } catch {
      // Preserve raw evidence when the model violates JSON mode unexpectedly.
    }
    return {
      analysis: typeof reconstructionSpec?.summary === "string"
        ? reconstructionSpec.summary
        : raw || "No inspectable evidence returned.",
      ...(reconstructionSpec ? { reconstructionSpec } : {}),
      usage: estimateReferenceUsage(response.usageMetadata, 0, inspectionFps),
    };
  } finally {
    await prepared?.cleanup();
  }
}
