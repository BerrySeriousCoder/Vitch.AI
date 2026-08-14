import type { EditBlueprint, ProjectSettings, Track, Transition, Sequence } from "@tempo/types";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { resolveLocalMediaPath } from "../media/audio-understanding.service.js";
import { downloadFileToPath, storageUrlToKey } from "../storage.service.js";
import { sampleCritiqueFrames } from "../critique/critique-frames.service.js";
import {
  compareReferenceFramesToEdit,
  comparisonSamplePairs,
  type ReferenceEditComparison,
} from "../critique/reference-comparison.service.js";

export interface RecreationVerificationReport {
  ok: boolean;
  comparisons: Array<{ segmentIndex: number; result: ReferenceEditComparison }>;
  checkedRanges: number;
}

interface VerificationWorkItem {
  segment: EditBlueprint["segments"][number];
  pairs: Array<{ referenceTime: number; editTime: number }>;
}

function complexSegments(blueprint: EditBlueprint) {
  return blueprint.segments.filter((segment) =>
    Boolean(segment.composition?.layers.length) ||
    segment.textOverlays.some((overlay) => overlay.fillMode === "media-matte" || Boolean(overlay.animationSpec)) ||
    Boolean(segment.transitionSpec)
  ).slice(0, 4);
}

export function verificationTimesForSegment(blueprint: EditBlueprint, segmentIndex: number): number[] {
  return verificationPairs(blueprint, segmentIndex).map((pair) => pair.referenceTime);
}

export function verificationCaptureTimes(blueprint: EditBlueprint): number[] {
  return [...new Set(complexSegments(blueprint).flatMap((segment) =>
    verificationPairs(blueprint, segment.index).map((pair) => Number(pair.editTime.toFixed(3)))
  ))].sort((a, b) => a - b);
}

function verificationPairs(blueprint: EditBlueprint, segmentIndex: number) {
  const segment = blueprint.segments.find((candidate) => candidate.index === segmentIndex);
  if (!segment) return [];
  const start = segment.startTime;
  const end = start + segment.duration;
  const measured = blueprint.analysisEvidence?.scenes
    .find((scene) => scene.sceneIndex === segment.index)?.eventTimes || [];
  const aroundEvents = measured.flatMap((time) => [
    Math.max(start, time - 1 / 30),
    Math.min(end - 0.001, time + 1 / 30),
  ]);
  const uniform = comparisonSamplePairs(start, end, start, end, 8).map((pair) => pair.referenceTime);
  const times = [...new Set([...uniform, ...aroundEvents].map((time) => Number(time.toFixed(3))))]
    .sort((a, b) => a - b)
    .slice(0, 16);
  return times.map((time) => ({ referenceTime: time, editTime: time }));
}

function timelineContext(tracks: Track[], start: number, end: number) {
  return tracks.flatMap((track) => {
    const clips = track.clips.filter((clip) => clip.startTime < end && clip.startTime + clip.duration > start);
    return clips.length ? [{
      id: track.id,
      name: track.name,
      type: track.type,
      order: track.order,
      clips: clips.map((clip) => ({
        id: clip.id,
        binding: clip.referenceEditBinding,
        startTime: clip.startTime,
        duration: clip.duration,
        layout: clip.layout,
        mediaLayout: clip.mediaLayout,
        textParams: clip.textParams,
        keyframes: clip.keyframes,
        trackMatte: clip.trackMatte,
        effects: clip.effects,
      })),
    }] : [];
  });
}

/** Render and compare complex reference ranges before an Edit Like This run is accepted. */
export async function verifyRecreationAgainstReference(input: {
  projectId: string;
  referenceAssetUrl: string;
  blueprint: EditBlueprint;
  tracks: Track[];
  transitions: Transition[];
  sequences?: Sequence[];
  settings?: ProjectSettings;
  onCaptureProgress?: (captured: number, total: number) => void | Promise<void>;
}): Promise<RecreationVerificationReport> {
  let referencePath = resolveLocalMediaPath(input.referenceAssetUrl);
  let workDir: string | undefined;
  if (!referencePath) {
    workDir = await mkdtemp(path.join(os.tmpdir(), "tempo-auto-verify-"));
    referencePath = path.join(workDir, "reference.mp4");
    await downloadFileToPath(storageUrlToKey(input.referenceAssetUrl), referencePath);
  }
  const comparisons: RecreationVerificationReport["comparisons"] = [];
  try {
    const work: VerificationWorkItem[] = complexSegments(input.blueprint).map((segment) => ({
      segment,
      pairs: verificationPairs(input.blueprint, segment.index),
    }));
    const captureTimes = [...new Set(work.flatMap(({ pairs }) =>
      pairs.map((pair) => Number(pair.editTime.toFixed(3)))
    ))].sort((a, b) => a - b);
    const captured = captureTimes.length
      ? await sampleCritiqueFrames({
          projectId: input.projectId,
          tracks: input.tracks,
          transitions: input.transitions,
          sequences: input.sequences || [],
          times: captureTimes,
          settings: input.settings,
          onProgress: input.onCaptureProgress,
        })
      : [];
    const frameByTime = new Map(captured.map((frame) => [Number(frame.time.toFixed(3)), frame]));
    for (const { segment, pairs } of work) {
      const editFrames = pairs.map((pair) => frameByTime.get(Number(pair.editTime.toFixed(3))));
      if (editFrames.some((frame) => !frame)) {
        throw new Error(`Critique capture omitted one or more frames for segment ${segment.index}`);
      }
      const start = segment.startTime;
      const end = start + segment.duration;
      const result = await compareReferenceFramesToEdit({
        referencePath,
        referenceRange: [start, end],
        editRange: [start, end],
        pairs,
        editFrames: editFrames as Awaited<ReturnType<typeof sampleCritiqueFrames>>,
        question: "Verify this automatically compiled Edit Like This range against the measured reference before accepting the edit.",
        reconstructionSpec: { segment, localEvidence: input.blueprint.analysisEvidence?.scenes.find((scene) => scene.sceneIndex === segment.index) },
        timelineContext: timelineContext(input.tracks, start, end),
        sourcePolicy: "style-transfer",
      });
      comparisons.push({ segmentIndex: segment.index, result });
    }
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return {
    ok: comparisons.every(({ result }) =>
      result.verdict !== "mismatch" &&
      result.matchScore >= 70 &&
      !result.differences.some((difference) => difference.severity === "error")
    ),
    comparisons,
    checkedRanges: comparisons.length,
  };
}
