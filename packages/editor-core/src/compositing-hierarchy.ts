import type { Clip, Track, TrackMatte, Transform } from "@tempo/types";

/** Column-major-independent 2D affine matrix: [a, b, c, d, tx, ty]. */
export type AffineTransform = readonly [number, number, number, number, number, number];

export interface LocalCompositingState {
  clipId: string;
  transform: Transform;
  opacity: number;
}

export interface ResolvedCompositingState {
  clipId: string;
  matrix: AffineTransform;
  opacity: number;
  /** Empty for a root; useful to inspector/debug tooling. */
  parentChain: string[];
}

export interface CompositingIssue {
  code:
    | "missing_parent"
    | "parent_cycle"
    | "missing_track_matte"
    | "self_track_matte"
    | "invalid_track_matte_source"
    | "track_matte_no_overlap";
  clipId: string;
  message: string;
}

function clipsWithTracks(tracks: readonly Track[]): Array<{ clip: Clip; track: Track }> {
  return tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track })));
}

export function transformToAffine(transform: Transform): AffineTransform {
  const radians = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = cos * transform.scaleX;
  const b = sin * transform.scaleX;
  const c = -sin * transform.scaleY;
  const d = cos * transform.scaleY;
  return [
    a,
    b,
    c,
    d,
    transform.x + transform.anchorX - a * transform.anchorX - c * transform.anchorY,
    transform.y + transform.anchorY - b * transform.anchorX - d * transform.anchorY,
  ];
}

/** Returns `parent × child`, preserving rotation, scale, and anchor offsets. */
export function multiplyAffineTransforms(
  parent: AffineTransform,
  child: AffineTransform
): AffineTransform {
  const [pa, pb, pc, pd, ptx, pty] = parent;
  const [ca, cb, cc, cd, ctx, cty] = child;
  return [
    pa * ca + pc * cb,
    pb * ca + pd * cb,
    pa * cc + pc * cd,
    pb * cc + pd * cd,
    pa * ctx + pc * cty + ptx,
    pb * ctx + pd * cty + pty,
  ];
}

/**
 * Resolves transform/opacity inheritance without mutating clips. Cycles and
 * missing parents safely fall back to the child-local state; validation reports
 * those conditions separately so preview and export never recurse forever.
 */
export function resolveCompositingStates(
  tracks: readonly Track[],
  localStates: readonly LocalCompositingState[]
): Map<string, ResolvedCompositingState> {
  const clipById = new Map(clipsWithTracks(tracks).map(({ clip }) => [clip.id, clip]));
  const localById = new Map(localStates.map((state) => [state.clipId, state]));
  const resolved = new Map<string, ResolvedCompositingState>();
  const resolving = new Set<string>();

  const localFor = (clip: Clip): LocalCompositingState =>
    localById.get(clip.id) || { clipId: clip.id, transform: clip.transform, opacity: clip.opacity };

  const visit = (clip: Clip): ResolvedCompositingState => {
    const cached = resolved.get(clip.id);
    if (cached) return cached;
    const local = localFor(clip);
    const fallback: ResolvedCompositingState = {
      clipId: clip.id,
      matrix: transformToAffine(local.transform),
      opacity: local.opacity,
      parentChain: [],
    };
    if (resolving.has(clip.id)) return fallback;
    resolving.add(clip.id);

    const parent = clip.parentId ? clipById.get(clip.parentId) : undefined;
    const result = parent && parent.id !== clip.id
      ? (() => {
          const inherited = visit(parent);
          return {
            ...fallback,
            matrix: multiplyAffineTransforms(inherited.matrix, fallback.matrix),
            opacity: inherited.opacity * fallback.opacity,
            parentChain: [...inherited.parentChain, parent.id],
          };
        })()
      : fallback;
    resolving.delete(clip.id);
    resolved.set(clip.id, result);
    return result;
  };

  for (const clip of clipById.values()) visit(clip);
  return resolved;
}

export function canSetParent(
  tracks: readonly Track[],
  clipId: string,
  parentId: string | null
): { ok: true } | { ok: false; message: string } {
  if (!parentId) return { ok: true };
  if (clipId === parentId) return { ok: false, message: "A clip cannot parent itself" };
  const byId = new Map(clipsWithTracks(tracks).map(({ clip }) => [clip.id, clip]));
  if (!byId.has(clipId)) return { ok: false, message: `Clip ${clipId} was not found` };
  let cursor = byId.get(parentId);
  if (!cursor) return { ok: false, message: `Parent clip ${parentId} was not found` };
  const seen = new Set<string>();
  while (cursor) {
    if (cursor.id === clipId) return { ok: false, message: "That parent would create a cycle" };
    if (seen.has(cursor.id)) return { ok: false, message: "Existing parent cycle detected" };
    seen.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return { ok: true };
}

export function validateCompositingHierarchy(tracks: readonly Track[]): CompositingIssue[] {
  const entries = clipsWithTracks(tracks);
  const byId = new Map(entries.map(({ clip }) => [clip.id, clip]));
  const trackByClipId = new Map(entries.map(({ clip, track }) => [clip.id, track]));
  const issues: CompositingIssue[] = [];

  for (const { clip } of entries) {
    if (clip.parentId) {
      const parentCheck = canSetParent(tracks, clip.id, clip.parentId);
      if (!parentCheck.ok) {
        issues.push({
          code: parentCheck.message.includes("cycle") ? "parent_cycle" : "missing_parent",
          clipId: clip.id,
          message: `clip ${clip.id}: ${parentCheck.message}`,
        });
      }
    }

    const matte = clip.trackMatte;
    if (!matte) continue;
    const source = byId.get(matte.sourceClipId);
    const sourceTrack = trackByClipId.get(matte.sourceClipId);
    if (!source) {
      issues.push({ code: "missing_track_matte", clipId: clip.id, message: `clip ${clip.id} references missing matte ${matte.sourceClipId}` });
    } else if (source.id === clip.id) {
      issues.push({ code: "self_track_matte", clipId: clip.id, message: `clip ${clip.id} cannot use itself as a track matte` });
    } else if (sourceTrack?.type === "audio" || sourceTrack?.type === "null" || source.nullLayer || source.trackMatte) {
      issues.push({ code: "invalid_track_matte_source", clipId: clip.id, message: `clip ${clip.id} matte ${source.id} must render visual pixels` });
    } else if (
      source.startTime + source.duration <= clip.startTime ||
      clip.startTime + clip.duration <= source.startTime
    ) {
      issues.push({ code: "track_matte_no_overlap", clipId: clip.id, message: `clip ${clip.id} and matte ${source.id} do not overlap in time` });
    }
  }
  return issues;
}

export function setClipParent(
  tracks: readonly Track[],
  clipId: string,
  parentId: string | null
): { ok: true; tracks: Track[] } | { ok: false; message: string } {
  const check = canSetParent(tracks, clipId, parentId);
  if (!check.ok) return check;
  return {
    ok: true,
    tracks: tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === clipId ? { ...clip, parentId } : clip
      ),
    })),
  };
}

export function setClipTrackMatte(
  tracks: readonly Track[],
  clipId: string,
  trackMatte: TrackMatte | null
): { ok: true; tracks: Track[] } | { ok: false; message: string } {
  if (!clipsWithTracks(tracks).some(({ clip }) => clip.id === clipId)) {
    return { ok: false, message: `Clip ${clipId} was not found` };
  }
  const candidate = tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, trackMatte } : clip),
  }));
  const issue = validateCompositingHierarchy(candidate).find((item) => item.clipId === clipId);
  if (issue) return { ok: false, message: issue.message };
  return { ok: true, tracks: candidate };
}
