/**
 * Edit-point transition apply / validate / remove.
 * Steal-to-overlap on apply; refuse if insufficient head/tail source unless allowHold.
 */
import type { Clip, Track, Transition } from "@tempo/types";
import { TIMING_EPSILON, getSourceRange } from "./source-media-timeline";
import { getTransitionType } from "./transition-registry";
import {
  normalizeTransitionDirection,
  normalizeTransitionSoftness,
  normalizeTransitionBlur,
  normalizeUnit,
} from "./transition-mix";
import { planHoldExtension, normalizeHold } from "./hold";
import { listEditPoints } from "./edit-points";
export type MediaDurationMap = Map<string, number> | Record<string, number>;

export interface TransitionHandleError {
  ok: false;
  code:
    | "unknown_type"
    | "clips_not_found"
    | "different_tracks"
    | "order"
    | "not_adjacent"
    | "insufficient_tail"
    | "insufficient_head"
    | "duplicate"
    | "not_found"
    | "invalid_duration";
  message: string;
  needTailSec?: number;
  needHeadSec?: number;
  availableTailSec?: number;
  availableHeadSec?: number;
}

export interface TransitionOk<T> {
  ok: true;
  value: T;
}

export type TransitionResult<T> = TransitionOk<T> | TransitionHandleError;

function mediaDurationOf(
  clip: Clip,
  mediaDurations: MediaDurationMap
): number | null {
  if (!clip.sourceMediaId) return null;
  if (mediaDurations instanceof Map) {
    return mediaDurations.get(clip.sourceMediaId) ?? null;
  }
  return mediaDurations[clip.sourceMediaId] ?? null;
}

function findClip(
  tracks: Track[],
  clipId: string
): { track: Track; clip: Clip; trackIndex: number; clipIndex: number } | null {
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti]!;
    const ci = track.clips.findIndex((c) => c.id === clipId);
    if (ci >= 0) {
      return { track, clip: track.clips[ci]!, trackIndex: ti, clipIndex: ci };
    }
  }
  return null;
}

function cloneTracks(tracks: Track[]): Track[] {
  return JSON.parse(JSON.stringify(tracks)) as Track[];
}

function cloneTransitions(transitions: Transition[]): Transition[] {
  return JSON.parse(JSON.stringify(transitions)) as Transition[];
}

/** Timeline end of a clip */
export function clipEnd(clip: Clip): number {
  return clip.startTime + clip.duration;
}

/**
 * Overlap window for an applied transition (after steal-to-overlap).
 * Returns [start, end) on the timeline.
 */
export function getTransitionWindow(
  clipA: Clip,
  clipB: Clip,
  duration: number
): [number, number] {
  const start = clipEnd(clipA) - duration;
  return [start, start + duration];
}

/** Progress 0..1 within transition at timeline time (0 = all A, 1 = all B). */
export function getTransitionProgress(
  time: number,
  window: [number, number]
): number {
  const [start, end] = window;
  if (end <= start) return 1;
  if (time <= start) return 0;
  if (time >= end) return 1;
  return (time - start) / (end - start);
}

/**
 * Opacity multiplier for clip A or B during a transition (composited sequentially).
 * Delegates to getTransitionMix — geometric types return 1 (use geometric path).
 */
export { getTransitionMix, getTransitionClipOpacity } from "./transition-mix";
export type { TransitionMix, TransitionDirection, GeometricTransitionKind } from "./transition-mix";

export function findActiveTransition(
  transitions: Transition[],
  tracks: Track[],
  trackId: string,
  time: number
): { transition: Transition; clipA: Clip; clipB: Clip; progress: number } | null {
  for (const tr of transitions) {
    if (tr.trackId !== trackId) continue;
    const a = findClip(tracks, tr.clipAId)?.clip;
    const b = findClip(tracks, tr.clipBId)?.clip;
    if (!a || !b) continue;
    const win = getTransitionWindow(a, b, tr.duration);
    if (time >= win[0] - TIMING_EPSILON && time < win[1] - TIMING_EPSILON) {
      return {
        transition: tr,
        clipA: a,
        clipB: b,
        progress: getTransitionProgress(time, win),
      };
    }
  }
  return null;
}

/**
 * Available unused source after clip out-point (tail), in source seconds.
 * null = unknown / no media (e.g. text) — treated as infinite for text/shape.
 */
