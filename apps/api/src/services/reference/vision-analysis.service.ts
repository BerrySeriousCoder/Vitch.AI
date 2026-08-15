import { GoogleGenAI } from "@google/genai";
import { readFile } from "fs/promises";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { SceneSegment } from "./scene-detection.service.js";
import type { BlueprintSegment, BlueprintTextOverlay } from "@tempo/types";

const VISION_PROMPT = `Analyze these ORDERED frames from one video segment as a short temporal sequence. Infer motion and speed only from visible change across the ordered frames, not from a single still. A final frame labelled NEXT_SCENE is provided only to classify the cut/transition. Return a JSON object with EXACTLY these fields:
{
  "shotType": "close-up" | "medium" | "wide" | "extreme-close-up" | "bird-eye" | "other",
  "motionType": "static" | "pan" | "zoom-in" | "zoom-out" | "shake" | "whip-pan" | "tracking" | "rotate",
  "motionConfidence": 0.0,
  "transitionToNext": "cut" | "fade" | "dissolve" | "zoom" | "whip" | "glitch" | "swipe" | "none",
  "transitionConfidence": 0.0,
  "energyLevel": 0-100,
  "visualDescription": "brief description of what's in the frame",
  "colorPalette": ["#hex1", "#hex2", "#hex3"],
  "effects": ["effect names if any, e.g. film-grain, vignette, lens-flare"],
  "textOverlays": [{"text": "EXACT visible text", "style": "bold|minimal|kinetic|typewriter|glitch|bounce", "position": "top|center|bottom|custom", "animation": "free description", "fillMode":"solid|media-matte", "animationSpec":{"unit":"whole|char|word|line","channels":[{"property":"opacity|offsetX|offsetY|scale|rotation|tracking|blur","from":0,"to":1,"offsetRatio":0,"durationRatio":0.1,"staggerRatio":0.05,"easing":"linear|ease-in|ease-out|ease-in-out"}],"motion":{"keyframes":[]},"confidence":0.0}, "appearance": {"fontFamilyClass": "sans|serif|display|monospace|handwritten", "fontFamilyHint": "closest Google Fonts family", "fontWidth": "condensed|normal|wide", "fontWeight": 700, "fontSizeRatio": 0.06, "color": "#FFFFFF", "strokeColor": "#000000", "strokeWidthRatio": 0.025, "backgroundColor": "#000000", "backgroundOpacity": 0.0, "textAlign": "left|center|right", "letterSpacingRatio": 0.0, "uppercase": true, "shadow": false, "rotation": 0, "confidence": 0.0}, "geometry": {"x": 0.5, "y": 0.5, "width": 0.6, "height": 0.12, "confidence": 0.0}, "timing": {"startRatio": 0.0, "endRatio": 1.0, "confidence": 0.0}}],
  "composition":{"replaceBase":true,"backgroundColor":"#000000","confidence":0.0,"layers":[{"id":"stable-id","role":"background|panel|matte-fill|overlay","contentDescription":"what this independently matched source depicts","zIndex":0,"timing":{"startRatio":0,"endRatio":1,"confidence":0.0},"viewport":{"x":0,"y":0,"width":1,"height":1},"fit":"cover|contain","matteTextOverlayIndex":0,"motion":{"confidence":0.0,"keyframes":[{"timeRatio":0,"viewport":{"x":0,"y":0,"width":1,"height":1},"opacity":1,"offsetXRatio":0,"offsetYRatio":0,"scaleX":1,"scaleY":1,"rotation":0,"easing":"linear"}]} }],"phases":[{"id":"phase-1","label":"visible state","startRatio":0,"endRatio":1,"activeLayerIds":["stable-id"],"activeTextOverlayIndices":[0],"confidence":0.0}]},
  "transitionSpec":{"durationRatio":0.1,"direction":"left|right|up|down","presetType":"optional exact match only","outgoing":{"keyframes":[]},"incoming":{"keyframes":[]},"confidence":0.0},
  "speed": 1.0,
  "speedConfidence": 0.0
}
Transcribe every legible editorial text overlay exactly. A scene may contain multiple internal compositing phases even without a cut. For every multi-layer composition, emit phases containing every simultaneously visible layer/text id. Report media-inside-text as a matte-fill layer only when matteTextOverlayIndex points to an existing textOverlays item whose fillMode is media-matte; otherwise do not emit a matte link. Simultaneous videos are independent composition layers. Report viewport/text keyframes only when motion is visible across the ordered samples; a later static appearance may use timing without invented motion. Do not invent whole-text movement when only characters reveal. If an observed transition does not match a known preset, leave presetType absent and report outgoing/incoming motion. Only return the JSON.`;

