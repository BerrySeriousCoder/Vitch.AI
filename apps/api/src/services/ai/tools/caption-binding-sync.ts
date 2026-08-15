import type { Clip } from "@tempo/types";
import { getClipSourceRange, mapSourceIntervalToTimeline } from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";

function allCaptionClips(state: ProjectState): Clip[] {
  return state.tracks
    .filter((track) => track.type === "text")
    .flatMap((track) => track.clips)
    .filter((clip) => Boolean(clip.captionBinding));
}

export function syncCaptionsBoundToClip(
  state: ProjectState,
  sourceClip: Clip
): { updated: number; stale: number } {
  let updated = 0;
  let stale = 0;
  for (const caption of allCaptionClips(state)) {
    const binding = caption.captionBinding!;
    if (binding.sourceClipId !== sourceClip.id) continue;
    const mapped = mapSourceIntervalToTimeline(sourceClip, [binding.sourceStart, binding.sourceEnd]);
    if (!mapped) {
      binding.stale = true;
      stale++;
      continue;
    }
    const intentionalOffset = (binding.intentionalOffsetMs || 0) / 1000;
    const clippedByEdit =
      mapped[0] <= sourceClip.startTime && binding.sourceStart < sourceClip.sourceOffset ||
      mapped[1] >= sourceClip.startTime + sourceClip.duration &&
        binding.sourceEnd > sourceClip.sourceOffset + sourceClip.duration * sourceClip.speed;
    caption.startTime = mapped[0] + intentionalOffset;
    caption.duration = mapped[1] - mapped[0];
    binding.stale = clippedByEdit;
    if (clippedByEdit) stale++;
    else updated++;
  }
  return { updated, stale };
}

export function rebindCaptionsAfterSplit(
  state: ProjectState,
  firstClip: Clip,
  secondClip: Clip
): { first: number; second: number; stale: number } {
  const firstRange = getClipSourceRange(firstClip);
  const secondRange = getClipSourceRange(secondClip);
  let first = 0;
  let second = 0;
  let stale = 0;

  for (const caption of allCaptionClips(state)) {
    const binding = caption.captionBinding!;
    if (binding.sourceClipId !== firstClip.id) continue;
    const represented: readonly [number, number] = [binding.sourceStart, binding.sourceEnd];
    const inFirst = represented[0] >= firstRange[0] && represented[1] <= firstRange[1];
    const inSecond = represented[0] >= secondRange[0] && represented[1] <= secondRange[1];
    if (inFirst) {
      first++;
      continue;
    }
    if (inSecond) {
      binding.sourceClipId = secondClip.id;
      second++;
      continue;
    }
    binding.stale = true;
    stale++;
  }

  syncCaptionsBoundToClip(state, firstClip);
  syncCaptionsBoundToClip(state, secondClip);
  return { first, second, stale };
}

export function markCaptionsForMissingSourceStale(
  state: ProjectState,
  sourceClipId: string
): number {
  let count = 0;
  for (const caption of allCaptionClips(state)) {
    if (caption.captionBinding?.sourceClipId !== sourceClipId) continue;
    caption.captionBinding.stale = true;
    count++;
  }
  return count;
}
