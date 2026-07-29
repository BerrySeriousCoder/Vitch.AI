import type { Clip, Track, Transition } from "@tempo/types";
import { mapSourcePointToTimeline, mapTimelinePointToSource } from "./source-media-timeline";
import { clipEnd, pruneInvalidTransitions, type MediaDurationMap } from "./transitions";
import type { TimelineEditResult } from "./timeline-edit";

const EPS = 1e-4;

function cloneTracks(tracks: Track[]): Track[] {
  return JSON.parse(JSON.stringify(tracks)) as Track[];
}

function findClip(tracks: Track[], clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

function durationFor(clip: Clip, mediaDurations: MediaDurationMap): number | null {
  if (!clip.sourceMediaId) return Number.POSITIVE_INFINITY;
  return mediaDurations instanceof Map
    ? mediaDurations.get(clip.sourceMediaId) ?? null
    : mediaDurations[clip.sourceMediaId] ?? null;
}

function assertConstantForward(clip: Clip): string | null {
  if (clip.reversed || (clip.speed ?? 1) < 0 || clip.speedRamp?.length) {
    return "Advanced source edits currently require a forward constant-speed clip (no reverse or speed ramp)";
  }
  return null;
}

function sourceEnd(clip: Clip): number {
  return clip.sourceOffset + clip.duration * Math.max(EPS, clip.speed || 1);
}

function finalize(tracks: Track[], transitions: Transition[], message: string): TimelineEditResult {
  return { ok: true, tracks, transitions: pruneInvalidTransitions(tracks, transitions), message };
}

/** Move the shared boundary of two abutting clips without moving later clips. */
export function rollEdit(
  tracks: Track[],
  transitions: Transition[],
  clipAId: string,
  clipBId: string,
  deltaSec: number,
  mediaDurations: MediaDurationMap
): TimelineEditResult {
  if (!Number.isFinite(deltaSec) || Math.abs(deltaSec) < EPS) return { ok: false, message: "deltaSec must be a non-zero finite number" };
  const next = cloneTracks(tracks);
  const a = findClip(next, clipAId);
  const b = findClip(next, clipBId);
  if (!a || !b || a.track.id !== b.track.id) return { ok: false, message: "Roll edit requires two clips on the same track" };
  if (Math.abs(clipEnd(a.clip) - b.clip.startTime) > EPS) return { ok: false, message: "Roll edit requires abutting clips" };
  for (const clip of [a.clip, b.clip]) {
    const error = assertConstantForward(clip);
    if (error) return { ok: false, message: error };
  }
  const newADuration = a.clip.duration + deltaSec;
  const newBDuration = b.clip.duration - deltaSec;
  const newBOffset = b.clip.sourceOffset + deltaSec * (b.clip.speed || 1);
  if (newADuration <= EPS || newBDuration <= EPS || newBOffset < -EPS) return { ok: false, message: "Roll edit would trim a clip below zero duration or before its source in-point" };
  const aDuration = durationFor(a.clip, mediaDurations);
  const bDuration = durationFor(b.clip, mediaDurations);
  if (aDuration == null || bDuration == null) return { ok: false, message: "Known media durations are required for a roll edit" };
  if (sourceEnd({ ...a.clip, duration: newADuration }) > aDuration + EPS || sourceEnd({ ...b.clip, sourceOffset: newBOffset, duration: newBDuration }) > bDuration + EPS) {
    return { ok: false, message: "Roll edit exceeds available source handles" };
  }
  a.clip.duration = newADuration;
  b.clip.startTime += deltaSec;
  b.clip.duration = newBDuration;
  b.clip.sourceOffset = Math.max(0, newBOffset);
  const tx = transitions.filter((transition) => transition.clipAId !== clipAId && transition.clipBId !== clipAId && transition.clipAId !== clipBId && transition.clipBId !== clipBId);
  return finalize(next, tx, `Rolled edit point by ${deltaSec.toFixed(3)}s`);
}

/** Slide a clip between two abutting neighbors, preserving the outer cut points. */
export function slideEdit(
  tracks: Track[],
  transitions: Transition[],
  clipId: string,
  deltaSec: number,
  mediaDurations: MediaDurationMap
): TimelineEditResult {
  if (!Number.isFinite(deltaSec) || Math.abs(deltaSec) < EPS) return { ok: false, message: "deltaSec must be a non-zero finite number" };
  const next = cloneTracks(tracks);
  const current = findClip(next, clipId);
  if (!current) return { ok: false, message: `Clip ${clipId} not found` };
  const ordered = [...current.track.clips].sort((a, b) => a.startTime - b.startTime);
  const index = ordered.findIndex((clip) => clip.id === clipId);
  const prev = ordered[index - 1];
  const following = ordered[index + 1];
  if (!prev || !following || Math.abs(clipEnd(prev) - current.clip.startTime) > EPS || Math.abs(clipEnd(current.clip) - following.startTime) > EPS) {
    return { ok: false, message: "Slide edit requires abutting previous and next clips" };
  }
  for (const clip of [prev, current.clip, following]) {
    const error = assertConstantForward(clip);
    if (error) return { ok: false, message: error };
  }
  const nextPrevDuration = prev.duration + deltaSec;
  const nextFollowingDuration = following.duration - deltaSec;
  const nextFollowingOffset = following.sourceOffset + deltaSec * (following.speed || 1);
  if (nextPrevDuration <= EPS || nextFollowingDuration <= EPS || nextFollowingOffset < -EPS) return { ok: false, message: "Slide edit would trim a neighbor below zero duration or before source in-point" };
  const prevDuration = durationFor(prev, mediaDurations);
  const followingDuration = durationFor(following, mediaDurations);
  if (prevDuration == null || followingDuration == null) return { ok: false, message: "Known media durations are required for a slide edit" };
  if (sourceEnd({ ...prev, duration: nextPrevDuration }) > prevDuration + EPS || sourceEnd({ ...following, sourceOffset: nextFollowingOffset, duration: nextFollowingDuration }) > followingDuration + EPS) {
    return { ok: false, message: "Slide edit exceeds available source handles" };
  }
  prev.duration = nextPrevDuration;
  current.clip.startTime += deltaSec;
  following.duration = nextFollowingDuration;
  following.sourceOffset = Math.max(0, nextFollowingOffset);
  const tx = transitions.filter((transition) => ![prev.id, clipId, following.id].includes(transition.clipAId) && ![prev.id, clipId, following.id].includes(transition.clipBId));
  return finalize(next, tx, `Slid clip by ${deltaSec.toFixed(3)}s`);
}

/** Move a clip’s source window while keeping its timeline position and duration unchanged. */
export function slipEdit(
  tracks: Track[],
  transitions: Transition[],
  clipId: string,
  deltaSourceSec: number,
  mediaDurations: MediaDurationMap
): TimelineEditResult {
  if (!Number.isFinite(deltaSourceSec) || Math.abs(deltaSourceSec) < EPS) return { ok: false, message: "deltaSourceSec must be a non-zero finite number" };
  const next = cloneTracks(tracks);
  const found = findClip(next, clipId);
  if (!found) return { ok: false, message: `Clip ${clipId} not found` };
  const error = assertConstantForward(found.clip);
  if (error) return { ok: false, message: error };
  const duration = durationFor(found.clip, mediaDurations);
  if (duration == null) return { ok: false, message: "Known media duration is required for a slip edit" };
  const nextOffset = found.clip.sourceOffset + deltaSourceSec;
  if (nextOffset < -EPS || sourceEnd({ ...found.clip, sourceOffset: nextOffset }) > duration + EPS) return { ok: false, message: "Slip edit exceeds available source handles" };
  found.clip.sourceOffset = Math.max(0, nextOffset);
  return finalize(next, transitions, `Slipped source by ${deltaSourceSec.toFixed(3)}s`);
}

/** Locate the timeline time for the source frame under a reference timeline time. */
export function matchFrameTime(
  tracks: Track[],
  referenceClipId: string,
  referenceTimelineTime: number,
  targetClipId: string
): { ok: true; sourceTime: number; targetTimelineTime: number } | { ok: false; message: string } {
  const reference = findClip(tracks, referenceClipId)?.clip;
  const target = findClip(tracks, targetClipId)?.clip;
  if (!reference || !target) return { ok: false, message: "Reference and target clips must exist" };
  if (!reference.sourceMediaId || reference.sourceMediaId !== target.sourceMediaId) return { ok: false, message: "Match frame requires clips using the same source media" };
  const sourceTime = mapTimelinePointToSource(reference, referenceTimelineTime);
  if (sourceTime == null) return { ok: false, message: "Reference timeline time is outside its clip" };
  const targetTimelineTime = mapSourcePointToTimeline(target, sourceTime);
  if (targetTimelineTime == null) return { ok: false, message: "That source frame is outside the target clip’s source range" };
  return { ok: true, sourceTime, targetTimelineTime };
}
