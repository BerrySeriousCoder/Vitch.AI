import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import { downloadReference, type DownloadResult } from "./download.service.js";
import { detectScenes, type SceneSegment } from "./scene-detection.service.js";
import { analyzeAudio } from "./audio-analysis.service.js";
import { analyzeVisuals } from "./vision-analysis.service.js";
import { analyzeWholeVideo, type WholeVideoAnalysisCheckpoint } from "./video-analysis.service.js";
import { analyzeLocalVisualEvidence } from "./local-visual-evidence.service.js";
import {
  reconcileBlueprintSemantics,
  reconcileSampledFallbackBlueprint,
  validateBlueprintIntegrity,
} from "./blueprint-reconciliation.service.js";
import { reconcileMeasuredPanelReveals } from "./panel-reveal-measurement.service.js";
import { transcribeLocalMedia } from "../media/audio-understanding.service.js";
import { analyzeColorStatistics } from "../media/color-analysis.service.js";
import { logger } from "../../utils/logger.js";
import { env } from "../../config/env.js";
import type { EditBlueprint, BlueprintSegment, AudioAnalysis, BeatInfo, MediaAudioTranscript, ReferenceAnalysisUsage } from "@tempo/types";

export type BlueprintProgressEvent =
  | { step: "downloading"; detail: string }
  | { step: "analyzing_scenes"; detail: string }
  | { step: "analyzing_audio"; detail: string }
  | { step: "analyzing_visuals"; detail: string }
  | { step: "generating_blueprint"; detail: string };

/**
 * Orchestrate the full blueprint generation pipeline.
 * Yields progress events for SSE streaming.
 */