export interface PartialSegmentData {
  shotType: BlueprintSegment["shotType"];
  motionType: BlueprintSegment["motionType"];
  transitionToNext: BlueprintSegment["transitionToNext"];
  energyLevel: number;
  visualDescription: string;
  colorPalette: string[];
  effects: string[];
  textOverlays: BlueprintTextOverlay[];
  speed: number;
  composition?: BlueprintSegment["composition"];
  transitionSpec?: BlueprintSegment["transitionSpec"];
}

const MOTION_EASINGS = ["hold", "linear", "ease-in", "ease-out", "ease-in-out"] as const;

function safeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().replace(/[^a-zA-Z0-9:_-]/g, "-").slice(0, 80);
  return id || undefined;
}

function unit(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function sanitizeRect(raw: any) {
  if (!raw || typeof raw !== "object") return undefined;
  const x = Math.min(0.999, unit(raw.x));
  const y = Math.min(0.999, unit(raw.y));
  const width = Math.max(0.001, Math.min(1 - x, Number(raw.width) || 0));
  const height = Math.max(0.001, Math.min(1 - y, Number(raw.height) || 0));
  if (!(width > 0) || !(height > 0)) return undefined;
  return { x, y, width, height };
}

function sanitizeMotion(raw: any): NonNullable<BlueprintSegment["composition"]>["layers"][number]["motion"] {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.keyframes)) return undefined;
  const keyframes = raw.keyframes.slice(0, 16).map((item: any) => {
    const easing = MOTION_EASINGS.includes(item?.easing) ? item.easing : undefined;
    const viewport = sanitizeRect(item?.viewport);
    const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : undefined;
    return {
      timeRatio: unit(item?.timeRatio),
      ...(safeId(item?.syncEventId) ? { syncEventId: safeId(item.syncEventId)! } : {}),
      ...(easing ? { easing } : {}),
      ...(viewport ? { viewport } : {}),
      ...(finite(item?.opacity) !== undefined ? { opacity: unit(item.opacity) } : {}),
      ...(finite(item?.offsetXRatio) !== undefined ? { offsetXRatio: Math.max(-2, Math.min(2, Number(item.offsetXRatio))) } : {}),
      ...(finite(item?.offsetYRatio) !== undefined ? { offsetYRatio: Math.max(-2, Math.min(2, Number(item.offsetYRatio))) } : {}),
      ...(finite(item?.scaleX) !== undefined ? { scaleX: Math.max(0, Math.min(10, Number(item.scaleX))) } : {}),
      ...(finite(item?.scaleY) !== undefined ? { scaleY: Math.max(0, Math.min(10, Number(item.scaleY))) } : {}),
      ...(finite(item?.rotation) !== undefined ? { rotation: Math.max(-1080, Math.min(1080, Number(item.rotation))) } : {}),
    };
  }).sort((a: { timeRatio: number }, b: { timeRatio: number }) => a.timeRatio - b.timeRatio);
  if (keyframes.length === 0) return undefined;
  return {
    keyframes,
    ...(Number.isFinite(Number(raw.confidence)) ? { confidence: unit(raw.confidence) } : {}),
  };
}

