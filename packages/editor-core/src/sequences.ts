import type { Clip, Sequence, Track, Transition } from "@tempo/types";
import { clipEnd } from "./transitions";
import { sourceTimeAt } from "./speed-ramp";
import type { TimelineValidationIssue } from "./validate-timeline";

const EPS = 1e-4;

const DEFAULT_TRANSFORM = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
};

function newId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `seq_${Math.random().toString(36).slice(2, 10)}`;
}

export function isNestClip(clip: Pick<Clip, "sourceSequenceId">): boolean {
  return Boolean(clip.sourceSequenceId);
}

/** Max clip end on a sequence (content length hint). */
export function sequenceContentEnd(seq: Sequence): number {
  let end = 0;
  for (const t of seq.tracks || []) {
    for (const c of t.clips || []) {
      end = Math.max(end, clipEnd(c));
    }
  }
  return end;
}

/**
 * Map parent timeline time → time inside the nested sequence.
 * Reuses speed / ramp / reverse / hold via sourceTimeAt (sequence is the "source").
 */
export function sequenceLocalTime(clip: Clip, parentTime: number): number {
  const timeInClip = parentTime - clip.startTime;
  if (timeInClip < -EPS || timeInClip > clip.duration + EPS) {
    return Number.NaN;
  }
  const clamped = Math.max(0, Math.min(clip.duration, timeInClip));
  return sourceTimeAt(clip, clamped, null).sourceTime;
}

export function createEmptySequence(name: string): Sequence {
  const trackId = newId();
  return {
    id: newId(),
    name: name || "Sequence",
    tracks: [
      {
        id: trackId,
        name: "V1",
        type: "video",
        order: 0,
        locked: false,
        visible: true,
        solo: false,
        clips: [],
      },
    ],
    transitions: [],
    durationHint: 0,
  };
}

function countRefs(tracks: readonly Track[], sequenceId: string): number {
  let n = 0;
  for (const t of tracks) {
    for (const c of t.clips || []) {
      if (c.sourceSequenceId === sequenceId) n++;
    }
  }
  return n;
}

export function countSequenceUsage(
  tracks: readonly Track[],
  sequenceId: string
): number {
  return countRefs(tracks, sequenceId);
}

export type SequenceOpOk<T> = { ok: true } & T;
export type SequenceOpErr = { ok: false; message: string };
export type SequenceOpResult<T> = SequenceOpOk<T> | SequenceOpErr;

/**
 * Move selected clips from main into a new sequence (timing normalized to 0).
 * Depth-1: rejects if any selected clip is already a nest.
 */