export async function* generateBlueprint(
  url: string,
  options: {
    signal?: AbortSignal;
    analysisCheckpoint?: WholeVideoAnalysisCheckpoint;
    onAnalysisCheckpoint?: (checkpoint: WholeVideoAnalysisCheckpoint) => void | Promise<void>;
  } = {}
): AsyncGenerator<BlueprintProgressEvent | {
  step: "complete";
  blueprint: EditBlueprint;
  /** Ephemeral path valid only while the completion yield is being handled. */
  referenceAudioPath?: string;
  /** Ephemeral original video path valid only while completion is handled. */
  referenceVideoPath: string;
  referenceTranscript?: MediaAudioTranscript;
}> {
  let download: DownloadResult | null = null;

  try {
    // Step 1: Download reference video
    yield { step: "downloading", detail: "Downloading reference video..." };
    download = await downloadReference(url, options.signal);
    if (options.signal?.aborted) throw new DOMException("Reference analysis cancelled", "AbortError");

    // Step 2 & 3: Scene detection + Audio analysis in parallel
    yield { step: "analyzing_scenes", detail: "Detecting scenes..." };

    const scenesDir = download.workDir + "/scenes";
    const { mkdir } = await import("fs/promises");
    await mkdir(scenesDir, { recursive: true });

    const [scenes, audioAnalysis, colorStatistics, referenceTranscript] = await Promise.all([
      detectScenes(download.videoPath, scenesDir, download.metadata.duration, 0.3, options.signal),
      analyzeAudio(download.audioPath, download.metadata.duration, options),
      analyzeColorStatistics(download.videoPath, download.metadata.duration).catch(() => null),
      download.audioAvailable
        ? transcribeLocalMedia(download.audioPath, download.metadata.duration)
        : Promise.resolve(undefined),
    ]);
    if (options.signal?.aborted) throw new DOMException("Reference analysis cancelled", "AbortError");

    yield { step: "analyzing_audio", detail: `Found ${scenes.length} scenes, BPM: ${audioAnalysis.bpm}` };
    yield {
      step: "analyzing_visuals",
      detail: "Measuring local motion, geometry, and text with OpenCV/PaddleOCR...",
    };

    const localEvidence = await analyzeLocalVisualEvidence(
      download.videoPath,
      scenes,
      download.metadata.duration,
      { signal: options.signal }
    ).catch((err: any) => {
      if (env.REFERENCE_CV_MODE === "opencv" || err?.name === "AbortError" || options.signal?.aborted) throw err;
      logger.warn({ err: err?.message }, "Local visual evidence unavailable; continuing with model evidence");
      return undefined;
    });

    // Step 4: Full-detail 24 FPS analysis. Short references use one native
    // video request; long references use scene-boundary-aligned native-video
    // chunks. Per-scene JPEG analysis remains an explicit last-resort fallback.
    yield { step: "analyzing_visuals", detail: `Analyzing every scene once at the maximum supported 24 FPS...` };
    const warnings: string[] = [];
    let analysisUsage: ReferenceAnalysisUsage | undefined;
    let visualData;
    let usedSampledFallback = false;
    try {
      const wholeVideo = await analyzeWholeVideo(
        download.videoPath,
        scenes,
        referenceTranscript,
        audioAnalysis,
        {
          signal: options.signal,
          evidence: localEvidence,
          checkpoint: options.analysisCheckpoint,
          onCheckpoint: options.onAnalysisCheckpoint,
        }
      );
      visualData = wholeVideo.scenes;
      analysisUsage = wholeVideo.usage;
    } catch (err: any) {
      if (err?.name === "AbortError" || options.signal?.aborted) throw err;
      if (err?.analysisUsage) analysisUsage = err.analysisUsage;
      // A complete native-video response that failed blueprint invariants must
      // remain on its checkpointed/focused repair path. Sampled stills contain
      // less temporal evidence and cannot repair dense caption sequences.
      if (err?.code === "REFERENCE_ANALYSIS_INCOMPLETE") throw err;
      const warning = `Full-detail video analysis failed; starting sampled-frame fallback: ${err?.message || "unknown error"}`;
      warnings.push(warning);
      usedSampledFallback = true;
      logger.warn({ err: err?.message }, warning);
      visualData = await analyzeVisuals(scenes, options);
      const completedWarning = "Sampled-frame fallback completed after full-detail video analysis failed";
      warnings.push(completedWarning);
      logger.info({ sceneCount: visualData.length }, completedWarning);
    }
    if (options.signal?.aborted) throw new DOMException("Reference analysis cancelled", "AbortError");

    // Step 5: Merge into blueprint
    yield { step: "generating_blueprint", detail: "Building a provisional full-detail blueprint..." };
    let blueprint = buildBlueprint(
      url,
      download,
      scenes,
      audioAnalysis,
      visualData,
      colorStatistics || undefined,
      analysisUsage,
      warnings,
      localEvidence
    );

    if (usedSampledFallback) {
      const reconciled = reconcileSampledFallbackBlueprint(blueprint);
      blueprint = reconciled.blueprint;
      if (reconciled.warnings.length) {
        blueprint.analysisWarnings = [
          ...(blueprint.analysisWarnings || []),
          ...reconciled.warnings,
        ];
      }
    }

    yield { step: "generating_blueprint", detail: "Preflighting cross-scene typography, layers, motion and measured panel reveals before timeline compilation..." };
    const semantic = reconcileBlueprintSemantics(blueprint);
    blueprint = semantic.blueprint;
    if (semantic.warnings.length) {
      blueprint.analysisWarnings = [
        ...(blueprint.analysisWarnings || []),
        ...semantic.warnings,
      ];
    }

    const measuredPanels = await reconcileMeasuredPanelReveals(
      download.videoPath,
      blueprint,
      { signal: options.signal, fps: 30 }
    );
    blueprint = measuredPanels.blueprint;
    if (measuredPanels.warnings.length) {
      blueprint.analysisWarnings = [
        ...(blueprint.analysisWarnings || []),
        ...measuredPanels.warnings,
      ];
    }

    const integrity = validateBlueprintIntegrity(blueprint, {
      allowDegradedMeasurements: usedSampledFallback,
    });
    if (!integrity.ok) {
      throw new Error(
        `Reference blueprint is incomplete: ${integrity.issues
          .filter((issue) => issue.severity === "error")
          .slice(0, 10)
          .map((issue) => `${issue.code} (${issue.range[0].toFixed(2)}-${issue.range[1].toFixed(2)}s)`)
          .join(", ")}`
      );
    }
    if (integrity.issues.length) {
      blueprint.analysisWarnings = [
        ...(blueprint.analysisWarnings || []),
        ...integrity.issues.map((issue) => `${issue.code}: ${issue.message}`),
      ];
    }

    yield {
      step: "complete",
      blueprint,
      referenceVideoPath: download.videoPath,
      referenceTranscript,
      ...(download.audioAvailable ? { referenceAudioPath: download.audioPath } : {}),
    };
  } finally {
    if (download?.workDir) {
      rm(download.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function buildBlueprint(
  url: string,
  download: DownloadResult,
  scenes: SceneSegment[],
  audio: AudioAnalysis,
  visualData: Awaited<ReturnType<typeof analyzeVisuals>>,
  colorStatistics?: import("@tempo/types").ColorStatistics,
  analysisUsage?: ReferenceAnalysisUsage,
  analysisWarnings: string[] = [],
  analysisEvidence?: import("@tempo/types").ReferenceAnalysisEvidence
): EditBlueprint {
  const segments: BlueprintSegment[] = scenes.map((scene, i) => {
    const visual = visualData[i] || {
      shotType: "medium" as const,
      motionType: "static" as const,
      transitionToNext: "cut" as const,
      energyLevel: 50,
      visualDescription: "Scene",
      colorPalette: ["#333333"],
      effects: [],
      textOverlays: [],
      speed: 1,
    };

    const onBeat = isOnBeat(scene.startTime, audio.beats);

    return {
      index: i,
      startTime: scene.startTime,
      duration: scene.duration,
      shotType: visual.shotType,
      motionType: visual.motionType,
      transitionToNext: visual.transitionToNext,
      energyLevel: visual.energyLevel,
      visualDescription: visual.visualDescription,
      colorPalette: visual.colorPalette,
      effects: visual.effects,
      textOverlays: visual.textOverlays,
      ...(visual.composition ? { composition: visual.composition } : {}),
      ...(visual.transitionSpec ? { transitionSpec: visual.transitionSpec } : {}),
      onBeat,
      speed: visual.speed,
    };
  });

  const avgEnergy = segments.reduce((s, seg) => s + seg.energyLevel, 0) / (segments.length || 1);
  const avgDuration = segments.reduce((s, seg) => s + seg.duration, 0) / (segments.length || 1);

  let pacing: "slow" | "moderate" | "fast" | "variable" = "moderate";
  if (avgDuration < 1.5) pacing = "fast";
  else if (avgDuration > 4) pacing = "slow";

  const allColors = segments.flatMap((s) => s.colorPalette);
  const dominantColor = allColors[0] || "#333333";

  const width = download.metadata.displayWidth || download.metadata.width;
  const height = download.metadata.displayHeight || download.metadata.height;
  const { duration: totalDuration } = download.metadata;
  const aspectRatio = width && height ? `${width}:${height}` : "16:9";

  return {
    id: randomUUID(),
    referenceUrl: url,
    totalDuration: totalDuration || 0,
    aspectRatio,
    referenceWidth: width || undefined,
    referenceHeight: height || undefined,
    colorStatistics,
    segments,
    audioAnalysis: audio,
    overallStyle: {
      colorGrading: `Dominant: ${dominantColor}`,
      pacing,
      mood: audio.mood,
      genre: audio.genre,
    },
    analysisUsage,
    analysisEvidence,
    analysisWarnings: analysisWarnings.length ? analysisWarnings : undefined,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Check if a timestamp aligns with any beat (within 100ms tolerance).
 */
function isOnBeat(time: number, beats: BeatInfo[]): boolean {
  const TOLERANCE = 0.1;
  return beats.some((b) => Math.abs(b.time - time) < TOLERANCE);
}
