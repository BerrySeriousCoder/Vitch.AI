import type { Clip, Track, Transition } from "@tempo/types";
import {
  clipEnd,
  pruneInvalidTransitions,
  removeMatchingTransitions,
} from "./transitions";

const EPS = 1e-4;

export type TimelineEditOk = {
  ok: true;
  tracks: Track[];
  transitions: Transition[];
  message?: string;
};

export type TimelineEditErr = {
  ok: false;
  message: string;
};

export type TimelineEditResult = TimelineEditOk | TimelineEditErr;

export type ReplaceFit = "keep-duration" | "fit-media";

function cloneTracks(tracks: Track[]): Track[] {
  return JSON.parse(JSON.stringify(tracks)) as Track[];
}

function cloneTransitions(transitions: Transition[]): Transition[] {
  return JSON.parse(JSON.stringify(transitions)) as Transition[];
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

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startTime - b.startTime);
}

/** Shift clips with startTime >= fromTime by deltaSec (exclude optional id). */
export function shiftClipsAfter(
  clips: Clip[],
  fromTime: number,
  deltaSec: number,
  excludeId?: string
): Clip[] {
  if (Math.abs(deltaSec) < EPS) return clips;
  return clips.map((c) => {
    if (excludeId && c.id === excludeId) return c;
    if (c.startTime + EPS < fromTime) return c;
    return { ...c, startTime: Math.max(0, c.startTime + deltaSec) };
  });
}

/** True if any two clips on a track overlap. */
export function trackHasOverlap(clips: Clip[]): boolean {
  const sorted = sortClips(clips);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (clipEnd(a) > b.startTime + EPS) return true;
  }
  return false;
}

function mapTrack(
  tracks: Track[],
  trackId: string,
  mapClips: (clips: Clip[]) => Clip[]
): Track[] {
  return tracks.map((t) =>
    t.id === trackId ? { ...t, clips: mapClips(t.clips) } : t
  );
}

function finalize(
  tracks: Track[],
  transitions: Transition[],
  message?: string,
  baselineTracks?: Track[]
): TimelineEditResult {
  for (const t of tracks) {
    if (trackHasOverlap(t.clips)) {
      // Reference recreation uses overlapping phase clips on a single matte/
      // composition track. Those overlaps are part of the compiled structure;
      // only reject an overlap introduced by the edit itself. Keeping the
      // baseline here also makes source-only replacements safe on such tracks.
      const baseline = baselineTracks?.find((candidate) => candidate.id === t.id);
      if (baseline && trackHasOverlap(baseline.clips)) continue;
      return {
        ok: false,
        message: `Operation would create overlapping clips on track "${t.name || t.id}"`,
      };
    }
  }
  return {
    ok: true,
    tracks,
    transitions: pruneInvalidTransitions(tracks, transitions),
    message,
  };
}

/**
 * Close gaps on a track by shifting later clips left.
 * If atTime is set, only the first gap at/after that time is closed.
 */
export function closeGapOnTrack(
  tracks: Track[],
  transitions: Transition[],
  trackId: string,
  atTime?: number
): TimelineEditResult {
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return { ok: false, message: `Track ${trackId} not found` };

  const nextTracks = cloneTracks(tracks);
  const nextTx = cloneTransitions(transitions);
  const tIdx = nextTracks.findIndex((t) => t.id === trackId);
  if (tIdx < 0) return { ok: false, message: `Track ${trackId} not found` };

  let clips = sortClips(nextTracks[tIdx]!.clips);
  let closed = 0;

  const closeOnce = (fromIndex: number): boolean => {
    if (fromIndex < 0 || fromIndex >= clips.length - 1) return false;
    const a = clips[fromIndex]!;
    const b = clips[fromIndex + 1]!;
    const gap = b.startTime - clipEnd(a);
    if (gap <= EPS) return false;
    clips = shiftClipsAfter(clips, b.startTime, -gap);
    closed++;
    return true;
  };

  if (atTime != null && Number.isFinite(atTime)) {
    const t = Number(atTime);
    let idx = -1;
    for (let i = 0; i < clips.length - 1; i++) {
      const aEnd = clipEnd(clips[i]!);
      const bStart = clips[i + 1]!.startTime;
      if (bStart - aEnd > EPS && t <= bStart + EPS && t + EPS >= aEnd) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      for (let i = 0; i < clips.length - 1; i++) {
        if (
          clips[i + 1]!.startTime >= t - EPS &&
          clipEnd(clips[i]!) + EPS < clips[i + 1]!.startTime
        ) {
          idx = i;
          break;
        }
      }
    }
    if (idx >= 0) closeOnce(idx);
  } else {
    let guard = 0;
    while (guard++ < 1000) {
      clips = sortClips(clips);
      let foundGap = false;
      for (let i = 0; i < clips.length - 1; i++) {
        if (closeOnce(i)) {
          foundGap = true;
          break;
        }
      }
      if (!foundGap) break;
    }
  }

  nextTracks[tIdx] = { ...nextTracks[tIdx]!, clips };
  return finalize(
    nextTracks,
    nextTx,
    closed > 0 ? `Closed ${closed} gap(s) on track` : "No gaps to close"
  );
}