export function createSequenceFromClips(
  tracks: Track[],
  transitions: Transition[],
  sequences: Sequence[],
  clipIds: string[],
  name: string
): SequenceOpResult<{
  tracks: Track[];
  transitions: Transition[];
  sequences: Sequence[];
  sequenceId: string;
  nestClipId: string;
}> {
  const idSet = new Set(clipIds);
  if (idSet.size === 0) {
    return { ok: false, message: "Select at least one clip" };
  }

  const selected: Clip[] = [];
  for (const t of tracks) {
    for (const c of t.clips) {
      if (idSet.has(c.id)) selected.push(c);
    }
  }
  if (selected.length !== idSet.size) {
    return { ok: false, message: "One or more clip ids not found on main timeline" };
  }
  if (selected.some((c) => isNestClip(c))) {
    return { ok: false, message: "Cannot nest a sequence inside a sequence (depth 1)" };
  }

  const t0 = Math.min(...selected.map((c) => c.startTime));
  const t1 = Math.max(...selected.map((c) => clipEnd(c)));
  const duration = Math.max(EPS, t1 - t0);

  // Group by original track — preserve track layout inside sequence
  const byTrack = new Map<string, Clip[]>();
  for (const c of selected) {
    const list = byTrack.get(c.trackId) || [];
    list.push(c);
    byTrack.set(c.trackId, list);
  }

  const trackIdMap = new Map<string, string>();
  const seqTracks: Track[] = [];
  let order = 0;
  for (const [oldTrackId, clips] of byTrack) {
    const mainTrack = tracks.find((t) => t.id === oldTrackId);
    const newTrackId = newId();
    trackIdMap.set(oldTrackId, newTrackId);
    seqTracks.push({
      id: newTrackId,
      name: mainTrack?.name || `V${order + 1}`,
      type: mainTrack?.type || "video",
      order: order++,
      locked: false,
      visible: true,
      solo: false,
      clips: clips.map((c) => ({
        ...JSON.parse(JSON.stringify(c)),
        id: newId(),
        trackId: newTrackId,
        startTime: Math.max(0, c.startTime - t0),
      })),
    });
  }

  // Map old clip ids → new for transitions that stay inside the set
  const clipIdMap = new Map<string, string>();
  for (const t of seqTracks) {
    // Remap was done with new ids — rebuild from selected order
  }
  // Rebuild clipIdMap properly
  {
    const selectedSorted = [...selected].sort(
      (a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id)
    );
    const newClipsFlat = seqTracks
      .flatMap((t) => t.clips)
      .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    // Match by track mapping + relative start
    for (const old of selectedSorted) {
      const newTrackId = trackIdMap.get(old.trackId)!;
      const rel = Math.max(0, old.startTime - t0);
      const match = seqTracks
        .find((t) => t.id === newTrackId)!
        .clips.find(
          (c) =>
            Math.abs(c.startTime - rel) < 0.02 &&
            Math.abs(c.duration - old.duration) < 0.02 &&
            ! [...clipIdMap.values()].includes(c.id)
        );
      if (match) clipIdMap.set(old.id, match.id);
    }
    void newClipsFlat;
  }

  const seqTransitions: Transition[] = [];
  for (const tr of transitions) {
    if (idSet.has(tr.clipAId) && idSet.has(tr.clipBId)) {
      const a = clipIdMap.get(tr.clipAId);
      const b = clipIdMap.get(tr.clipBId);
      const trackId = trackIdMap.get(tr.trackId);
      if (a && b && trackId) {
        seqTransitions.push({
          ...tr,
          id: newId(),
          trackId,
          clipAId: a,
          clipBId: b,
        });
      }
    }
  }

  const sequence: Sequence = {
    id: newId(),
    name: name || "Sequence",
    tracks: seqTracks,
    transitions: seqTransitions,
    durationHint: duration,
  };

  // Place nest on first non-audio selected clip's track at t0
  const hostClip =
    selected.find((c) => {
      const t = tracks.find((tr) => tr.id === c.trackId);
      return t && t.type !== "audio";
    }) || null;
  if (!hostClip) {
    return {
      ok: false,
      message:
        "Select at least one clip on a video/text/shape track to place the nest (video-only nest in v1)",
    };
  }
  const hostTrackId = hostClip.trackId;
  const nestClipId = newId();
  const nestClip: Clip = {
    id: nestClipId,
    trackId: hostTrackId,
    sourceMediaId: null,
    sourceSequenceId: sequence.id,
    startTime: t0,
    duration,
    sourceOffset: 0,
    speed: 1,
    transform: { ...DEFAULT_TRANSFORM },
    opacity: 1,
    blendMode: "normal",
    effects: [],
    keyframes: [],
    mask: null,
    muted: true,
    volume: 0,
  };

  const nextTracks = tracks.map((t) => ({
    ...t,
    clips: [
      ...t.clips.filter((c) => !idSet.has(c.id)),
      ...(t.id === hostTrackId ? [nestClip] : []),
    ],
  }));

  const nextTx = transitions.filter(
    (tr) => !idSet.has(tr.clipAId) && !idSet.has(tr.clipBId)
  );

  return {
    ok: true,
    tracks: nextTracks,
    transitions: nextTx,
    sequences: [...sequences, sequence],
    sequenceId: sequence.id,
    nestClipId,
  };
}

export function placeSequenceClip(
  tracks: Track[],
  sequenceId: string,
  trackId: string,
  startTime: number,
  duration: number,
  sequences: Sequence[]
): SequenceOpResult<{ tracks: Track[]; clipId: string }> {
  const seq = sequences.find((s) => s.id === sequenceId);
  if (!seq) return { ok: false, message: `Sequence ${sequenceId} not found` };
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return { ok: false, message: `Track ${trackId} not found` };
  if (track.type === "audio") {
    return { ok: false, message: "Place sequence clips on video/text/shape tracks (video-only nest in v1)" };
  }

  const dur =
    Number.isFinite(duration) && duration > EPS
      ? duration
      : Math.max(EPS, seq.durationHint || sequenceContentEnd(seq) || 5);

  const clipId = newId();
  const nestClip: Clip = {
    id: clipId,
    trackId,
    sourceMediaId: null,
    sourceSequenceId: sequenceId,
    startTime: Math.max(0, startTime),
    duration: dur,
    sourceOffset: 0,
    speed: 1,
    transform: { ...DEFAULT_TRANSFORM },
    opacity: 1,
    blendMode: "normal",
    effects: [],
    keyframes: [],
    mask: null,
    muted: true,
    volume: 0,
  };

  const nextTracks = tracks.map((t) =>
    t.id === trackId ? { ...t, clips: [...t.clips, nestClip] } : t
  );
  return { ok: true, tracks: nextTracks, clipId };
}