function sanitizeTextAnimation(raw: any): BlueprintTextOverlay["animationSpec"] {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.channels)) return undefined;
  const units = ["whole", "char", "word", "line"] as const;
  const properties = ["opacity", "offsetX", "offsetY", "scale", "rotation", "tracking", "blur"] as const;
  const channels = raw.channels.slice(0, 12).flatMap((channel: any) => {
    if (!properties.includes(channel?.property)) return [];
    const from = Number(channel.from);
    const to = Number(channel.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
    const easing = MOTION_EASINGS.includes(channel.easing) ? channel.easing : undefined;
    const unitStartRatios = Array.isArray(channel.unitStartRatios)
      ? channel.unitStartRatios.slice(0, 512).map((value: unknown) => unit(value))
      : undefined;
    const unitSyncEventIds = Array.isArray(channel.unitSyncEventIds)
      ? channel.unitSyncEventIds.slice(0, 512).map(safeId).filter((id: string | undefined): id is string => Boolean(id))
      : undefined;
    const keyframes = Array.isArray(channel.keyframes)
      ? channel.keyframes.slice(0, 64).flatMap((keyframe: any) => {
          const value = Number(keyframe?.value);
          if (!Number.isFinite(value)) return [];
          const keyframeEasing = MOTION_EASINGS.includes(keyframe.easing) ? keyframe.easing : undefined;
          return [{ timeRatio: unit(keyframe.timeRatio), value, ...(keyframeEasing ? { easing: keyframeEasing } : {}) }];
        }).sort((a: { timeRatio: number }, b: { timeRatio: number }) => a.timeRatio - b.timeRatio)
      : undefined;
    return [{
      property: channel.property,
      from,
      to,
      offsetRatio: unit(channel.offsetRatio),
      durationRatio: Math.max(0.001, unit(channel.durationRatio, 0.1)),
      staggerRatio: unit(channel.staggerRatio),
      ...(unitStartRatios?.length ? { unitStartRatios } : {}),
      ...(unitSyncEventIds?.length ? { unitSyncEventIds } : {}),
      ...(keyframes && keyframes.length >= 2 ? { keyframes } : {}),
      ...(easing ? { easing } : {}),
    }];
  });
  if (channels.length === 0) return undefined;
  const unitMode = units.includes(raw.unit) ? raw.unit : "whole";
  const motion = sanitizeMotion(raw.motion);
  return {
    unit: unitMode,
    channels,
    ...(motion ? { motion } : {}),
    ...(Number.isFinite(Number(raw.confidence)) ? { confidence: unit(raw.confidence) } : {}),
  };
}

function sanitizeComposition(raw: any): BlueprintSegment["composition"] {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.layers)) return undefined;
  const roles = ["background", "panel", "matte-fill", "overlay"] as const;
  const ids = new Set<string>();
  const layers = raw.layers.slice(0, 24).flatMap((layer: any, index: number) => {
    const viewport = sanitizeRect(layer?.viewport);
    if (!viewport) return [];
    let id = String(layer.id || `layer-${index}`).trim().slice(0, 80) || `layer-${index}`;
    if (ids.has(id)) id = `${id}-${index}`;
    ids.add(id);
    const startRatio = unit(layer.timing?.startRatio);
    const endRatio = Math.max(startRatio + 0.001, unit(layer.timing?.endRatio, 1));
    const motion = sanitizeMotion(layer.motion);
    return [{
      id,
      role: roles.includes(layer.role) ? layer.role : "panel",
      contentDescription: String(layer.contentDescription || "reference media layer").slice(0, 240),
      zIndex: Math.max(-100, Math.min(100, Math.round(Number(layer.zIndex) || index))),
      timing: {
        startRatio,
        endRatio: Math.min(1, endRatio),
        ...(Number.isFinite(Number(layer.timing?.confidence)) ? { confidence: unit(layer.timing.confidence) } : {}),
      },
      viewport,
      fit: layer.fit === "contain" ? "contain" : "cover",
      ...(layer.focalPoint && typeof layer.focalPoint === "object"
        ? { focalPoint: { x: unit(layer.focalPoint.x, 0.5), y: unit(layer.focalPoint.y, 0.5) } }
        : {}),
      ...(motion ? { motion } : {}),
      ...(Number.isInteger(Number(layer.matteTextOverlayIndex)) && Number(layer.matteTextOverlayIndex) >= 0
        ? { matteTextOverlayIndex: Math.floor(Number(layer.matteTextOverlayIndex)) }
        : {}),
    }];
  }).sort((a: { zIndex: number }, b: { zIndex: number }) => a.zIndex - b.zIndex);
  if (layers.length === 0) return undefined;
  const backgroundColor = /^#[0-9a-f]{6}$/i.test(String(raw.backgroundColor || ""))
    ? String(raw.backgroundColor).toUpperCase()
    : undefined;
  const phases = Array.isArray(raw.phases)
    ? raw.phases.slice(0, 32).flatMap((phase: any, index: number) => {
        if (!phase || typeof phase !== "object") return [];
        const startRatio = unit(phase.startRatio);
        const endRatio = Math.max(startRatio + 0.001, unit(phase.endRatio, 1));
        const activeLayerIds = Array.isArray(phase.activeLayerIds)
          ? phase.activeLayerIds.map(safeId).filter((id: string | undefined): id is string => id !== undefined && ids.has(id))
          : [];
        const activeTextOverlayIndices = Array.isArray(phase.activeTextOverlayIndices)
          ? phase.activeTextOverlayIndices.map(Number).filter((value: number) => Number.isInteger(value) && value >= 0).slice(0, 24)
          : [];
        return [{
          id: safeId(phase.id) || `phase-${index}`,
          label: String(phase.label || `Composition phase ${index + 1}`).slice(0, 160),
          startRatio,
          endRatio: Math.min(1, endRatio),
          ...(safeId(phase.syncEventId) ? { syncEventId: safeId(phase.syncEventId)! } : {}),
          activeLayerIds,
          activeTextOverlayIndices,
          ...(Number.isFinite(Number(phase.confidence)) ? { confidence: unit(phase.confidence) } : {}),
        }];
      })
    : undefined;
  return {
    replaceBase: raw.replaceBase === true,
    ...(backgroundColor ? { backgroundColor } : {}),
    layers,
    ...(phases?.length ? { phases } : {}),
    ...(Number.isFinite(Number(raw.confidence)) ? { confidence: unit(raw.confidence) } : {}),
  };
}