export function availableTailSourceSec(
  clip: Clip,
  mediaDurations: MediaDurationMap
): number | null {
  if (!clip.sourceMediaId) return Number.POSITIVE_INFINITY;
  const mediaDur = mediaDurationOf(clip, mediaDurations);
  if (mediaDur == null) return null;
  const [, sourceEnd] = getSourceRange(clip);
  return Math.max(0, mediaDur - sourceEnd);
}

/** Available unused source before clip in-point (head), in source seconds. */
export function availableHeadSourceSec(
  clip: Clip,
  _mediaDurations: MediaDurationMap
): number {
  if (!clip.sourceMediaId) return Number.POSITIVE_INFINITY;
  return Math.max(0, clip.sourceOffset);
}

export function validateTransitionPlacement(
  tracks: Track[],
  input: {
    trackId: string;
    clipAId: string;
    clipBId: string;
    duration: number;
    type: string;
    allowHold?: boolean;
  },
  mediaDurations: MediaDurationMap,
  existing: Transition[] = []
): TransitionResult<{
  clipA: Clip;
  clipB: Clip;
  track: Track;
  holdRequired?: { clipId: string; at: "out"; durationSec: number };
}> {
  const def = getTransitionType(input.type);
  if (!def) {
    return {
      ok: false,
      code: "unknown_type",
      message: `Unknown transition type "${input.type}"`,
    };
  }
  if (!(input.duration > 0) || !Number.isFinite(input.duration)) {
    return {
      ok: false,
      code: "invalid_duration",
      message: "Transition duration must be a positive number",
    };
  }

  const aFound = findClip(tracks, input.clipAId);
  const bFound = findClip(tracks, input.clipBId);
  if (!aFound || !bFound) {
    return {
      ok: false,
      code: "clips_not_found",
      message: "Both clips must exist on the timeline",
    };
  }
  if (aFound.track.id !== bFound.track.id || aFound.track.id !== input.trackId) {
    return {
      ok: false,
      code: "different_tracks",
      message: "Transition clips must be on the same track",
    };
  }

  const clipA = aFound.clip;
  const clipB = bFound.clip;
  if (clipEnd(clipA) > clipB.startTime + TIMING_EPSILON && clipA.startTime < clipEnd(clipB)) {
    // Already overlapping — OK if A starts before B
  }
  if (clipA.startTime >= clipB.startTime - TIMING_EPSILON) {
    return {
      ok: false,
      code: "order",
      message: "clipA must start before clipB",
    };
  }

  // Source needed: extend A by duration (overlap [cut, cut+D)); only A needs unused tail.
  const gap = clipB.startTime - clipEnd(clipA);
  if (gap > 0.05) {
    return {
      ok: false,
      code: "not_adjacent",
      message: `Clips are not adjacent (gap ${gap.toFixed(3)}s). Move them to a cut first.`,
    };
  }

  if (
    existing.some(
      (t) =>
        (t.clipAId === input.clipAId && t.clipBId === input.clipBId) ||
        (t.clipAId === input.clipBId && t.clipBId === input.clipAId)
    )
  ) {
    return {
      ok: false,
      code: "duplicate",
      message: "A transition already exists between these clips",
    };
  }

  const overlap = Math.max(0, -gap);
  const steal = Math.max(0, input.duration - overlap);
  const needStealTail = steal * clipA.speed;

  const tail = availableTailSourceSec(clipA, mediaDurations);
  if (tail == null) {
    return {
      ok: false,
      code: "insufficient_tail",
      message: "Unknown media duration for outgoing clip — cannot validate handles",
      needTailSec: needStealTail,
    };
  }

  if (tail + TIMING_EPSILON < needStealTail) {
    if (input.allowHold) {
      const { holdSourceSec, useMediaSec } = planHoldExtension(needStealTail, tail);
      const holdTimelineSec = holdSourceSec / Math.max(1e-6, clipA.speed || 1);
      return {
        ok: true,
        value: {
          clipA,
          clipB,
          track: aFound.track,
          holdRequired:
            holdTimelineSec > TIMING_EPSILON
              ? { clipId: clipA.id, at: "out", durationSec: holdTimelineSec }
              : undefined,
        },
      };
    }
    return {
      ok: false,
      code: "insufficient_tail",
      message: `Outgoing clip needs ${needStealTail.toFixed(2)}s unused tail source; has ${tail.toFixed(2)}s. Pass allowHold or set_clip_hold.`,
      needTailSec: needStealTail,
      availableTailSec: tail,
    };
  }

  return {
    ok: true,
    value: { clipA, clipB, track: aFound.track },
  };
}

