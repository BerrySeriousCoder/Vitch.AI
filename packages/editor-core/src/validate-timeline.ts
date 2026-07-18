import type { Track, Transition, Sequence } from "@tempo/types";
import { getEffectDefinition } from "./effect-registry";
import { isNestClip, validateSequences } from "./sequences";
import { validateAdjustmentClip } from "./adjustment-layer";
import { validateCrop } from "./crop";
import { validateCompositingHierarchy } from "./compositing-hierarchy";

export type TimelineValidationSeverity = "info" | "warn" | "error";

export interface TimelineValidationIssue {
  severity: TimelineValidationSeverity;
  code: string;
  message: string;
  trackId?: string;
  clipId?: string;
  transitionId?: string;
  sequenceId?: string;
}

function validateTracksAndTransitions(
  tracks: readonly Track[],
  transitions: readonly Transition[],
  issues: TimelineValidationIssue[],
  opts?: { sequenceId?: string; messagePrefix?: string; mediaDurations?: Readonly<Record<string, number>> }
): void {
  const prefix = opts?.messagePrefix || "";
  const sequenceId = opts?.sequenceId;

  for (const track of tracks) {
    const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!;
      const mediaDuration = c.sourceMediaId ? opts?.mediaDurations?.[c.sourceMediaId] : undefined;
      if (
        mediaDuration !== undefined && mediaDuration > 0 &&
        !c.speedRamp?.length && !c.reversed
      ) {
        const heldTimeline = Math.max(0, c.hold?.durationSec || 0);
        const consumed = Math.max(0, c.duration - heldTimeline) * Math.abs(c.speed || 1);
        if (c.sourceOffset + consumed > mediaDuration + 0.001) {
          issues.push({
            severity: "error",
            code: "source_range_overrun",
            message: `${prefix}clip ${c.id} consumes source through ${(c.sourceOffset + consumed).toFixed(3)}s beyond media duration ${mediaDuration.toFixed(3)}s`,
            trackId: track.id,
            clipId: c.id,
            sequenceId,
          });
        }
      }
      const adjustmentError = validateAdjustmentClip(track, c);
      if (adjustmentError) {
        issues.push({
          severity: "error",
          code: "invalid_adjustment_layer",
          message: `${prefix}${adjustmentError}`,
          trackId: track.id,
          clipId: c.id,
          sequenceId,
        });
      }
      if (c.crop) {
        const crop = validateCrop(c.crop);
        if (!crop.ok) {
          issues.push({
            severity: "error",
            code: "invalid_crop",
            message: `${prefix}clip ${c.id} has invalid crop: ${crop.message}`,
            trackId: track.id,
            clipId: c.id,
            sequenceId,
          });
        }
      }
      if (
        !isNestClip(c) &&
        !c.sourceMediaId &&
        track.type !== "text" &&
        track.type !== "shape" &&
        track.type !== "adjustment" &&
        track.type !== "null"
      ) {
        issues.push({
          severity: "warn",
          code: "missing_media",
          message: `${prefix}clip ${c.id} on "${track.name}" missing sourceMediaId`,
          trackId: track.id,
          clipId: c.id,
          sequenceId,
        });
      }
      for (const fx of c.effects || []) {
        if (!getEffectDefinition(fx.type)) {
          issues.push({
            severity: "error",
            code: "unknown_effect",
            message: `${prefix}clip ${c.id} unknown effect "${fx.type}"`,
            trackId: track.id,
            clipId: c.id,
            sequenceId,
          });
        }
      }
      if (i > 0) {
        const prev = sorted[i - 1]!;
        const prevEnd = prev.startTime + prev.duration;
        if (c.startTime < prevEnd - 0.001) {
          const overlappingTx = transitions.some(
            (tr) =>
              tr.trackId === track.id &&
              ((tr.clipAId === prev.id && tr.clipBId === c.id) ||
                (tr.clipBId === prev.id && tr.clipAId === c.id))
          );
          if (!overlappingTx) {
            issues.push({
              severity: "warn",
              code: "overlap_without_transition",
              message: `${prefix}overlap on "${track.name}" ${prev.id}→${c.id} (${(prevEnd - c.startTime).toFixed(2)}s) without transition`,
              trackId: track.id,
              clipId: c.id,
              sequenceId,
            });
          }
        }
      }
    }
  }

  for (const tr of transitions) {
    let foundA = false;
    let foundB = false;
    for (const track of tracks) {
      if (track.clips.some((c) => c.id === tr.clipAId)) foundA = true;
      if (track.clips.some((c) => c.id === tr.clipBId)) foundB = true;
    }
    if (!foundA || !foundB) {
      issues.push({
        severity: "error",
        code: "orphan_transition",
        message: `${prefix}transition ${tr.id} references missing clip(s)`,
        transitionId: tr.id,
        sequenceId,
      });
    }
  }
}

/**
 * Deterministic structural timeline checks (no vision).
 * Used by agent `validate_timeline` and any UI that needs the same rules.
 * Also runs the same structural pass on each sequence's interior tracks.
 */
export function validateTimeline(
  tracks: readonly Track[],
  transitions: readonly Transition[] = [],
  sequences: readonly Sequence[] = [],
  mediaDurations: Readonly<Record<string, number>> = {}
): TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = [];

  validateTracksAndTransitions(tracks, transitions, issues, { mediaDurations });
  for (const issue of validateCompositingHierarchy(tracks)) {
    issues.push({
      severity: issue.code === "track_matte_no_overlap" ? "warn" : "error",
      code: issue.code,
      message: issue.message,
      clipId: issue.clipId,
    });
  }

  for (const seq of sequences) {
    validateTracksAndTransitions(seq.tracks || [], seq.transitions || [], issues, {
      sequenceId: seq.id,
      messagePrefix: `sequence "${seq.name}" (${seq.id}): `,
      mediaDurations,
    });
    for (const issue of validateCompositingHierarchy(seq.tracks || [])) {
      issues.push({
        severity: issue.code === "track_matte_no_overlap" ? "warn" : "error",
        code: issue.code,
        message: `sequence "${seq.name}" (${seq.id}): ${issue.message}`,
        clipId: issue.clipId,
        sequenceId: seq.id,
      });
    }
  }

  issues.push(...validateSequences({ tracks, transitions, sequences }));

  return issues;
}

export function formatTimelineValidationIssues(
  issues: readonly TimelineValidationIssue[]
): string {
  return issues
    .map((i) => `${i.severity}: ${i.message}`)
    .join("\n");
}
