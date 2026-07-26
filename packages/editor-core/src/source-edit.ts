import type { Clip, Track, Transition } from "@tempo/types";
import { removeMatchingTransitions } from "./transitions";

const EPSILON = 1e-4;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type SourceEditMode = "insert" | "overwrite";

export interface SourceEditMetadata {
  insertedClipId: string;
  /** Original/second clip pairs whose source-bound captions may need rebinding. */
  splitPairs: Array<{ firstClipId: string; secondClipId: string }>;
  /** Source clips removed completely by an overwrite. */
  removedClipIds: string[];
  /** Existing source clips whose timeline or source geometry changed. */
  changedClipIds: string[];
}

export type SourceEditResult =
  | { ok: true; tracks: Track[]; transitions: Transition[]; metadata: SourceEditMetadata }
  | { ok: false; message: string };

function cloneTracks(tracks: Track[]): Track[] {
  return deepClone(tracks);
}

function cloneTransitions(transitions: Transition[]): Transition[] {
  return deepClone(transitions);
}

/**
 * Apply a Source Monitor insert/overwrite while preserving linked A/V ripple
 * sync and returning enough provenance for caption bindings to be repaired.
 */
export function sourceEdit(
  tracks: Track[],
  transitions: Transition[],
  trackId: string,
  incoming: Omit<Clip, "id" | "trackId">,
  mode: SourceEditMode,
  createId: () => string
): SourceEditResult {
  const sourceTrack = tracks.find((track) => track.id === trackId);
  if (!sourceTrack) return { ok: false, message: "Target track was not found" };
  if (sourceTrack.locked) return { ok: false, message: "Target track is locked" };
  if (sourceTrack.type !== "video" && sourceTrack.type !== "audio") {
    return { ok: false, message: "Source edits require a video or audio track" };
  }

  const start = Number(incoming.startTime);
  const duration = Number(incoming.duration);
  if (!Number.isFinite(start) || start < 0) return { ok: false, message: "Start time must be a non-negative finite number" };
  if (!Number.isFinite(duration) || duration < 0.05) return { ok: false, message: "Duration must be at least 0.05 seconds" };
  const end = start + duration;
  const crossesInsert = (clip: Clip) => clip.startTime < start - EPSILON && clip.startTime + clip.duration > start + EPSILON;
  const overlapsOverwrite = (clip: Clip) => clip.startTime < end - EPSILON && clip.startTime + clip.duration > start + EPSILON;
  const destructive = sourceTrack.clips.filter(mode === "insert" ? crossesInsert : overlapsOverwrite);
  if (destructive.some((clip) => clip.linkGroupId || clip.reversed || clip.speedRamp?.length || clip.hold)) {
    return { ok: false, message: "Source insert/overwrite will not split linked, reverse, speed-ramped, or hold clips. Edit that clip manually to preserve sync." };
  }

  const linkedGroupsToRipple = new Set(
    mode === "insert"
      ? sourceTrack.clips.filter((clip) => clip.startTime >= start - EPSILON && clip.linkGroupId).map((clip) => clip.linkGroupId!)
      : []
  );
  if (linkedGroupsToRipple.size > 0) {
    const lockedLinkedTrack = tracks.find((track) => track.locked && track.clips.some((clip) => clip.linkGroupId && linkedGroupsToRipple.has(clip.linkGroupId)));
    if (lockedLinkedTrack) return { ok: false, message: `Linked ripple would modify locked track "${lockedLinkedTrack.name}"` };
  }

  const crossingIds = new Set(destructive.map((clip) => clip.id));
  const shiftedIds = new Set<string>();
  if (mode === "insert") {
    for (const track of tracks) {
      for (const clip of track.clips) {
        if ((track.id === trackId && clip.startTime >= start - EPSILON) || (clip.linkGroupId && linkedGroupsToRipple.has(clip.linkGroupId))) {
          shiftedIds.add(clip.id);
        }
      }
    }
  }
  const cleared = removeMatchingTransitions(
    cloneTracks(tracks),
    cloneTransitions(transitions),
    (transition) => {
      if (crossingIds.has(transition.clipAId) || crossingIds.has(transition.clipBId)) return true;
      const aShifted = shiftedIds.has(transition.clipAId);
      const bShifted = shiftedIds.has(transition.clipBId);
      return aShifted !== bShifted;
    }
  );

  const nextTrack = cleared.tracks.find((track) => track.id === trackId)!;
  const insertedClipId = createId();
  const inserted: Clip = { ...deepClone(incoming), id: insertedClipId, trackId, startTime: start, duration };
  const nextClips: Clip[] = [];
  const splitPairs: SourceEditMetadata["splitPairs"] = [];
  const removedClipIds: string[] = [];
  const changedClipIds = new Set<string>();

  for (const clip of nextTrack.clips) {
    const clipEnd = clip.startTime + clip.duration;
    if (mode === "insert") {
      if (clip.startTime >= start - EPSILON) {
        nextClips.push({ ...clip, startTime: clip.startTime + duration });
        changedClipIds.add(clip.id);
      } else if (clipEnd <= start + EPSILON) {
        nextClips.push(clip);
      } else {
        const leftDuration = start - clip.startTime;
        const secondId = createId();
        nextClips.push({ ...clip, duration: leftDuration });
        nextClips.push({
          ...clip,
          id: secondId,
          startTime: start + duration,
          duration: clipEnd - start,
          sourceOffset: clip.sourceOffset + leftDuration * Math.abs(clip.speed || 1),
        });
        splitPairs.push({ firstClipId: clip.id, secondClipId: secondId });
        changedClipIds.add(clip.id);
        changedClipIds.add(secondId);
      }
      continue;
    }

    if (clipEnd <= start + EPSILON || clip.startTime >= end - EPSILON) {
      nextClips.push(clip);
      continue;
    }
    const keepLeft = clip.startTime < start - EPSILON;
    const keepRight = clipEnd > end + EPSILON;
    if (keepLeft) {
      nextClips.push({ ...clip, duration: start - clip.startTime });
      changedClipIds.add(clip.id);
    }
    if (keepRight) {
      const rightId = keepLeft ? createId() : clip.id;
      nextClips.push({
        ...clip,
        id: rightId,
        startTime: end,
        duration: clipEnd - end,
        sourceOffset: clip.sourceOffset + (end - clip.startTime) * Math.abs(clip.speed || 1),
      });
      changedClipIds.add(rightId);
      if (keepLeft) splitPairs.push({ firstClipId: clip.id, secondClipId: rightId });
    }
    if (!keepLeft && !keepRight) removedClipIds.push(clip.id);
  }

  nextClips.push(inserted);
  nextTrack.clips = nextClips.sort((a, b) => a.startTime - b.startTime);

  if (mode === "insert" && linkedGroupsToRipple.size > 0) {
    for (const track of cleared.tracks) {
      if (track.id === trackId) continue;
      track.clips = track.clips.map((clip) => {
        if (!clip.linkGroupId || !linkedGroupsToRipple.has(clip.linkGroupId)) return clip;
        changedClipIds.add(clip.id);
        return { ...clip, startTime: clip.startTime + duration };
      });
    }
  }

  return {
    ok: true,
    tracks: cleared.tracks,
    transitions: cleared.transitions,
    metadata: { insertedClipId, splitPairs, removedClipIds, changedClipIds: [...changedClipIds] },
  };
}
