import { create } from "zustand";
import { temporal } from "zundo";
import { toast } from "sonner";
import {
  getClipSourceRange,
  mapSourceIntervalToTimeline,
  applyTransition,
  removeTransition,
  updateTransitionDuration,
  pruneInvalidTransitions,
  removeMatchingTransitions,
  closeGapOnTrack,
  rippleDeleteClip,
  rippleTrimClip as applyRippleTrim,
  replaceClipMedia as applyReplaceClipMedia,
  isNestClip,
  createAdjustmentLayer,
  setEffectEnabled as applyEffectEnabled,
  reorderClipEffects as applyEffectReorder,
  applyClipAttributes as applySharedClipAttributes,
  setClipParent as applyClipParent,
  setClipTrackMatte as applyClipTrackMatte,
  normalizeSpeedRamp,
  linkClips as applyLinkClips,
  unlinkClips as applyUnlinkClips,
  rippleDeleteLinkedGroup,
  type ReplaceFit,
  type ClipAttributeScope,
  sourceEdit as applySourceEdit,
} from "@tempo/editor-core";
import type {
  Track,
  Clip,
  TrackType,
  Transform,
  Keyframe,
  EasingType,
  Effect,
  TextParams,
  ShapeParams,
  Transition,
  SpeedRampPoint,
  ChromaKey,
  EffectParamValue,
  TrackMatte,
} from "@tempo/types";

interface TimelineState {
  tracks: Track[];
  transitions: Transition[];

  addTrack: (name: string, type: TrackType) => string;
  addAdjustmentLayer: (duration: number, startTime?: number, name?: string) => string;
  addNullLayer: (duration: number, startTime?: number, name?: string) => string;
  removeTrack: (trackId: string) => void;
  reorderTrack: (trackId: string, newOrder: number) => void;
  toggleLock: (trackId: string) => void;
  toggleVisible: (trackId: string) => void;
  toggleSolo: (trackId: string) => void;
  addClip: (trackId: string, clip: Omit<Clip, "id" | "trackId">) => string;
  sourceEdit: (trackId: string, clip: Omit<Clip, "id" | "trackId">, mode: "insert" | "overwrite") => { ok: true; clipId: string } | { ok: false; message: string };
  removeClip: (clipId: string) => void;
  linkClips: (clipIds: string[]) => { ok: true } | { ok: false; message: string };
  unlinkClipGroup: (clipId: string) => { ok: true } | { ok: false; message: string };
  rippleRemoveLinkedGroup: (clipId: string) => { ok: true } | { ok: false; message: string };
  rippleRemoveClip: (clipId: string) => { ok: true } | { ok: false; message: string };
  closeGap: (
    trackId: string,
    atTime?: number
  ) => { ok: true } | { ok: false; message: string };
  rippleTrimClip: (
    clipId: string,
    startTime: number,
    duration: number
  ) => { ok: true } | { ok: false; message: string };
  replaceClipMedia: (
    clipId: string,
    sourceMediaId: string,
    opts?: {
      sourceOffset?: number;
      mediaDurationSec?: number;
      fit?: ReplaceFit;
    }
  ) => { ok: true } | { ok: false; message: string };
  moveClip: (clipId: string, toTrackId: string, newStartTime: number) => void;
  trimClip: (clipId: string, startTime: number, duration: number) => void;
  splitClip: (clipId: string, time: number) => string | null;
  duplicateClip: (clipId: string) => string | null;
  updateClipProperty: (clipId: string, property: string, value: unknown) => void;
  setSpeedRamp: (clipId: string, points: SpeedRampPoint[] | null, reversed?: boolean) => void;
  setClipChromaKey: (clipId: string, chromaKey: ChromaKey | null) => void;
  setClipParent: (clipId: string, parentId: string | null) => { ok: true } | { ok: false; message: string };
  setClipTrackMatte: (clipId: string, trackMatte: TrackMatte | null) => { ok: true } | { ok: false; message: string };
  addKeyframe: (clipId: string, property: string, time: number, value: number | string | boolean, easing?: EasingType) => void;
  removeKeyframe: (clipId: string, keyframeId: string) => void;
  updateKeyframe: (clipId: string, keyframeId: string, updates: Partial<Keyframe>) => void;
  addEffectKeyframe: (
    clipId: string,
    effectId: string,
    property: string,
    time: number,
    value: number | string | boolean,
    easing?: EasingType
  ) => void;
  removeEffectKeyframe: (clipId: string, effectId: string, keyframeId: string) => void;
  updateEffectKeyframe: (
    clipId: string,
    effectId: string,
    keyframeId: string,
    updates: Partial<Keyframe>
  ) => void;
  addEffect: (clipId: string, effect: Omit<Effect, "id">) => string;
  removeEffect: (clipId: string, effectId: string) => void;
  setEffectEnabled: (clipId: string, effectId: string, enabled: boolean) => void;
  updateEffectParam: (clipId: string, effectId: string, paramName: string, value: EffectParamValue) => void;
  reorderEffects: (clipId: string, effectIds: string[]) => void;
  copyClipAttributes: (
    sourceClipId: string,
    targetClipIds: string[],
    scopes: ClipAttributeScope[],
    replaceEffects?: boolean
  ) => { ok: true } | { ok: false; message: string };
  updateClipTextParams: (clipId: string, params: Partial<TextParams>) => void;
  updateClipShapeParams: (clipId: string, params: Partial<ShapeParams>) => void;
  addTransition: (
    input: {
      trackId: string;
      clipAId: string;
      clipBId: string;
      type: string;
      duration: number;
      params?: Record<string, number | string | boolean>;
    },
    mediaDurations: Record<string, number>
  ) => { ok: true; transitionId: string } | { ok: false; message: string };
  updateTransition: (
    transitionId: string,
    duration: number,
    mediaDurations: Record<string, number>
  ) => { ok: true } | { ok: false; message: string };
  setTransitionParams: (
    transitionId: string,
    params: Record<string, number | string | boolean>
  ) => void;
  removeTransitionById: (transitionId: string) => void;
  setTracks: (tracks: Track[]) => void;
  setTransitions: (transitions: Transition[]) => void;
  setTimeline: (tracks: Track[], transitions: Transition[]) => void;
  reset: () => void;
}