export interface ApplyTransitionInput {
  id?: string;
  trackId: string;
  clipAId: string;
  clipBId: string;
  type: string;
  duration: number;
  params?: Record<string, number | string | boolean>;
  allowHold?: boolean;
}

/** Apply one validated transition recipe to every clean cut on a track. */
export function applyTransitionToTrackCuts(
  tracks: Track[],
  transitions: Transition[],
  input: Omit<ApplyTransitionInput, "clipAId" | "clipBId">,
  mediaDurations: MediaDurationMap
): {
  tracks: Track[];
  transitions: Transition[];
  applied: Transition[];
  skipped: Array<{ clipAId: string; clipBId: string; message: string }>;
} {
  let nextTracks = tracks;
  let nextTransitions = transitions;
  const applied: Transition[] = [];
  const skipped: Array<{ clipAId: string; clipBId: string; message: string }> = [];
  const cuts = listEditPoints(tracks, { trackId: input.trackId, abuttingOnly: true });
  for (const cut of cuts) {
    const result = applyTransition(nextTracks, nextTransitions, {
      ...input,
      clipAId: cut.clipAId,
      clipBId: cut.clipBId,
    }, mediaDurations);
    if (!result.ok) {
      skipped.push({ clipAId: cut.clipAId, clipBId: cut.clipBId, message: result.message });
      continue;
    }
    nextTracks = result.value.tracks;
    nextTransitions = result.value.transitions;
    applied.push(result.value.transition);
  }
  return { tracks: nextTracks, transitions: nextTransitions, applied, skipped };
}

/**
 * Apply transition: create/maintain overlap of `duration`, append edit-point.
 * Steal geometry from abutting cut (or expand existing overlap up to D).
 */