function sanitizeTransitionSpec(raw: any): BlueprintSegment["transitionSpec"] {
  if (!raw || typeof raw !== "object") return undefined;
  const directions = ["left", "right", "up", "down"] as const;
  const outgoing = sanitizeMotion(raw.outgoing);
  const incoming = sanitizeMotion(raw.incoming);
  const easing = MOTION_EASINGS.includes(raw.easing) ? raw.easing : undefined;
  const presetType = typeof raw.presetType === "string" && raw.presetType.trim()
    ? raw.presetType.trim().slice(0, 80)
    : undefined;
  if (!presetType && !outgoing && !incoming) return undefined;
  return {
    ...(Number(raw.durationRatio) > 0 ? { durationRatio: Math.max(0.01, unit(raw.durationRatio)) } : {}),
    ...(directions.includes(raw.direction) ? { direction: raw.direction } : {}),
    ...(Number.isFinite(Number(raw.softness)) ? { softness: Math.max(0, Math.min(0.5, Number(raw.softness))) } : {}),
    ...(easing ? { easing } : {}),
    ...(presetType ? { presetType } : {}),
    ...(outgoing ? { outgoing } : {}),
    ...(incoming ? { incoming } : {}),
    ...(Number.isFinite(Number(raw.confidence)) ? { confidence: unit(raw.confidence) } : {}),
  };
}

async function analyzeFrameSequence(
  framePaths: string[],
  nextSceneFrame?: string,
  signal?: AbortSignal
): Promise<PartialSegmentData> {
  if (!env.GEMINI_API_KEY) return defaultSegmentData();

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) try {
    if (signal?.aborted) throw new DOMException("Reference vision analysis cancelled", "AbortError");
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const parts: any[] = [{ text: VISION_PROMPT }];
    for (let index = 0; index < framePaths.length; index++) {
      const imageData = await readFile(framePaths[index]!);
      parts.push({ text: `CURRENT_SCENE_FRAME_${index + 1}` });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: imageData.toString("base64") } });
    }
    if (nextSceneFrame) {
      const imageData = await readFile(nextSceneFrame);
      parts.push({ text: "NEXT_SCENE_FRAME (transition evidence only)" });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: imageData.toString("base64") } });
    }

    const result = await ai.models.generateContent({
      model: env.GEMINI_VIDEO_ANALYSIS_MODEL,
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      config: {
        responseMimeType: "application/json",
        abortSignal: signal,
        httpOptions: {
          timeout: 90_000,
          retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 3, expBase: 2, jitter: 0.25 },
        },
      },
    });

    const text = result.text || result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return sanitizeSegmentData(JSON.parse(jsonMatch[0]));
    }
    lastError = new Error("Sampled-frame model returned no JSON object");
  } catch (error: any) {
    if (error?.name === "AbortError" || signal?.aborted) throw error;
    lastError = error;
  }
  const err = lastError instanceof Error ? lastError : new Error(String(lastError || "unknown error"));
  logger.warn({ err, framePaths }, "Sampled-frame vision analysis failed after retries");
  throw err;
}