/**
 * Delete clip and pull following clips left (same track).
 * Always strips transitions involving the clip (A–TX–B–C safe).
 */
export function rippleDeleteClip(
  tracks: Track[],
  transitions: Transition[],
  clipId: string
): TimelineEditResult {
  const found = findClip(tracks, clipId);
  if (!found) return { ok: false, message: `Clip ${clipId} not found` };

  const { track, clip } = found;
  const pivot = clip.startTime;
  const delta = -clip.duration;

  const cleared = removeMatchingTransitions(
    cloneTracks(tracks),
    cloneTransitions(transitions),
    (tr) => tr.clipAId === clipId || tr.clipBId === clipId
  );

  const nextTracks = mapTrack(cleared.tracks, track.id, (clips) => {
    const without = clips.filter((c) => c.id !== clipId);
    return shiftClipsAfter(without, pivot, delta);
  });

  return finalize(
    nextTracks,
    cleared.transitions,
    `Ripple-deleted ${clipId}; shifted following clips by ${delta.toFixed(3)}s`
  );
}

/** Lift-style delete: leave a hole, but always prune transitions. */
export function deleteClipLeaveGap(
  tracks: Track[],
  transitions: Transition[],
  clipId: string
): TimelineEditResult {
  const found = findClip(tracks, clipId);
  if (!found) return { ok: false, message: `Clip ${clipId} not found` };

  const cleared = removeMatchingTransitions(
    cloneTracks(tracks),
    cloneTransitions(transitions),
    (tr) => tr.clipAId === clipId || tr.clipBId === clipId
  );

  const nextTracks = mapTrack(cleared.tracks, found.track.id, (clips) =>
    clips.filter((c) => c.id !== clipId)
  );

  return finalize(nextTracks, cleared.transitions, `Deleted ${clipId} (gap left)`);
}

/**
 * Trim with ripple. Geometry-only: does not rewrite speedRamp/hold/reversed.
 *
 * Followers move only by out-point delta (`newEnd - oldEnd`) so in-point and
 * combined trims never double-shift. In-point changes adjust `sourceOffset` only.
 */
