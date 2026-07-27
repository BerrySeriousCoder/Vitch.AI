import type { Clip, Track, Transition } from "@tempo/types";
import { pruneInvalidTransitions } from "./transitions";
import type { TimelineEditResult } from "./timeline-edit";

const EPS = 1e-4;

function cloneTracks(tracks: Track[]): Track[] {
  return JSON.parse(JSON.stringify(tracks)) as Track[];
}

function findClip(tracks: readonly Track[], clipId: string): Clip | null {
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return null;
}

export function linkClips(tracks: Track[], clipIds: string[], linkGroupId: string): { ok: true; tracks: Track[]; clipIds: string[] } | { ok: false; message: string } {
  const ids = [...new Set(clipIds)];
  if (ids.length < 2) return { ok: false, message: "Link at least two clips" };
  if (ids.some((id) => !findClip(tracks, id))) return { ok: false, message: "Every linked clip must exist" };
  const clips = ids.map((id) => findClip(tracks, id)!);
  const reference = clips[0]!;
  if (clips.some((clip) => Math.abs(clip.startTime - reference.startTime) > EPS || Math.abs(clip.duration - reference.duration) > EPS)) {
    return { ok: false, message: "Linked A/V clips must share the same timeline start and duration" };
  }
  return { ok: true, tracks: tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ids.includes(clip.id) ? { ...clip, linkGroupId } : clip) })), clipIds: ids };
}

export function unlinkClips(tracks: Track[], clipIds: string[]): { ok: true; tracks: Track[]; clipIds: string[] } | { ok: false; message: string } {
  const ids = [...new Set(clipIds)];
  if (ids.length === 0) return { ok: false, message: "Provide one or more clip IDs" };
  if (ids.some((id) => !findClip(tracks, id))) return { ok: false, message: "Every clip must exist" };
  return { ok: true, tracks: tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ids.includes(clip.id) ? { ...clip, linkGroupId: null } : clip) })), clipIds: ids };
}

/** Remove a synchronised linked group and ripple every affected track together. */
export function rippleDeleteLinkedGroup(tracks: Track[], transitions: Transition[], clipId: string): TimelineEditResult {
  const selected = findClip(tracks, clipId);
  if (!selected?.linkGroupId) return { ok: false, message: "Selected clip is not linked" };
  const group = tracks.flatMap((track) => track.clips).filter((clip) => clip.linkGroupId === selected.linkGroupId);
  const start = selected.startTime;
  const duration = selected.duration;
  if (group.some((clip) => Math.abs(clip.startTime - start) > EPS || Math.abs(clip.duration - duration) > EPS)) {
    return { ok: false, message: "Linked clips must share start time and duration for ripple delete" };
  }
  const ids = new Set(group.map((clip) => clip.id));
  const nextTracks = cloneTracks(tracks).map((track) => {
    const affected = track.clips.some((clip) => ids.has(clip.id));
    const clips = track.clips.filter((clip) => !ids.has(clip.id)).map((clip) => affected && clip.startTime >= start - EPS ? { ...clip, startTime: Math.max(0, clip.startTime - duration) } : clip);
    return { ...track, clips };
  });
  const nextTransitions = transitions.filter((transition) => !ids.has(transition.clipAId) && !ids.has(transition.clipBId));
  return { ok: true, tracks: nextTracks, transitions: pruneInvalidTransitions(nextTracks, nextTransitions), message: `Ripple-deleted linked group (${group.length} clips)` };
}