export function sanitizeSegmentData(raw: any): PartialSegmentData {
  const validShots = [
    "close-up",
    "medium",
    "wide",
    "extreme-close-up",
    "bird-eye",
    "other",
  ] as const;
  const validMotion = [
    "static",
    "pan",
    "zoom-in",
    "zoom-out",
    "shake",
    "whip-pan",
    "tracking",
    "rotate",
  ] as const;
  const validTransition = [
    "cut",
    "fade",
    "dissolve",
    "zoom",
    "whip",
    "glitch",
    "swipe",
    "none",
  ] as const;

  const motionConfidence = Math.max(0, Math.min(1, Number(raw.motionConfidence) || 0));
  const transitionConfidence = Math.max(0, Math.min(1, Number(raw.transitionConfidence) || 0));
  const speedConfidence = Math.max(0, Math.min(1, Number(raw.speedConfidence) || 0));
  return {
    shotType: validShots.includes(raw.shotType) ? raw.shotType : "medium",
    motionType: motionConfidence >= 0.55 && validMotion.includes(raw.motionType) ? raw.motionType : "static",
    transitionToNext: transitionConfidence >= 0.55 && validTransition.includes(raw.transitionToNext)
      ? raw.transitionToNext
      : "cut",
    energyLevel: Math.max(0, Math.min(100, Number(raw.energyLevel) || 50)),
    visualDescription: String(raw.visualDescription || "Scene").slice(0, 200),
    colorPalette: Array.isArray(raw.colorPalette)
      ? raw.colorPalette.slice(0, 5).map(String)
      : ["#333333"],
    effects: Array.isArray(raw.effects) ? raw.effects.slice(0, 5).map(String) : [],
    textOverlays: Array.isArray(raw.textOverlays)
      ? raw.textOverlays.slice(0, 24).map((t: any) => {
          const geometry = t.geometry && typeof t.geometry === "object"
            ? {
                x: Math.max(0, Math.min(1, Number(t.geometry.x) || 0.5)),
                y: Math.max(0, Math.min(1, Number(t.geometry.y) || 0.5)),
                ...(Number(t.geometry.width) > 0 ? { width: Math.min(1, Number(t.geometry.width)) } : {}),
                ...(Number(t.geometry.height) > 0 ? { height: Math.min(1, Number(t.geometry.height)) } : {}),
                ...(Number.isFinite(Number(t.geometry.confidence)) ? { confidence: Math.max(0, Math.min(1, Number(t.geometry.confidence))) } : {}),
              }
            : undefined;
          const timingStart = Math.max(0, Math.min(1, Number(t.timing?.startRatio) || 0));
          const timingEnd = Math.max(timingStart, Math.min(1, Number(t.timing?.endRatio) || 1));
          const timing = t.timing && typeof t.timing === "object"
            ? {
                startRatio: timingStart,
                endRatio: timingEnd,
                ...(Number.isFinite(Number(t.timing.confidence)) ? { confidence: Math.max(0, Math.min(1, Number(t.timing.confidence))) } : {}),
              }
            : undefined;
          const rawAppearance = t.appearance && typeof t.appearance === "object" ? t.appearance : undefined;
          const fontClasses = ["sans", "serif", "display", "monospace", "handwritten"];
          const fontWidths = ["condensed", "normal", "wide"];
          const aligns = ["left", "center", "right"];
          const color = (value: unknown) => /^#[0-9a-f]{6}$/i.test(String(value || ""))
            ? String(value).toUpperCase()
            : undefined;
          const appearance = rawAppearance
            ? {
                ...(fontClasses.includes(rawAppearance.fontFamilyClass) ? { fontFamilyClass: rawAppearance.fontFamilyClass } : {}),
                ...(typeof rawAppearance.fontFamilyHint === "string" && rawAppearance.fontFamilyHint.trim()
                  ? { fontFamilyHint: rawAppearance.fontFamilyHint.trim().slice(0, 100) }
                  : {}),
                ...(fontWidths.includes(rawAppearance.fontWidth) ? { fontWidth: rawAppearance.fontWidth } : {}),
                ...(Number.isFinite(Number(rawAppearance.fontWeight)) ? { fontWeight: Math.max(100, Math.min(900, Math.round(Number(rawAppearance.fontWeight) / 100) * 100)) } : {}),
                ...(Number(rawAppearance.fontSizeRatio) > 0 ? { fontSizeRatio: Math.max(0.012, Math.min(0.25, Number(rawAppearance.fontSizeRatio))) } : {}),
                ...(color(rawAppearance.color) ? { color: color(rawAppearance.color)! } : {}),
                ...(color(rawAppearance.strokeColor) ? { strokeColor: color(rawAppearance.strokeColor)! } : {}),
                ...(Number.isFinite(Number(rawAppearance.strokeWidthRatio)) ? { strokeWidthRatio: Math.max(0, Math.min(0.2, Number(rawAppearance.strokeWidthRatio))) } : {}),
                ...(color(rawAppearance.backgroundColor) ? { backgroundColor: color(rawAppearance.backgroundColor)! } : {}),
                ...(Number.isFinite(Number(rawAppearance.backgroundOpacity)) ? { backgroundOpacity: Math.max(0, Math.min(1, Number(rawAppearance.backgroundOpacity))) } : {}),
                ...(aligns.includes(rawAppearance.textAlign) ? { textAlign: rawAppearance.textAlign } : {}),
                ...(Number.isFinite(Number(rawAppearance.letterSpacingRatio)) ? { letterSpacingRatio: Math.max(-0.1, Math.min(0.5, Number(rawAppearance.letterSpacingRatio))) } : {}),
                ...(typeof rawAppearance.uppercase === "boolean" ? { uppercase: rawAppearance.uppercase } : {}),
                ...(typeof rawAppearance.shadow === "boolean" ? { shadow: rawAppearance.shadow } : {}),
                ...(Number.isFinite(Number(rawAppearance.rotation)) ? { rotation: Math.max(-180, Math.min(180, Number(rawAppearance.rotation))) } : {}),
                ...(Number.isFinite(Number(rawAppearance.confidence)) ? { confidence: Math.max(0, Math.min(1, Number(rawAppearance.confidence))) } : {}),
              }
            : undefined;
          const animationSpec = sanitizeTextAnimation(t.animationSpec);
          return {
            text: String(t.text || ""),
            style: t.style || "bold",
            position: t.position || "center",
            animation: t.animation || "none",
            ...(Number.isFinite(Number(t.zIndex))
              ? { zIndex: Math.max(-100, Math.min(100, Math.round(Number(t.zIndex)))) }
              : {}),
            ...(["solid", "media-matte"].includes(t.fillMode) ? { fillMode: t.fillMode } : {}),
            ...(animationSpec ? { animationSpec } : {}),
            ...(["static", "cumulative", "exclusive"].includes(t.sequenceMode)
              ? { sequenceMode: t.sequenceMode }
              : {}),
            ...(typeof t.sequenceGroupId === "string" && t.sequenceGroupId.trim()
              ? { sequenceGroupId: t.sequenceGroupId.trim().slice(0, 80) }
              : {}),
            ...(["text-box", "full-frame"].includes(t.backgroundMode)
              ? { backgroundMode: t.backgroundMode }
              : {}),
            ...(appearance ? { appearance } : {}),
            ...(geometry ? { geometry } : {}),
            ...(timing ? { timing } : {}),
          };
        })
      : [],
    speed: speedConfidence >= 0.6
      ? Math.max(0.25, Math.min(4, Number(raw.speed) || 1))
      : 1,
    ...(sanitizeComposition(raw.composition) ? { composition: sanitizeComposition(raw.composition) } : {}),
    ...(sanitizeTransitionSpec(raw.transitionSpec) ? { transitionSpec: sanitizeTransitionSpec(raw.transitionSpec) } : {}),
  };
}