export function rippleTrimClip(
  tracks: Track[],
  transitions: Transition[],
  clipId: string,
  patch: { startTime?: number; duration?: number }
): TimelineEditResult {
  const found = findClip(tracks, clipId);
  if (!found) return { ok: false, message: `Clip ${clipId} not found` };

  let nextTracks = cloneTracks(tracks);
  let nextTx = cloneTransitions(transitions);
  const loc = findClip(nextTracks, clipId);
  if (!loc) return { ok: false, message: `Clip ${clipId} not found` };

  const clip = loc.clip;
  const oldStart = clip.startTime;
  const oldEnd = clipEnd(clip);
  const oldDuration = clip.duration;

  const newStart =
    patch.startTime !== undefined ? Number(patch.startTime) : oldStart;
  const newDuration =
    patch.duration !== undefined ? Number(patch.duration) : oldDuration;

  if (!Number.isFinite(newStart) || newStart < 0) {
    return { ok: false, message: "startTime must be a non-negative finite number" };
  }
  if (!Number.isFinite(newDuration) || newDuration <= EPS) {
    return { ok: false, message: "duration must be a positive finite number" };
  }

  const startDelta = newStart - oldStart;
  let sourceOffset = clip.sourceOffset || 0;
  if (Math.abs(startDelta) > EPS && clip.sourceMediaId) {
    const speed = Math.abs(clip.speed) || 1;
    sourceOffset = Math.max(0, sourceOffset + startDelta * speed);
  }

  const newEnd = newStart + newDuration;

  // Apply trim to the clip first (excludeId keeps it stable during neighbor shifts).
  clip.startTime = newStart;
  clip.duration = newDuration;
  clip.sourceOffset = sourceOffset;

  // Ripple only from the old out-point. endDelta alone covers in-only moves that
  // keep duration (newEnd shifts with start) without double-counting.
  const endDelta = newEnd - oldEnd;
  if (Math.abs(endDelta) > EPS) {
    nextTracks = mapTrack(nextTracks, loc.track.id, (clips) =>
      shiftClipsAfter(clips, oldEnd, endDelta, clipId)
    );
  }

  // Geometry changed — drop TX involving this clip (same as plain trim).
  const cleared = removeMatchingTransitions(
    nextTracks,
    nextTx,
    (tr) => tr.clipAId === clipId || tr.clipBId === clipId
  );
  nextTracks = cleared.tracks;
  nextTx = cleared.transitions;

  return finalize(
    nextTracks,
    nextTx,
    `Ripple-trimmed ${clipId} to start=${newStart.toFixed(3)}s duration=${newDuration.toFixed(3)}s`
  );
}

/**
 * Replace media in place. Clamps source window when mediaDurationSec known.
 * Does not invent hold; does not clear looks.
 */
export function replaceClipMedia(
  tracks: Track[],
  transitions: Transition[],
  clipId: string,
  opts: {
    sourceMediaId: string;
    sourceOffset?: number;
    mediaDurationSec?: number;
    fit?: ReplaceFit;
  }
): TimelineEditResult {
  const found = findClip(tracks, clipId);
  if (!found) return { ok: false, message: `Clip ${clipId} not found` };
  if (!opts.sourceMediaId) {
    return { ok: false, message: "sourceMediaId is required" };
  }

  const nextTracks = cloneTracks(tracks);
  const nextTx = cloneTransitions(transitions);
  const loc = findClip(nextTracks, clipId);
  if (!loc) return { ok: false, message: `Clip ${clipId} not found` };

  const clip = loc.clip;
  if (clip.sourceSequenceId) {
    return {
      ok: false,
      message: `Clip ${clipId} is a nested sequence — replace media is not supported on nest clips`,
    };
  }
  const fit = opts.fit === "fit-media" ? "fit-media" : "keep-duration";
  const speed = Math.abs(clip.speed) || 1;
  let sourceOffset =
    opts.sourceOffset !== undefined
      ? Math.max(0, Number(opts.sourceOffset) || 0)
      : 0;
  const mediaDur =
    opts.mediaDurationSec != null && Number.isFinite(opts.mediaDurationSec)
      ? Math.max(0, Number(opts.mediaDurationSec))
      : null;

  clip.sourceMediaId = String(opts.sourceMediaId);
  clip.sourceSequenceId = null;

  let warn = "";

  if (fit === "fit-media") {
    if (mediaDur == null) {
      return { ok: false, message: "fit-media requires mediaDurationSec" };
    }
    const usable = Math.max(0, mediaDur - sourceOffset);
    if (usable <= EPS) {
      return { ok: false, message: "No usable media after sourceOffset" };
    }
    clip.sourceOffset = sourceOffset;
    clip.duration = usable / speed;
  } else {
    clip.duration = found.clip.duration;
    if (mediaDur != null) {
      const need = clip.duration * speed;
      if (need > mediaDur + EPS) {
        // Never invent hold — shorten timeline duration to usable media.
        sourceOffset = 0;
        clip.duration = mediaDur / speed;
        warn =
          " media shorter than timeline duration — duration shortened to fit (no hold invented)";
      } else {
        const maxOffset = Math.max(0, mediaDur - need);
        if (sourceOffset > maxOffset) sourceOffset = maxOffset;
      }
    }
    clip.sourceOffset = sourceOffset;
  }

  return finalize(
    nextTracks,
    nextTx,
    `Replaced media on ${clipId} (fit=${fit})${warn}`,
    tracks
  );
}