export function deleteSequence(
  sequences: Sequence[],
  tracks: Track[],
  sequenceId: string
): SequenceOpResult<{ sequences: Sequence[] }> {
  if (!sequences.some((s) => s.id === sequenceId)) {
    return { ok: false, message: `Sequence ${sequenceId} not found` };
  }
  const used = countRefs(tracks, sequenceId);
  if (used > 0) {
    return {
      ok: false,
      message: `Sequence is used ${used} time(s) on the main timeline — remove nest clips first`,
    };
  }
  // Also check other sequences (depth-1 should have none, but be safe)
  for (const s of sequences) {
    if (s.id === sequenceId) continue;
    if (countRefs(s.tracks, sequenceId) > 0) {
      return {
        ok: false,
        message: "Sequence is referenced inside another sequence",
      };
    }
  }
  return {
    ok: true,
    sequences: sequences.filter((s) => s.id !== sequenceId),
  };
}

export function renameSequence(
  sequences: Sequence[],
  sequenceId: string,
  name: string
): SequenceOpResult<{ sequences: Sequence[] }> {
  const n = String(name || "").trim();
  if (!n) return { ok: false, message: "Name is required" };
  if (!sequences.some((s) => s.id === sequenceId)) {
    return { ok: false, message: `Sequence ${sequenceId} not found` };
  }
  return {
    ok: true,
    sequences: sequences.map((s) =>
      s.id === sequenceId ? { ...s, name: n } : s
    ),
  };
}

function validateClipContent(
  clip: Clip,
  track: Track,
  seqMap: Map<string, Sequence>,
  insideSequence: boolean,
  issues: TimelineValidationIssue[]
): void {
  const nest = isNestClip(clip);
  if (nest) {
    if (insideSequence) {
      issues.push({
        severity: "error",
        code: "nested_depth",
        message: `clip ${clip.id} nests a sequence inside a sequence (depth > 1)`,
        trackId: track.id,
        clipId: clip.id,
      });
    }
    if (clip.sourceMediaId) {
      issues.push({
        severity: "error",
        code: "nest_xor_media",
        message: `nest clip ${clip.id} must have sourceMediaId null`,
        trackId: track.id,
        clipId: clip.id,
      });
    }
    if (clip.textParams || clip.shapeParams) {
      issues.push({
        severity: "error",
        code: "nest_xor_content",
        message: `nest clip ${clip.id} must not have text/shape params`,
        trackId: track.id,
        clipId: clip.id,
      });
    }
    if (!seqMap.has(String(clip.sourceSequenceId))) {
      issues.push({
        severity: "error",
        code: "missing_sequence",
        message: `clip ${clip.id} references missing sequence ${clip.sourceSequenceId}`,
        trackId: track.id,
        clipId: clip.id,
      });
    }
  }
}

/**
 * Validate sequence library + nest clip XOR / depth / refs.
 */
export function validateSequences(input: {
  tracks: readonly Track[];
  transitions?: readonly Transition[];
  sequences?: readonly Sequence[];
}): TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = [];
  const sequences = input.sequences || [];
  const seqMap = new Map(sequences.map((s) => [s.id, s]));

  const ids = new Set<string>();
  for (const s of sequences) {
    if (ids.has(s.id)) {
      issues.push({
        severity: "error",
        code: "duplicate_sequence",
        message: `duplicate sequence id ${s.id}`,
      });
    }
    ids.add(s.id);
    for (const t of s.tracks || []) {
      for (const c of t.clips || []) {
        validateClipContent(c, t, seqMap, true, issues);
      }
    }
  }

  for (const t of input.tracks) {
    for (const c of t.clips || []) {
      validateClipContent(c, t, seqMap, false, issues);
      // Soften missing_media for nest clips — handled above
    }
  }

  return issues;
}

/** True if any nest clip exists on main tracks. */
export function hasNestClips(tracks: readonly Track[]): boolean {
  for (const t of tracks) {
    for (const c of t.clips || []) {
      if (isNestClip(c)) return true;
    }
  }
  return false;
}