function generateId(): string {
  return crypto.randomUUID();
}

function findClipInTracks(tracks: Track[], clipId: string): { track: Track; clip: Clip } | null {
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

function syncCaptionToSource(caption: Clip, sourceClip: Clip): Clip {
  const binding = caption.captionBinding;
  if (!binding || binding.sourceClipId !== sourceClip.id) return caption;

  const mapped = mapSourceIntervalToTimeline(sourceClip, [binding.sourceStart, binding.sourceEnd]);
  if (!mapped) {
    return { ...caption, captionBinding: { ...binding, stale: true } };
  }

  const intentionalOffset = (binding.intentionalOffsetMs || 0) / 1000;
  const sourceEnd = sourceClip.sourceOffset + sourceClip.duration * sourceClip.speed;
  const clippedByEdit =
    (mapped[0] <= sourceClip.startTime && binding.sourceStart < sourceClip.sourceOffset) ||
    (mapped[1] >= sourceClip.startTime + sourceClip.duration && binding.sourceEnd > sourceEnd);
  return {
    ...caption,
    startTime: mapped[0] + intentionalOffset,
    duration: mapped[1] - mapped[0],
    captionBinding: { ...binding, stale: clippedByEdit },
  };
}

function syncCaptionsBoundToClip(tracks: Track[], sourceClip: Clip): Track[] {
  return tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => syncCaptionToSource(clip, sourceClip)),
  }));
}

function syncCaptionsBoundToSources(tracks: Track[], sourceClips: Clip[]): Track[] {
  return sourceClips.reduce(
    (next, source) => (source.sourceMediaId ? syncCaptionsBoundToClip(next, source) : next),
    tracks
  );
}

function markCaptionsForMissingSourcesStale(tracks: Track[], sourceClipIds: Set<string>): Track[] {
  return tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      const binding = clip.captionBinding;
      return binding && sourceClipIds.has(binding.sourceClipId)
        ? { ...clip, captionBinding: { ...binding, stale: true } }
        : clip;
    }),
  }));
}

function rebindCaptionsAfterSplit(tracks: Track[], firstClip: Clip, secondClip: Clip): Track[] {
  const firstRange = getClipSourceRange(firstClip);
  const secondRange = getClipSourceRange(secondClip);
  const rebound = tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      const binding = clip.captionBinding;
      if (!binding || binding.sourceClipId !== firstClip.id) return clip;

      const inFirst = binding.sourceStart >= firstRange[0] && binding.sourceEnd <= firstRange[1];
      const inSecond = binding.sourceStart >= secondRange[0] && binding.sourceEnd <= secondRange[1];
      if (inFirst) return clip;
      if (inSecond) {
        return {
          ...clip,
          captionBinding: { ...binding, sourceClipId: secondClip.id },
        };
      }
      return { ...clip, captionBinding: { ...binding, stale: true } };
    }),
  }));

  return syncCaptionsBoundToClip(
    syncCaptionsBoundToClip(rebound, firstClip),
    secondClip
  );
}

