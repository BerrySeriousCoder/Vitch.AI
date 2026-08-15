import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { downloadFileToPath, storageUrlToKey } from "../../storage.service.js";
import { resolveLocalMediaPath } from "../../media/audio-understanding.service.js";
import { inspectReferenceVideoRange } from "../../reference/video-analysis.service.js";
import { sampleCritiqueFrames } from "../../critique/critique-frames.service.js";
import {
  compareReferenceFramesToEdit,
  comparisonSamplePairs,
  referenceInspectionFps,
} from "../../critique/reference-comparison.service.js";
import { checkChromiumHealth } from "../../../utils/chromium-health.js";
import { toolErr } from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";

function referenceAsset(state: ProjectState) {
  const id = state.editBlueprint?.referenceAssetId;
  if (id) {
    const linked = (state.mediaAssets || []).find((asset) => asset.id === id);
    if (linked) return linked;
  }
  return [...(state.mediaAssets || [])].reverse().find((asset) =>
    Boolean(asset.metadata?.referenceVideo)
  );
}

function recordEvidence(
  state: ProjectState,
  kind: "blueprint" | "transcript" | "video" | "comparison",
  range?: { startTime: number; endTime: number }
) {
  state.referenceEvidence = [
    ...(state.referenceEvidence || []),
    { kind, at: new Date().toISOString(), ...range },
  ].slice(-20);
}

export const referenceToolDefinitions = [
  {
    name: "get_reference_analysis",
    description: "Read the persisted Edit Like This blueprint, including exact timed text states and analysis cost. Use before diagnosing whether the current edit matches the reference.",
    parameters: {
      type: "object" as const,
      properties: {
        startTime: { type: "number", description: "Optional reference range start in seconds" },
        endTime: { type: "number", description: "Optional reference range end in seconds" },
      },
      required: [],
    },
  },
  {
    name: "get_reference_transcript",
    description: "Read or search the retained reference video's timed audio transcript. Reports an explicit error when ASR was unavailable; an absent transcript is never treated as a no-match.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Optional case-insensitive phrase search" },
        startTime: { type: "number" },
        endTime: { type: "number" },
        limit: { type: "number", description: "Maximum items, default 100, max 300" },
      },
      required: [],
    },
  },
  {
    name: "inspect_reference_video",
    description: "Re-open a precise retained-reference range at adaptive high temporal detail (up to 30 FPS) and high resolution. Returns layers, mattes, exact text, animation channels, viewports, timing, and custom transitions. Required before repairing a user-reported visual mismatch.",
    parameters: {
      type: "object" as const,
      properties: {
        startTime: { type: "number", description: "Range start in seconds" },
        endTime: { type: "number", description: "Range end in seconds (max 30 seconds after start)" },
        question: { type: "string", description: "Specific visual/audio detail to verify" },
        fps: { type: "number", description: "Optional override from 2–30 FPS; omit for adaptive detail based on range length" },
      },
      required: ["startTime", "endTime", "question"],
    },
  },
  {
    name: "compare_reference_to_edit",
    description: "Forensically compare one retained-reference interval with the corresponding current-edit interval. Re-inspects the reference at adaptive high FPS, renders timestamp-aligned current timeline frames, and returns structured mismatches plus repair order/tool hints. Use after a user reports a missed/mismatched moment and again after repairs to verify the match.",
    parameters: {
      type: "object" as const,
      properties: {
        referenceStartTime: { type: "number", description: "Reference interval start in seconds" },
        referenceEndTime: { type: "number", description: "Reference interval end in seconds; maximum 15-second comparison window" },
        editStartTime: { type: "number", description: "Corresponding current-edit start; defaults to referenceStartTime" },
        editEndTime: { type: "number", description: "Corresponding current-edit end; defaults to referenceEndTime" },
        question: { type: "string", description: "Specific mismatch or production detail to compare" },
        maxFramePairs: { type: "number", description: "Timestamp-aligned frame pairs, default 12, range 4–16" },
        referenceFps: { type: "number", description: "Optional reference-inspection FPS override 2–30" },
      },
      required: ["referenceStartTime", "referenceEndTime", "question"],
    },
  },
];

function timelineEnd(state: ProjectState): number {
  return state.tracks.reduce(
    (end, track) => track.clips.reduce((trackEnd, clip) => Math.max(trackEnd, clip.startTime + clip.duration), end),
    0
  );
}