export function applyTransition(
  tracks: Track[],
  transitions: Transition[],
  input: ApplyTransitionInput,
  mediaDurations: MediaDurationMap
): TransitionResult<{ tracks: Track[]; transitions: Transition[]; transition: Transition }> {
  const validated = validateTransitionPlacement(
    tracks,
    input,
    mediaDurations,
    transitions
  );
  if (!validated.ok) return validated;

  const nextTracks = cloneTracks(tracks);
  const aFound = findClip(nextTracks, input.clipAId)!;
  const bFound = findClip(nextTracks, input.clipBId)!;
  const clipA = aFound.clip;
  const clipB = bFound.clip;

  const gap = clipB.startTime - clipEnd(clipA);
  const overlap = Math.max(0, -gap);
  const steal = Math.max(0, input.duration - overlap);

  if (steal > TIMING_EPSILON) {
    // Extend A only so overlap === duration: [cut, cut+D)
    clipA.duration += steal;
  }

  if (validated.value.holdRequired) {
    const hr = validated.value.holdRequired;
    const existing = normalizeHold(clipA.hold);
    const merged = Math.max(existing?.durationSec || 0, hr.durationSec);
    clipA.hold = { at: "out", durationSec: merged };
  }

  const def = getTransitionType(input.type)!;
  const params: Record<string, number | string | boolean> = {};
  for (const [key, schema] of Object.entries(def.params)) {
    if (key === "duration") continue;
    const raw =
      input.params?.[key] !== undefined
        ? input.params[key]!
        : schema.defaultValue;
    if (key === "direction") {
      params[key] = normalizeTransitionDirection(
        raw,
        String(schema.defaultValue || "left") as "left"
      );
    } else if (key === "softness") {
      params[key] = normalizeTransitionSoftness(
        raw,
        Number(schema.defaultValue ?? 0.08)
      );
    } else if (key === "blur") {
      params[key] = normalizeTransitionBlur(
        raw,
        Number(schema.defaultValue ?? 0.35)
      );
    } else if (key === "centerX" || key === "centerY") {
      params[key] = normalizeUnit(raw, Number(schema.defaultValue ?? 0.5));
    } else {
      params[key] = raw;
    }
  }

  const transition: Transition = {
    id: input.id || `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    trackId: input.trackId,
    clipAId: input.clipAId,
    clipBId: input.clipBId,
    duration: input.duration,
    type: input.type,
    params,
    ...(input.allowHold ? { allowHold: true } : {}),
  };

  return {
    ok: true,
    value: {
      tracks: nextTracks,
      transitions: [...cloneTransitions(transitions), transition],
      transition,
    },
  };
}

/** Reverse steal-to-overlap and remove the edit-point. */
export function removeTransition(
  tracks: Track[],
  transitions: Transition[],
  transitionId: string
): TransitionResult<{ tracks: Track[]; transitions: Transition[] }> {
  const tr = transitions.find((t) => t.id === transitionId);
  if (!tr) {
    return { ok: false, code: "not_found", message: `Transition "${transitionId}" not found` };
  }

  const nextTracks = cloneTracks(tracks);
  const aFound = findClip(nextTracks, tr.clipAId);
  const bFound = findClip(nextTracks, tr.clipBId);
  const D = tr.duration;

  if (aFound && bFound) {
    const clipA = aFound.clip;
    // Reverse extend-A steal: shrink A so overlap collapses toward abut
    const currentOverlap = Math.max(0, clipEnd(clipA) - bFound.clip.startTime);
    const shrink = Math.min(D, currentOverlap);
    if (shrink > TIMING_EPSILON) {
      clipA.duration = Math.max(0.01, clipA.duration - shrink);
    }
    // Clear hold that was created only to satisfy this transition
    if (tr.allowHold && clipA.hold?.at === "out") {
      clipA.hold = null;
    }
  }

  return {
    ok: true,
    value: {
      tracks: nextTracks,
      transitions: transitions.filter((t) => t.id !== transitionId),
    },
  };
}

export function updateTransitionDuration(
  tracks: Track[],
  transitions: Transition[],
  transitionId: string,
  newDuration: number,
  mediaDurations: MediaDurationMap
): TransitionResult<{ tracks: Track[]; transitions: Transition[] }> {
  if (!(newDuration > 0) || !Number.isFinite(newDuration)) {
    return {
      ok: false,
      code: "invalid_duration",
      message: "Transition duration must be a positive number",
    };
  }
  const tr = transitions.find((t) => t.id === transitionId);
  if (!tr) {
    return { ok: false, code: "not_found", message: `Transition "${transitionId}" not found` };
  }

  // Remove (restore abut) then re-apply with new duration
  const removed = removeTransition(tracks, transitions, transitionId);
  if (!removed.ok) return removed;

  const applied = applyTransition(
    removed.value.tracks,
    removed.value.transitions,
    {
      id: tr.id,
      trackId: tr.trackId,
      clipAId: tr.clipAId,
      clipBId: tr.clipBId,
      type: tr.type,
      duration: newDuration,
      params: tr.params,
      allowHold: Boolean(tr.allowHold),
    },
    mediaDurations
  );
  if (!applied.ok) return applied;

  return {
    ok: true,
    value: {
      tracks: applied.value.tracks,
      transitions: applied.value.transitions,
    },
  };
}

/** Drop transitions whose clips no longer exist or are no longer valid. */
export function pruneInvalidTransitions(
  tracks: Track[],
  transitions: Transition[]
): Transition[] {
  return transitions.filter((tr) => {
    const a = findClip(tracks, tr.clipAId);
    const b = findClip(tracks, tr.clipBId);
    if (!a || !b) return false;
    if (a.track.id !== tr.trackId || b.track.id !== tr.trackId) return false;
    if (a.clip.startTime >= b.clip.startTime) return false;
    return true;
  });
}

/**
 * Remove transitions matching `shouldRemove`, reversing steal geometry for each.
 */
export function removeMatchingTransitions(
  tracks: Track[],
  transitions: Transition[],
  shouldRemove: (tr: Transition) => boolean
): { tracks: Track[]; transitions: Transition[] } {
  let nextTracks = tracks;
  let nextTransitions = transitions;
  for (const tr of transitions) {
    if (!shouldRemove(tr)) continue;
    const removed = removeTransition(nextTracks, nextTransitions, tr.id);
    if (removed.ok) {
      nextTracks = removed.value.tracks;
      nextTransitions = removed.value.transitions;
    }
  }
  return {
    tracks: nextTracks,
    transitions: pruneInvalidTransitions(nextTracks, nextTransitions),
  };
}