export const useTimelineStore = create<TimelineState>()(
  temporal(
    (set, get) => ({
      tracks: [],
      transitions: [],

      addTrack: (name, type) => {
        const id = generateId();
        set((state) => ({
          tracks: [
            ...state.tracks,
            {
              id,
              name,
              type,
              order: state.tracks.length,
              locked: false,
              visible: true,
              solo: false,
              clips: [],
            },
          ],
        }));
        return id;
      },

      sourceEdit: (trackId, incoming, mode) => {
        const state = get();
        const result = applySourceEdit(state.tracks, state.transitions, trackId, incoming, mode, generateId);
        if (!result.ok) return { ok: false, message: result.message };
        let tracks = result.tracks;
        for (const pair of result.metadata.splitPairs) {
          const first = findClipInTracks(tracks, pair.firstClipId)?.clip;
          const second = findClipInTracks(tracks, pair.secondClipId)?.clip;
          if (first && second) tracks = rebindCaptionsAfterSplit(tracks, first, second);
        }
        tracks = markCaptionsForMissingSourcesStale(tracks, new Set(result.metadata.removedClipIds));
        const changed = result.metadata.changedClipIds
          .map((clipId) => findClipInTracks(tracks, clipId)?.clip)
          .filter((clip): clip is Clip => Boolean(clip?.sourceMediaId));
        tracks = syncCaptionsBoundToSources(tracks, changed);
        set({ tracks, transitions: result.transitions });
        return { ok: true, clipId: result.metadata.insertedClipId };
      },

      addAdjustmentLayer: (duration, startTime = 0, name) => {
        const trackId = generateId();
        const clipId = generateId();
        const result = createAdjustmentLayer({
          tracks: get().tracks,
          trackId,
          clipId,
          name,
          startTime,
          duration,
        });
        if (!result.ok) {
          toast.error(result.message);
          return "";
        }
        set({ tracks: result.tracks });
        return result.clipId;
      },

      addNullLayer: (duration, startTime = 0, name) => {
        const trackId = generateId();
        const clipId = generateId();
        set((state) => ({
          tracks: [
            ...state.tracks,
            {
              id: trackId,
              name: name || `Null ${state.tracks.filter((track) => track.type === "null").length + 1}`,
              type: "null",
              order: state.tracks.length,
              locked: false,
              visible: true,
              solo: false,
              clips: [{
                id: clipId,
                trackId,
                sourceMediaId: null,
                startTime: Math.max(0, startTime),
                duration: Math.max(0.1, duration),
                sourceOffset: 0,
                speed: 1,
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
                opacity: 1,
                blendMode: "normal",
                effects: [],
                keyframes: [],
                mask: null,
                muted: true,
                volume: 0,
                nullLayer: true,
              }],
            },
          ],
        }));
        return clipId;
      },

      removeTrack: (trackId) =>
        set((state) => {
          const removedTrack = state.tracks.find((t) => t.id === trackId);
          const removedClipIds = new Set(removedTrack?.clips.map((c) => c.id) || []);
          const cleared = removeMatchingTransitions(
            state.tracks,
            state.transitions,
            (tr) => tr.trackId === trackId
          );
          const tracks = cleared.tracks
            .filter((t) => t.id !== trackId)
            .map((t, i) => ({ ...t, order: i }));
          return {
            tracks: markCaptionsForMissingSourcesStale(tracks, removedClipIds),
            transitions: cleared.transitions,
          };
        }),

      reorderTrack: (trackId, newOrder) =>
        set((state) => {
          const tracks = [...state.tracks];
          const idx = tracks.findIndex((t) => t.id === trackId);
          if (idx === -1) return state;
          const [track] = tracks.splice(idx, 1);
          tracks.splice(newOrder, 0, track!);
          return { tracks: tracks.map((t, i) => ({ ...t, order: i })) };
        }),

      toggleLock: (trackId) =>
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.id === trackId ? { ...t, locked: !t.locked } : t
          ),
        })),

      toggleVisible: (trackId) =>
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.id === trackId ? { ...t, visible: !t.visible } : t
          ),
        })),

      toggleSolo: (trackId) =>
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.id === trackId ? { ...t, solo: !t.solo } : t
          ),
        })),

      addClip: (trackId, clipData) => {
        const track = get().tracks.find((t) => t.id === trackId);
        if (!track) return "";
        if (track.type === "adjustment") {
          toast.error("Create adjustment layers from the Layers panel");
          return "";
        }
        if (track.type === "audio" && isNestClip(clipData as Clip)) {
          toast.error(
            "Place sequence clips on video/text/shape tracks (video-only nest in v1)"
          );
          return "";
        }
        const id = generateId();
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.id === trackId
              ? { ...t, clips: [...t.clips, { ...clipData, id, trackId }] }
              : t
          ),
        }));
        return id;
      },

      removeClip: (clipId) =>
        set((state) => {
          const selected = findClipInTracks(state.tracks, clipId)?.clip;
          const removedIds = new Set(
            selected?.linkGroupId
              ? state.tracks.flatMap((track) => track.clips).filter((clip) => clip.linkGroupId === selected.linkGroupId).map((clip) => clip.id)
              : [clipId]
          );
          const cleared = removeMatchingTransitions(
            state.tracks,
            state.transitions,
            (tr) => removedIds.has(tr.clipAId) || removedIds.has(tr.clipBId)
          );
          const tracks = cleared.tracks.map((t) => ({
            ...t,
            clips: t.clips.filter((c) => !removedIds.has(c.id)),
          }));
          return {
            tracks: markCaptionsForMissingSourcesStale(tracks, removedIds),
            transitions: pruneInvalidTransitions(tracks, cleared.transitions),
          };
        }),

      linkClips: (clipIds) => {
        const result = applyLinkClips(get().tracks, clipIds, generateId());
        if (!result.ok) return { ok: false, message: result.message };
        set({ tracks: result.tracks });
        return { ok: true };
      },

      unlinkClipGroup: (clipId) => {
        const found = findClipInTracks(get().tracks, clipId)?.clip;
        if (!found?.linkGroupId) return { ok: false, message: "Selected clip is not linked" };
        const ids = get().tracks.flatMap((track) => track.clips).filter((clip) => clip.linkGroupId === found.linkGroupId).map((clip) => clip.id);
        const result = applyUnlinkClips(get().tracks, ids);
        if (!result.ok) return { ok: false, message: result.message };
        set({ tracks: result.tracks });
        return { ok: true };
      },

      rippleRemoveLinkedGroup: (clipId) => {
        const result = rippleDeleteLinkedGroup(get().tracks, get().transitions, clipId);
        if (!result.ok) return { ok: false, message: result.message };
        const ids = new Set(get().tracks.flatMap((track) => track.clips).filter((clip) => clip.linkGroupId === findClipInTracks(get().tracks, clipId)?.clip.linkGroupId).map((clip) => clip.id));
        set({ tracks: markCaptionsForMissingSourcesStale(result.tracks, ids), transitions: result.transitions });
        return { ok: true };
      },

      rippleRemoveClip: (clipId) => {
        const state = get();
        if (findClipInTracks(state.tracks, clipId)?.clip.linkGroupId) {
          return get().rippleRemoveLinkedGroup(clipId);
        }
        const before = findClipInTracks(state.tracks, clipId);
        const trackId = before?.track.id;
        const result = rippleDeleteClip(state.tracks, state.transitions, clipId);
        if (!result.ok) return { ok: false, message: result.message };
        let tracks = markCaptionsForMissingSourcesStale(
          result.tracks,
          new Set([clipId])
        );
        // Re-sync captions bound to neighbors that shifted left.
        if (trackId) {
          const track = tracks.find((t) => t.id === trackId);
          if (track) {
            for (const c of track.clips) {
              if (c.sourceMediaId) tracks = syncCaptionsBoundToClip(tracks, c);
            }
          }
        }
        set({
          tracks,
          transitions: result.transitions,
        });
        return { ok: true };
      },

      closeGap: (trackId, atTime) => {
        const state = get();
        const result = closeGapOnTrack(
          state.tracks,
          state.transitions,
          trackId,
          atTime
        );
        if (!result.ok) return { ok: false, message: result.message };
        let tracks = result.tracks;
        const track = tracks.find((t) => t.id === trackId);
        if (track) {
          for (const c of track.clips) {
            if (c.sourceMediaId) tracks = syncCaptionsBoundToClip(tracks, c);
          }
        }
        set({ tracks, transitions: result.transitions });
        return { ok: true };
      },

      rippleTrimClip: (clipId, startTime, duration) => {
        const state = get();
        const before = findClipInTracks(state.tracks, clipId);
        const trackId = before?.track.id;
        const result = applyRippleTrim(state.tracks, state.transitions, clipId, {
          startTime,
          duration,
        });
        if (!result.ok) return { ok: false, message: result.message };
        let tracks = result.tracks;
        if (trackId) {
          const track = tracks.find((t) => t.id === trackId);
          if (track) {
            for (const c of track.clips) {
              if (c.sourceMediaId) tracks = syncCaptionsBoundToClip(tracks, c);
            }
          }
        }
        set({
          tracks,
          transitions: result.transitions,
        });
        return { ok: true };
      },

      replaceClipMedia: (clipId, sourceMediaId, opts) => {
        const state = get();
        const result = applyReplaceClipMedia(state.tracks, state.transitions, clipId, {
          sourceMediaId,
          sourceOffset: opts?.sourceOffset,
          mediaDurationSec: opts?.mediaDurationSec,
          fit: opts?.fit,
        });
        if (!result.ok) return { ok: false, message: result.message };
        const found = findClipInTracks(result.tracks, clipId);
        set({
          tracks: found
            ? syncCaptionsBoundToClip(result.tracks, found.clip)
            : result.tracks,
          transitions: result.transitions,
        });
        return { ok: true };
      },

      moveClip: (clipId, toTrackId, newStartTime) =>
        set((state) => {
          const linked = findClipInTracks(state.tracks, clipId)?.clip;
          if (linked?.linkGroupId) {
            const group = state.tracks.flatMap((track) => track.clips).filter((candidate) => candidate.linkGroupId === linked.linkGroupId);
            const delta = Math.max(-Math.min(...group.map((candidate) => candidate.startTime)), newStartTime - linked.startTime);
            const tracks = state.tracks.map((candidate) => ({ ...candidate, clips: candidate.clips.map((item) => item.linkGroupId === linked.linkGroupId ? { ...item, startTime: item.startTime + delta } : item) }));
            const cleared = removeMatchingTransitions(
              tracks,
              state.transitions,
              (transition) => group.some((candidate) => candidate.id === transition.clipAId || candidate.id === transition.clipBId)
            );
            const movedGroup = cleared.tracks.flatMap((candidate) => candidate.clips).filter((candidate) => candidate.linkGroupId === linked.linkGroupId);
            return { tracks: syncCaptionsBoundToSources(cleared.tracks, movedGroup), transitions: cleared.transitions };
          }
          let clip: Clip | undefined;
          let sourceTrack: Track | undefined;
          const tracksWithout = state.tracks.map((t) => {
            const found = t.clips.find((c) => c.id === clipId);
            if (found) {
              sourceTrack = t;
              clip = { ...found, startTime: newStartTime, trackId: toTrackId };
            }
            return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
          });
          if (!clip) return state;
          const dest = state.tracks.find((t) => t.id === toTrackId);
          if (!dest) return state;
          if (dest.type === "adjustment" && sourceTrack?.type !== "adjustment") {
            toast.error("Media clips cannot be moved onto an adjustment track");
            return state;
          }
          if (sourceTrack?.type === "adjustment" && dest.type !== "adjustment") {
            toast.error("Adjustment clips must stay on an adjustment track");
            return state;
          }
          if (dest?.type === "audio" && isNestClip(clip)) {
            toast.error(
              "Place sequence clips on video/text/shape tracks (video-only nest in v1)"
            );
            return state;
          }
          const movedClip = clip;
          const tracks = tracksWithout.map((t) =>
            t.id === toTrackId ? { ...t, clips: [...t.clips, movedClip] } : t
          );
          const cleared = removeMatchingTransitions(
            tracks,
            state.transitions,
            (tr) => tr.clipAId === clipId || tr.clipBId === clipId
          );
          return {
            tracks: syncCaptionsBoundToClip(cleared.tracks, movedClip),
            transitions: cleared.transitions,
          };
        }),

      trimClip: (clipId, startTime, duration) =>
        set((state) => {
          const result = findClipInTracks(state.tracks, clipId);
          if (!result) return state;
          const { clip } = result;
          if (clip.linkGroupId) {
            const group = state.tracks.flatMap((track) => track.clips).filter((candidate) => candidate.linkGroupId === clip.linkGroupId);
            const deltaStart = startTime - clip.startTime;
            if (group.some((candidate) => candidate.sourceMediaId && candidate.sourceOffset + deltaStart * (candidate.speed || 1) < -0.0001)) {
              toast.error("Linked trim would exceed a member's source in-point");
              return state;
            }
            const next = state.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((candidate) => candidate.linkGroupId === clip.linkGroupId
                ? { ...candidate, startTime, duration: Math.max(0.1, duration), sourceOffset: candidate.sourceMediaId ? Math.max(0, candidate.sourceOffset + deltaStart * (candidate.speed || 1)) : candidate.sourceOffset }
                : candidate),
            }));
            const cleared = removeMatchingTransitions(next, state.transitions, (tr) => group.some((candidate) => candidate.id === tr.clipAId || candidate.id === tr.clipBId));
            const movedGroup = cleared.tracks.flatMap((track) => track.clips).filter((candidate) => candidate.linkGroupId === clip.linkGroupId);
            return { tracks: syncCaptionsBoundToSources(cleared.tracks, movedGroup), transitions: cleared.transitions };
          }
          const sourceOffset = clip.sourceMediaId
            ? Math.max(0, clip.sourceOffset + (startTime - clip.startTime) * (clip.speed || 1))
            : clip.sourceOffset;
          const trimmedClip = { ...clip, startTime, duration, sourceOffset };
          const tracks = state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => (c.id === clipId ? trimmedClip : c)),
          }));
          // Drop transitions involving this clip (geometry changed) with reverse steal
          const cleared = removeMatchingTransitions(
            tracks,
            state.transitions,
            (tr) => tr.clipAId === clipId || tr.clipBId === clipId
          );
          return {
            tracks: syncCaptionsBoundToClip(cleared.tracks, trimmedClip),
            transitions: cleared.transitions,
          };
        }),

      splitClip: (clipId, time) => {
        let newId: string | null = null;
        set((state) => {
          const result = findClipInTracks(state.tracks, clipId);
          if (!result) return state;
          const { clip } = result;

          if (clip.linkGroupId) {
            const group = state.tracks.flatMap((track) => track.clips).filter((candidate) => candidate.linkGroupId === clip.linkGroupId);
            if (group.some((candidate) => time <= candidate.startTime || time >= candidate.startTime + candidate.duration)) return state;
            const rightGroupId = generateId();
            const secondIds = new Map(group.map((candidate) => [candidate.id, generateId()]));
            newId = secondIds.get(clipId)!;
            const tracks = state.tracks.map((track) => ({
              ...track,
              clips: track.clips.flatMap((candidate) => {
                if (candidate.linkGroupId !== clip.linkGroupId) return [candidate];
                const firstDuration = time - candidate.startTime;
                return [
                  { ...candidate, duration: firstDuration },
                  { ...candidate, id: secondIds.get(candidate.id)!, linkGroupId: rightGroupId, startTime: time, duration: candidate.duration - firstDuration, sourceOffset: candidate.sourceOffset + firstDuration * (candidate.speed || 1) },
                ];
              }),
            }));
            const cleared = removeMatchingTransitions(tracks, state.transitions, (tr) => group.some((candidate) => candidate.id === tr.clipAId || candidate.id === tr.clipBId));
            let rebound = cleared.tracks;
            for (const original of group) {
              const first = findClipInTracks(rebound, original.id)?.clip;
              const secondId = secondIds.get(original.id);
              const second = secondId ? findClipInTracks(rebound, secondId)?.clip : null;
              if (first && second) rebound = rebindCaptionsAfterSplit(rebound, first, second);
            }
            return { tracks: rebound, transitions: cleared.transitions };
          }

          const clipEnd = clip.startTime + clip.duration;
          if (time <= clip.startTime || time >= clipEnd) return state;

          const firstDuration = time - clip.startTime;
          const secondDuration = clipEnd - time;
          newId = generateId();

          const first: Clip = { ...clip, duration: firstDuration };
          const second: Clip = {
            ...clip,
            id: newId,
            startTime: time,
            duration: secondDuration,
            sourceOffset: clip.sourceOffset + firstDuration * (clip.speed || 1),
          };
          const tracks = state.tracks.map((t) => ({
            ...t,
            clips: t.clips.flatMap((c) => (c.id === clipId ? [first, second] : [c])),
          }));
          const cleared = removeMatchingTransitions(
            tracks,
            state.transitions,
            (tr) => tr.clipAId === clipId || tr.clipBId === clipId
          );
          return {
            tracks: rebindCaptionsAfterSplit(cleared.tracks, first, second),
            transitions: cleared.transitions,
          };
        });
        return newId;
      },

      duplicateClip: (clipId) => {
        let newId: string | null = null;
        set((state) => {
          const result = findClipInTracks(state.tracks, clipId);
          if (!result) return state;
          const { clip } = result;

          newId = generateId();
          const duplicate: Clip = {
            ...clip,
            id: newId,
            startTime: clip.startTime + clip.duration + 0.1,
            effects: clip.effects.map((e) => ({
              ...e,
              id: generateId(),
              params: { ...e.params },
              keyframes: (e.keyframes || []).map((k) => ({ ...k, id: generateId() })),
            })),
            keyframes: clip.keyframes.map((k) => ({ ...k, id: generateId() })),
            textParams: clip.textParams ? { ...clip.textParams } : undefined,
            shapeParams: clip.shapeParams ? { ...clip.shapeParams } : undefined,
            transform: { ...clip.transform },
          };

          return {
            tracks: state.tracks.map((t) =>
              t.id === clip.trackId ? { ...t, clips: [...t.clips, duplicate] } : t
            ),
          };
        });
        return newId;
      },

      updateClipProperty: (clipId, property, value) =>
        set((state) => {
          const result = findClipInTracks(state.tracks, clipId);
          if (!result) return state;
          const { clip } = result;
          let updatedClip: Clip;
          if (property.startsWith("transform.")) {
            updatedClip = {
              ...clip,
              transform: {
                ...clip.transform,
                [property.replace("transform.", "") as keyof Transform]: value,
              },
            };
          } else if (property === "speed") {
            const speed = Number(value);
            if (!Number.isFinite(speed) || speed === 0) return state;
            updatedClip = {
              ...clip,
              speed: Math.abs(speed),
              reversed: speed < 0,
              speedRamp: null,
            };
          } else if (property === "reversed") {
            updatedClip = { ...clip, reversed: Boolean(value) };
          } else {
            updatedClip = { ...clip, [property]: value };
          }
          const tracks = state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => (c.id === clipId ? updatedClip : c)),
          }));
          return {
            tracks:
              property === "speed" || property === "reversed" || property === "speedRamp"
                ? syncCaptionsBoundToClip(tracks, updatedClip)
                : tracks,
          };
        }),

      setSpeedRamp: (clipId, points, reversed) =>
        set((state) => {
          const result = findClipInTracks(state.tracks, clipId);
          if (!result) return state;
          const updatedClip: Clip = {
            ...result.clip,
            speedRamp: normalizeSpeedRamp(points, result.clip.duration),
            reversed:
              reversed !== undefined ? reversed : Boolean(result.clip.reversed),
            speed: Math.abs(result.clip.speed) || 1,
          };
          const tracks = state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => (c.id === clipId ? updatedClip : c)),
          }));
          return { tracks: syncCaptionsBoundToClip(tracks, updatedClip) };
        }),

      setClipChromaKey: (clipId, chromaKey) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id === clipId ? { ...c, chromaKey } : c
            ),
          })),
        })),

      setClipParent: (clipId, parentId) => {
        const result = applyClipParent(get().tracks, clipId, parentId);
        if (!result.ok) return result;
        set({ tracks: result.tracks });
        return { ok: true };
      },

      setClipTrackMatte: (clipId, trackMatte) => {
        const result = applyClipTrackMatte(get().tracks, clipId, trackMatte);
        if (!result.ok) return result;
        set({ tracks: result.tracks });
        return { ok: true };
      },

      addKeyframe: (clipId, property, time, value, easing = "linear") =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              if (c.id !== clipId) return c;
              const existing = c.keyframes.findIndex(
                (k) => k.property === property && Math.abs(k.time - time) < 0.001
              );
              if (existing >= 0) {
                const updated = [...c.keyframes];
                updated[existing] = { ...updated[existing]!, value, easing };
                return { ...c, keyframes: updated };
              }
              return {
                ...c,
                keyframes: [
                  ...c.keyframes,
                  { id: generateId(), property, time, value, easing },
                ],
              };
            }),
          })),
        })),

      removeKeyframe: (clipId, keyframeId) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id === clipId
                ? { ...c, keyframes: c.keyframes.filter((k) => k.id !== keyframeId) }
                : c
            ),
          })),
        })),

      updateKeyframe: (clipId, keyframeId, updates) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id === clipId
                ? {
                    ...c,
                    keyframes: c.keyframes.map((k) =>
                      k.id === keyframeId ? { ...k, ...updates } : k
                    ),
                  }
                : c
            ),
          })),
        })),

      addEffectKeyframe: (clipId, effectId, property, time, value, easing = "linear") =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              if (c.id !== clipId) return c;
              return {
                ...c,
                effects: c.effects.map((e) => {
                  if (e.id !== effectId) return e;
                  const kfs = e.keyframes || [];
                  const existing = kfs.findIndex(
                    (k) => k.property === property && Math.abs(k.time - time) < 0.001
                  );
                  if (existing >= 0) {
                    const updated = [...kfs];
                    updated[existing] = { ...updated[existing]!, value, easing };
                    return { ...e, keyframes: updated };
                  }
                  return {
                    ...e,
                    keyframes: [
                      ...kfs,
                      { id: generateId(), property, time, value, easing },
                    ],
                  };
                }),
              };
            }),
          })),
        })),

      removeEffectKeyframe: (clipId, effectId, keyframeId) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id === clipId
                ? {
                    ...c,
                    effects: c.effects.map((e) =>
                      e.id === effectId
                        ? {
                            ...e,
                            keyframes: (e.keyframes || []).filter(
                              (k) => k.id !== keyframeId
                            ),
                          }
                        : e
                    ),
                  }
                : c
            ),
          })),
        })),

      updateEffectKeyframe: (clipId, effectId, keyframeId, updates) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id === clipId
                ? {
                    ...c,
                    effects: c.effects.map((e) =>
                      e.id === effectId
                        ? {
                            ...e,
                            keyframes: (e.keyframes || []).map((k) =>
                              k.id === keyframeId ? { ...k, ...updates } : k
                            ),
                          }
                        : e
                    ),
                  }
                : c
            ),
          })),
        })),

      addEffect: (clipId, effectData) => {
        const id = generateId();
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id === clipId
                ? { ...c, effects: [...c.effects, { ...effectData, id }] }
                : c
            ),
          })),
        }));
        return id;
      },

      removeEffect: (clipId, effectId) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id === clipId
                ? { ...c, effects: c.effects.filter((e) => e.id !== effectId) }
                : c
            ),
          })),
        })),

      setEffectEnabled: (clipId, effectId, enabled) =>
        set((state) => {
          const result = applyEffectEnabled(state.tracks, clipId, effectId, enabled);
          return "ok" in result ? {} : { tracks: result.tracks };
        }),

      updateEffectParam: (clipId, effectId, paramName, value) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id === clipId
                ? {
                    ...c,
                    effects: c.effects.map((e) =>
                      e.id === effectId
                        ? { ...e, params: { ...e.params, [paramName]: value } }
                        : e
                    ),
                  }
                : c
            ),
          })),
        })),

      reorderEffects: (clipId, effectIds) =>
        set((state) => {
          const result = applyEffectReorder(state.tracks, clipId, effectIds);
          return "ok" in result ? {} : { tracks: result.tracks };
        }),

      copyClipAttributes: (sourceClipId, targetClipIds, scopes, replaceEffects = true) => {
        const result = applySharedClipAttributes(
          get().tracks,
          { sourceClipId, targetClipIds, scopes, replaceEffects },
          generateId
        );
        if ("ok" in result) return { ok: false, message: result.message };
        set({ tracks: result.tracks });
        return { ok: true };
      },

      updateClipTextParams: (clipId, params) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id !== clipId
                ? c
                : {
                    ...c,
                    textParams: { ...c.textParams!, ...params },
                  }
            ),
          })),
        })),

      updateClipShapeParams: (clipId, params) =>
        set((state) => ({
          tracks: state.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) =>
              c.id !== clipId
                ? c
                : {
                    ...c,
                    shapeParams: { ...c.shapeParams!, ...params },
                  }
            ),
          })),
        })),

      setTracks: (tracks) =>
        set((state) => ({
          tracks,
          transitions: pruneInvalidTransitions(tracks, state.transitions),
        })),

      setTransitions: (transitions) => set({ transitions }),

      setTimeline: (tracks, transitions) => set({ tracks, transitions }),

      addTransition: (input, mediaDurations) => {
        const state = get();
        const result = applyTransition(
          state.tracks,
          state.transitions,
          { ...input, id: generateId() },
          mediaDurations
        );
        if (!result.ok) {
          return { ok: false as const, message: result.message };
        }
        set({
          tracks: result.value.tracks,
          transitions: result.value.transitions,
        });
        return { ok: true as const, transitionId: result.value.transition.id };
      },

      updateTransition: (transitionId, duration, mediaDurations) => {
        const state = get();
        const result = updateTransitionDuration(
          state.tracks,
          state.transitions,
          transitionId,
          duration,
          mediaDurations
        );
        if (!result.ok) {
          return { ok: false as const, message: result.message };
        }
        set({
          tracks: result.value.tracks,
          transitions: result.value.transitions,
        });
        return { ok: true as const };
      },

      setTransitionParams: (transitionId, params) => {
        const state = get();
        set({
          transitions: state.transitions.map((t) =>
            t.id === transitionId
              ? { ...t, params: { ...t.params, ...params } }
              : t
          ),
        });
      },

      removeTransitionById: (transitionId) => {
        const state = get();
        const result = removeTransition(
          state.tracks,
          state.transitions,
          transitionId
        );
        if (!result.ok) return;
        set({
          tracks: result.value.tracks,
          transitions: result.value.transitions,
        });
      },

      reset: () => set({ tracks: [], transitions: [] }),
    }),
    {
      limit: 50,
      equality: (pastState, currentState) =>
        JSON.stringify(pastState.tracks) === JSON.stringify(currentState.tracks) &&
        JSON.stringify(pastState.transitions) ===
          JSON.stringify(currentState.transitions),
    }
  )
);