function timelineContext(state: ProjectState, startTime: number, endTime: number) {
  const tracks = state.tracks.flatMap((track) => {
    const clips = track.clips.filter((clip) => clip.startTime < endTime && clip.startTime + clip.duration > startTime);
    if (!clips.length) return [];
    return [{
      id: track.id,
      name: track.name,
      type: track.type,
      order: track.order,
      clips: clips.map((clip) => ({
        id: clip.id,
        sourceMediaId: clip.sourceMediaId,
        startTime: clip.startTime,
        duration: clip.duration,
        sourceOffset: clip.sourceOffset,
        speed: clip.speed,
        opacity: clip.opacity,
        blendMode: clip.blendMode,
        transform: clip.transform,
        layout: clip.layout,
        mediaLayout: clip.mediaLayout,
        textParams: clip.textParams,
        effects: clip.effects,
        keyframes: clip.keyframes,
        trackMatte: clip.trackMatte,
      })),
    }];
  });
  const activeIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  return {
    settings: state.settings,
    tracks,
    transitions: (state.transitions || []).filter((transition) => activeIds.has(transition.clipAId) || activeIds.has(transition.clipBId)),
  };
}

export const referenceToolExecutors = {
  get_reference_analysis: (args: Record<string, any>, state: ProjectState) => {
    const blueprint = state.editBlueprint;
    if (!blueprint) return { result: "Error: this project has no saved reference analysis", state };
    const start = Math.max(0, Number(args.startTime) || 0);
    const end = Number.isFinite(Number(args.endTime)) ? Number(args.endTime) : blueprint.totalDuration;
    const segments = blueprint.segments.filter(
      (segment) => segment.startTime < end && segment.startTime + segment.duration > start
    );
    recordEvidence(state, "blueprint", { startTime: start, endTime: end });
    return {
      result: JSON.stringify({
        referenceUrl: blueprint.referenceUrl,
        referenceAssetId: blueprint.referenceAssetId,
        range: [start, end],
        segments,
        overallStyle: blueprint.overallStyle,
        analysisUsage: blueprint.analysisUsage,
        analysisWarnings: blueprint.analysisWarnings,
      }, null, 2),
      state,
    };
  },

  get_reference_transcript: (args: Record<string, any>, state: ProjectState) => {
    const asset = referenceAsset(state);
    if (!asset) return { result: "Error: retained reference video asset is unavailable", state };
    const transcript = asset.metadata?.audioTranscript;
    if (!transcript) return { result: "Error: the retained reference has no transcript metadata; run reference analysis again", state };
    if (transcript.error && transcript.segments.length === 0) {
      return { result: `Error: reference transcription was unavailable: ${transcript.error}`, state };
    }
    const start = Math.max(0, Number(args.startTime) || 0);
    const end = Number.isFinite(Number(args.endTime)) ? Number(args.endTime) : Infinity;
    const query = String(args.query || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(300, Math.floor(Number(args.limit) || 100)));
    const segments = transcript.segments
      .filter((segment) => segment.start < end && segment.end > start)
      .filter((segment) => !query || segment.text.toLowerCase().includes(query))
      .slice(0, limit);
    recordEvidence(state, "transcript", { startTime: start, endTime: Number.isFinite(end) ? end : asset.duration || 0 });
    return {
      result: JSON.stringify({
        mediaId: asset.id,
        query: query || null,
        kind: transcript.kind,
        language: transcript.language,
        totalReturned: segments.length,
        matches: segments,
        usage: transcript.usage,
        note: query && segments.length === 0 ? "Transcript exists, but the phrase was not found." : undefined,
      }, null, 2),
      state,
    };
  },

  inspect_reference_video: async (args: Record<string, any>, state: ProjectState) => {
    const asset = referenceAsset(state);
    if (!asset) return { result: "Error: retained reference video asset is unavailable", state };
    const duration = asset.duration || state.editBlueprint?.totalDuration || 0;
    const startTime = Math.max(0, Number(args.startTime) || 0);
    const requestedEnd = Number(args.endTime);
    const endTime = Math.min(duration, Number.isFinite(requestedEnd) ? requestedEnd : startTime + 10, startTime + 30);
    if (endTime <= startTime) return { result: "Error: endTime must be after startTime", state };
    const question = String(args.question || "").trim();
    if (!question) return { result: "Error: question required", state };
    const fps = referenceInspectionFps(endTime - startTime, Number(args.fps));

    let localPath = resolveLocalMediaPath(asset.url);
    let workDir: string | undefined;
    try {
      if (!localPath) {
        workDir = await mkdtemp(path.join(os.tmpdir(), "tempo-ref-inspect-"));
        localPath = path.join(workDir, "reference.mp4");
        await downloadFileToPath(storageUrlToKey(asset.url), localPath);
      }
      const inspected = await inspectReferenceVideoRange(localPath, startTime, endTime, question, { fps });
      recordEvidence(state, "video", { startTime, endTime });
      return {
        result: JSON.stringify({
          evidence: { mediaId: asset.id, startTime, endTime, fps },
          analysis: inspected.analysis,
          reconstructionSpec: inspected.reconstructionSpec,
          usage: inspected.usage,
        }, null, 2),
        state,
      };
    } catch (err: any) {
      return { result: `Error: reference video inspection failed: ${err?.message || "unknown error"}`, state };
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },

  compare_reference_to_edit: async (args: Record<string, any>, state: ProjectState) => {
    const asset = referenceAsset(state);
    if (!asset) return { result: "Error: retained reference video asset is unavailable", state };
    if (!state.projectId) return { result: "Error: projectId missing on agent state", state };
    const question = String(args.question || "").trim();
    if (!question) return { result: "Error: question required", state };
    const referenceDuration = asset.duration || state.editBlueprint?.totalDuration || 0;
    const referenceStart = Math.max(0, Number(args.referenceStartTime) || 0);
    const referenceEnd = Math.min(referenceDuration, Number(args.referenceEndTime), referenceStart + 15);
    if (!Number.isFinite(referenceEnd) || referenceEnd <= referenceStart) {
      return { result: "Error: referenceEndTime must be after referenceStartTime", state };
    }
    const editDuration = timelineEnd(state);
    const editStart = Math.max(0, Number.isFinite(Number(args.editStartTime)) ? Number(args.editStartTime) : referenceStart);
    const editEnd = Math.min(
      editDuration,
      Number.isFinite(Number(args.editEndTime)) ? Number(args.editEndTime) : editStart + (referenceEnd - referenceStart)
    );
    if (editEnd <= editStart) return { result: "Error: corresponding current-edit range is empty", state };

    const health = await checkChromiumHealth();
    if (!health.ok) {
      return { result: toolErr(health.error, { code: health.code, fixHint: health.fixHint }), state };
    }
    const pairCount = Math.max(4, Math.min(16, Math.round(Number(args.maxFramePairs) || 12)));
    const pairs = comparisonSamplePairs(referenceStart, referenceEnd, editStart, editEnd, pairCount);
    const fps = referenceInspectionFps(referenceEnd - referenceStart, Number(args.referenceFps));
    let localPath = resolveLocalMediaPath(asset.url);
    let workDir: string | undefined;
    try {
      if (!localPath) {
        workDir = await mkdtemp(path.join(os.tmpdir(), "tempo-ref-compare-"));
        localPath = path.join(workDir, "reference.mp4");
        await downloadFileToPath(storageUrlToKey(asset.url), localPath);
      }
      const inspected = await inspectReferenceVideoRange(localPath, referenceStart, referenceEnd, question, { fps });
      const editFrames = await sampleCritiqueFrames({
        projectId: state.projectId,
        tracks: state.tracks,
        transitions: state.transitions || [],
        sequences: state.sequences || [],
        times: pairs.map((pair) => pair.editTime),
      });
      const comparison = await compareReferenceFramesToEdit({
        referencePath: localPath,
        referenceRange: [referenceStart, referenceEnd],
        editRange: [editStart, editEnd],
        pairs,
        editFrames,
        question,
        reconstructionSpec: inspected.reconstructionSpec,
        timelineContext: timelineContext(state, editStart, editEnd),
      });
      recordEvidence(state, "video", { startTime: referenceStart, endTime: referenceEnd });
      recordEvidence(state, "comparison", { startTime: referenceStart, endTime: referenceEnd });
      return {
        result: JSON.stringify({
          referenceInspection: {
            fps,
            analysis: inspected.analysis,
            reconstructionSpec: inspected.reconstructionSpec,
            usage: inspected.usage,
          },
          comparison,
        }, null, 2),
        state,
      };
    } catch (err: any) {
      return { result: `Error: reference/current-edit comparison failed: ${err?.message || "unknown error"}`, state };
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};