function defaultSegmentData(): PartialSegmentData {
  return {
    shotType: "medium",
    motionType: "static",
    transitionToNext: "cut",
    energyLevel: 50,
    visualDescription: "Scene",
    colorPalette: ["#333333"],
    effects: [],
    textOverlays: [],
    speed: 1,
  };
}

/**
 * Analyze all scene segments visually using Gemini Vision (multi-frame when available).
 */
export async function analyzeVisuals(
  scenes: SceneSegment[],
  options: { signal?: AbortSignal } = {}
): Promise<PartialSegmentData[]> {
  logger.info({ sceneCount: scenes.length }, "Analyzing visuals with Gemini Vision");

  const results: PartialSegmentData[] = [];
  const CONCURRENCY = 2;

  for (let i = 0; i < scenes.length; i += CONCURRENCY) {
    if (options.signal?.aborted) throw new DOMException("Reference vision analysis cancelled", "AbortError");
    const batch = scenes.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (scene) => {
        const paths =
          scene.framePaths?.length > 0 ? scene.framePaths : [scene.thumbnailPath];
        // Cap at 3 frames per scene for cost
        const limited = paths.slice(0, 3);
        const nextScene = scenes[scene.index + 1];
        const nextFrame = nextScene?.framePaths?.[0] || nextScene?.thumbnailPath;
        return analyzeFrameSequence(limited, nextFrame, options.signal);
      })
    );
    results.push(...batchResults);
  }

  logger.info({ analyzed: results.length }, "Visual analysis complete");
  return results;
}
