import type { Clip, Track } from "@tempo/types";

export interface EditPointCandidate {
  trackId: string;
  trackName: string;
  trackType: string;
  clipAId: string;
  clipBId: string;
  /** Cut time ≈ clipA out (clipB.startTime when abutting) */
  cutTime: number;
  gapSec: number;
  abutting: boolean;
  clipAOut: number;
  clipBIn: number;
}

const ABUT_EPS = 1e-3;

/**
 * List sequential cut candidates on tracks (sorted by startTime).
 * Abutting pairs (gap ≈ 0) are preferred for add_transition.
 */
export function listEditPoints(
  tracks: Track[],
  options?: { trackId?: string; abuttingOnly?: boolean; maxGapSec?: number }
): EditPointCandidate[] {
  const maxGap = options?.maxGapSec ?? 0.05;
  const out: EditPointCandidate[] = [];

  for (const track of tracks) {
    if (options?.trackId && track.id !== options.trackId) continue;
    const clips = [...track.clips].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i]!;
      const b = clips[i + 1]!;
      const aOut = a.startTime + a.duration;
      const gap = b.startTime - aOut;
      const abutting = Math.abs(gap) <= ABUT_EPS;
      if (options?.abuttingOnly && !abutting) continue;
      if (!abutting && gap > maxGap) continue;
      if (gap < -ABUT_EPS) continue; // overlap — not a clean edit point
      out.push({
        trackId: track.id,
        trackName: track.name,
        trackType: track.type,
        clipAId: a.id,
        clipBId: b.id,
        cutTime: abutting ? b.startTime : aOut,
        gapSec: gap,
        abutting,
        clipAOut: aOut,
        clipBIn: b.startTime,
      });
    }
  }

  return out;
}

/** Locate which track holds a clip (if any). */
export function findClipLocation(
  tracks: Track[],
  clipId: string
): { track: Track; clip: Clip } | null {
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/**
 * When two clips are not on the same track, suggest recovery for the agent.
 */
export function transitionSameTrackHint(
  tracks: Track[],
  clipAId: string,
  clipBId: string
): {
  error: string;
  fixHint: string;
  clipLocations: Array<{ clipId: string; trackId: string; trackName: string }>;
  suggestedPairs: Array<{ clipAId: string; clipBId: string; trackId: string }>;
} {
  const locA = findClipLocation(tracks, clipAId);
  const locB = findClipLocation(tracks, clipBId);
  const clipLocations: Array<{
    clipId: string;
    trackId: string;
    trackName: string;
  }> = [];
  if (locA) {
    clipLocations.push({
      clipId: clipAId,
      trackId: locA.track.id,
      trackName: locA.track.name,
    });
  }
  if (locB) {
    clipLocations.push({
      clipId: clipBId,
      trackId: locB.track.id,
      trackName: locB.track.name,
    });
  }

  const suggestedPairs = listEditPoints(tracks, { abuttingOnly: true })
    .slice(0, 8)
    .map((p) => ({
      clipAId: p.clipAId,
      clipBId: p.clipBId,
      trackId: p.trackId,
    }));

  let fixHint =
    "Call list_edit_points (abuttingOnly:true) and use a clipAId/clipBId pair from the same track.";
  if (!locA || !locB) {
    fixHint =
      "One or both clip ids were not found. Use exact clipId from the last create tool JSON (ok.clipId) or inspect_timeline — never invent UUIDs.";
  } else if (locA.track.id !== locB.track.id) {
    fixHint = `Clips are on different tracks ("${locA.track.name}" vs "${locB.track.name}"). Transitions require the same track. Pick an abutting pair from list_edit_points.`;
  }

  return {
    error: "Both clips must exist on the same track",
    fixHint,
    clipLocations,
    suggestedPairs,
  };
}
