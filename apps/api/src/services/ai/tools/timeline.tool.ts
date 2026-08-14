import type { Track, Clip, TrackType } from "@tempo/types";
import { randomUUID } from "crypto";
import {
  closeGapOnTrack,
  deleteClipLeaveGap,
  replaceClipMedia,
  rippleDeleteClip,
  rippleTrimClip,
  rollEdit,
  slideEdit,
  slipEdit,
  matchFrameTime,
  mediaAssetOrientation,
  orientationFromDimensions,
  orientationMatches,
  linkClips,
  unlinkClips,
  rippleDeleteLinkedGroup,
  removeMatchingTransitions,
  resolveThreePointEdit,
  sourceEdit,
  toolOk,
  toolErr,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";
import {
  markCaptionsForMissingSourceStale,
  rebindCaptionsAfterSplit,
  syncCaptionsBoundToClip,
} from "./caption-binding-sync.js";

function findClip(state: ProjectState, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

function isReferenceBound(clip: Clip): boolean {
  return clip.referenceEditBinding != null;
}

function isReferenceStructure(track: Track, clip: Clip): boolean {
  return isReferenceBound(clip) || /^Reference Layer\b/i.test(track.name || "");
}

function mediaDurationSec(state: ProjectState, mediaId: string): number | undefined {
  const asset = state.mediaAssets?.find((a) => a.id === mediaId);
  const d = asset?.duration ?? asset?.metadata?.duration;
  return typeof d === "number" && d > 0 ? d : undefined;
}

const DEFAULT_TRANSFORM = {
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0,
};

const TRACK_TYPES = new Set<TrackType>([
  "video", "audio", "text", "shape", "effect", "adjustment", "null",
]);

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function transitionsWithoutClips(state: ProjectState, clipIds: Set<string>) {
  const result = removeMatchingTransitions(
    state.tracks,
    state.transitions || [],
    (transition) => clipIds.has(transition.clipAId) || clipIds.has(transition.clipBId)
  );
  state.tracks = result.tracks;
  state.transitions = result.transitions;
}

export const timelineToolDefinitions = [
  {
    name: "add_track",
    description: "Create a new track on the timeline. Use this before adding clips if no suitable track exists.",
    parameters: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Display name for the track (e.g. 'Video 1', 'Music')" },
        type: { type: "string", enum: ["video", "audio", "text", "shape", "effect"], description: "Track type" },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "add_clip",
    description: "Add a media clip to a track. Use sourceMediaId to reference an uploaded media asset.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string", description: "ID of the target track" },
        sourceMediaId: { type: "string", description: "ID of the media asset to use (from the media bin)" },
        startTime: { type: "number", description: "Start time on the timeline in seconds" },
        duration: { type: "number", description: "Duration of the clip in seconds" },
        sourceOffset: { type: "number", description: "Offset into the source media in seconds (default 0)" },
        speed: { type: "number", description: "Playback speed multiplier (default 1)" },
      },
      required: ["trackId", "startTime", "duration"],
    },
  },
  {
    name: "source_edit",
    description: "Perform a Source Monitor insert or overwrite edit with linked A/V ripple, transition cleanup, and caption-binding synchronization.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string" },
        sourceMediaId: { type: "string" },
        startTime: { type: "number", description: "Timeline insertion/overwrite point in seconds" },
        duration: { type: "number", description: "Timeline duration, at least 0.05 seconds" },
        sourceOffset: { type: "number", description: "Source in-point in seconds; default 0" },
        mode: { type: "string", enum: ["insert", "overwrite"] },
      },
      required: ["trackId", "sourceMediaId", "startTime", "duration", "mode"],
    },
  },
  {
    name: "move_clip",
    description: "Move an existing clip to a different position or track.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip to move" },
        toTrackId: { type: "string", description: "Target track ID (omit to keep on same track)" },
        newStartTime: { type: "number", description: "New start time in seconds" },
      },
      required: ["clipId", "newStartTime"],
    },
  },
  {
    name: "trim_clip",
    description: "Trim a clip by changing its start time and/or duration on the timeline.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip to trim" },
        startTime: { type: "number", description: "New start time in seconds" },
        duration: { type: "number", description: "New duration in seconds" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "split_clip",
    description: "Split a clip at a specific time, creating two clips.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip to split" },
        time: { type: "number", description: "Timeline time in seconds where the split occurs" },
      },
      required: ["clipId", "time"],
    },
  },
  {
    name: "delete_clip",
    description:
      "Remove a clip and leave a hole on the track (lift). Does not shift later clips. Prefer ripple_delete_clip to close the hole. Transitions involving the clip are removed.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip to delete" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "ripple_delete_clip",
    description:
      "Delete a clip and shift later clips on the SAME track left to close the gap. Use to tighten an edit. Same-track only (no linked A/V). Removes transitions involving the deleted clip.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "close_gap",
    description:
      "Close empty gaps between clips on one track by shifting later clips left. Optional atTime closes only the gap containing that time. Same-track only.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string" },
        atTime: {
          type: "number",
          description: "If set, only close the gap that contains this timeline time",
        },
      },
      required: ["trackId"],
    },
  },
  {
    name: "ripple_trim_clip",
    description:
      "Trim a clip and ripple later clips on the same track so the edit stays tight. Prefer over trim_clip when tightening. Same-track only.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        startTime: { type: "number", description: "New timeline start (seconds)" },
        duration: { type: "number", description: "New duration (seconds)" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "replace_clip_media",
    description:
      "Swap a clip's source media in place (same id/slot). Default fit=keep-duration; pass mediaDuration when known so short sources clamp sourceOffset (never invents hold). fit=fit-media retimes duration to remaining media. Use to swap a shot without rebuilding the timeline.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        sourceMediaId: { type: "string" },
        fit: {
          type: "string",
          enum: ["keep-duration", "fit-media"],
          description: "Default keep-duration",
        },
        sourceOffset: { type: "number" },
        mediaDuration: {
          type: "number",
          description: "Source media duration in seconds (optional; looked up from library when omitted)",
        },
      },
      required: ["clipId", "sourceMediaId"],
    },
  },
  {
    name: "roll_edit",
    description: "Move the shared cut between two abutting same-track clips. Keeps downstream clips fixed and consumes source handles on both sides. Rejects reverse/speed-ramped clips and unknown handles.",
    parameters: { type: "object" as const, properties: { clipAId: { type: "string" }, clipBId: { type: "string" }, deltaSec: { type: "number", description: "Positive moves the cut later; negative moves it earlier" } }, required: ["clipAId", "clipBId", "deltaSec"] },
  },
  {
    name: "slide_edit",
    description: "Slide a clip left/right between abutting neighbors while preserving the outer cut points. Rejects insufficient source handles.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" }, deltaSec: { type: "number", description: "Positive moves the clip later; negative earlier" } }, required: ["clipId", "deltaSec"] },
  },
  {
    name: "slip_edit",
    description: "Move a clip’s source window without changing its timeline position or duration. deltaSourceSec is in source-media seconds.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" }, deltaSourceSec: { type: "number" } }, required: ["clipId", "deltaSourceSec"] },
  },
  {
    name: "match_frame",
    description: "Find the target timeline time for the exact source frame under a reference clip/time. Both clips must use the same source media; this is an observe tool and does not move clips.",
    parameters: { type: "object" as const, properties: { referenceClipId: { type: "string" }, referenceTimelineTime: { type: "number" }, targetClipId: { type: "string" } }, required: ["referenceClipId", "referenceTimelineTime", "targetClipId"] },
  },
  {
    name: "link_clips",
    description: "Link two or more synchronized clips (usually video + production audio) so grouped timeline operations can preserve sync.",
    parameters: { type: "object" as const, properties: { clipIds: { type: "array", items: { type: "string" } } }, required: ["clipIds"] },
  },
  {
    name: "unlink_clips",
    description: "Remove A/V linking from one or more clips without deleting media or changing timing.",
    parameters: { type: "object" as const, properties: { clipIds: { type: "array", items: { type: "string" } } }, required: ["clipIds"] },
  },
  {
    name: "ripple_delete_linked_group",
    description: "Delete every synchronized clip in the selected linked A/V group and ripple each affected track by the shared duration.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" } }, required: ["clipId"] },
  },
  {
    name: "resolve_three_point_edit",
    description: "Resolve 3- or 4-point source/timeline marks into an exact sourceOffset, duration, and timeline placement. Use its result directly with add_clip; it does not mutate the timeline.",
    parameters: { type: "object" as const, properties: { sourceIn: { type: "number" }, sourceOut: { type: "number" }, timelineIn: { type: "number" }, timelineOut: { type: "number" }, speed: { type: "number" } }, required: ["sourceIn", "timelineIn"] },
  },
  {
    name: "duplicate_clip",
    description: "Duplicate a clip onto the same track, placed just after the original.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "remove_track",
    description: "Delete a track and all of its clips.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string" },
      },
      required: ["trackId"],
    },
  },
  {
    name: "reorder_track",
    description: "Change a track's stack order (higher order = rendered on top).",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string" },
        newOrder: { type: "number", description: "New order index (0-based)" },
      },
      required: ["trackId", "newOrder"],
    },
  },
  {
    name: "set_track_flags",
    description: "Set track locked / visible / solo flags, and optionally rename.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string" },
        locked: { type: "boolean" },
        visible: { type: "boolean" },
        solo: { type: "boolean" },
        name: { type: "string" },
      },
      required: ["trackId"],
    },
  },
];

export const timelineToolExecutors: Record<string, (args: any, state: ProjectState) => { result: string; state: ProjectState }> = {
  add_track: (args, state) => {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name || name.length > 120) {
      return { result: toolErr("Track name must contain 1 to 120 characters", { code: "INVALID_TRACK" }), state };
    }
    if (typeof args.type !== "string" || !TRACK_TYPES.has(args.type as TrackType)) {
      return { result: toolErr("Unknown track type", { code: "INVALID_TRACK" }), state };
    }
    const id = randomUUID();
    const track: Track = {
      id,
      name,
      type: args.type as TrackType,
      order: state.tracks.length,
      locked: false,
      visible: true,
      solo: false,
      clips: [],
    };
    state.tracks.push(track);
    return {
      result: toolOk(`Created track "${args.name}" (type: ${args.type})`, {
        trackId: id,
      }),
      state,
    };
  },

  add_clip: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) {
      return {
        result: toolErr(`Track ${args.trackId} not found`, {
          code: "TRACK_NOT_FOUND",
        }),
        state,
      };
    }
    if (track.locked) {
      return { result: toolErr(`Track ${track.id} is locked`, { code: "TRACK_LOCKED" }), state };
    }
    if (track.type === "adjustment") {
      return {
        result: toolErr("Use add_adjustment_layer; ordinary media clips cannot be placed on an adjustment track.", {
          code: "ADJUSTMENT_LAYER_REQUIRED",
        }),
        state,
      };
    }

    const startTime = finiteNumber(args.startTime);
    const duration = finiteNumber(args.duration);
    const sourceOffset = args.sourceOffset === undefined ? 0 : finiteNumber(args.sourceOffset);
    const rawSpeed = args.speed === undefined ? 1 : finiteNumber(args.speed);
    if (startTime === null || startTime < 0 || duration === null || duration < 0.05) {
      return { result: toolErr("startTime must be non-negative and duration must be at least 0.05 seconds", { code: "INVALID_CLIP" }), state };
    }
    if (sourceOffset === null || sourceOffset < 0 || rawSpeed === null || rawSpeed === 0) {
      return { result: toolErr("sourceOffset must be non-negative and speed must be a non-zero finite number", { code: "INVALID_CLIP" }), state };
    }
    const sourceMediaId = typeof args.sourceMediaId === "string" && args.sourceMediaId.trim()
      ? args.sourceMediaId.trim()
      : null;
    if (!sourceMediaId) {
      return { result: toolErr("sourceMediaId is required for add_clip", { code: "MEDIA_REQUIRED" }), state };
    }
    const asset = state.mediaAssets?.find((candidate) => candidate.id === sourceMediaId);
    if (state.mediaAssets && !asset) {
      return { result: toolErr(`Media ${sourceMediaId} not found`, { code: "MEDIA_NOT_FOUND" }), state };
    }
    if (!(["video", "audio"] as TrackType[]).includes(track.type)) {
      return { result: toolErr("Media clips can only be added to video or audio tracks", { code: "WRONG_TRACK_TYPE" }), state };
    }
    if (asset?.type === "audio" && track.type !== "audio") {
      return { result: toolErr("Audio-only media must be added to an audio track", { code: "WRONG_TRACK_TYPE" }), state };
    }
    if (asset?.type === "image" && track.type === "audio") {
      return { result: toolErr("Images cannot be added to an audio track", { code: "WRONG_TRACK_TYPE" }), state };
    }
    if (asset && asset.type !== "image") {
      const mediaDuration = asset.duration ?? asset.metadata?.duration;
      const consumedSource = duration * Math.abs(rawSpeed);
      if (
        typeof mediaDuration === "number" && mediaDuration > 0 &&
        sourceOffset + consumedSource > mediaDuration + 0.001
      ) {
        return {
          result: toolErr(
            `Clip source range ends at ${(sourceOffset + consumedSource).toFixed(3)}s, beyond media duration ${mediaDuration.toFixed(3)}s`,
            {
              code: "SOURCE_RANGE_OVERRUN",
              mediaDuration,
              sourceOffset,
              requestedTimelineDuration: duration,
              speed: Math.abs(rawSpeed),
              maxTimelineDuration: Math.max(0, (mediaDuration - sourceOffset) / Math.abs(rawSpeed)),
              fixHint: "Reduce duration or speed, or choose an earlier sourceOffset. Never rely on an implicit freeze/black tail.",
            }
          ),
          state,
        };
      }
    }

    const id = randomUUID();
    const clip: Clip = {
      id,
      trackId: args.trackId,
      sourceMediaId,
      startTime,
      duration,
      sourceOffset,
      speed: Math.abs(rawSpeed),
      ...(rawSpeed < 0 ? { reversed: true } : {}),
      transform: { ...DEFAULT_TRANSFORM },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
      ...(asset?.type !== "audio"
        ? { mediaLayout: { schemaVersion: 1 as const, fit: "cover" as const, focalPoint: { x: 0.5, y: 0.5 } } }
        : {}),
    };
    track.clips.push(clip);
    const sourceOrientation = asset ? mediaAssetOrientation(asset) : "unknown";
    const targetOrientation = orientationFromDimensions(state.settings?.width, state.settings?.height);
    const orientationWarning = asset?.type !== "audio" && !orientationMatches(sourceOrientation, targetOrientation)
      ? `Source is ${sourceOrientation} while delivery is ${targetOrientation}; cover crop will preserve aspect ratio but may remove substantial frame area.`
      : undefined;
    return {
      result: toolOk(
        `Added clip to track "${track.name}" at ${args.startTime}s, duration ${args.duration}s`,
        {
          clipId: id,
          trackId: track.id,
          sourceOrientation,
          targetOrientation,
          fit: asset?.type === "audio" ? undefined : "cover",
          warning: orientationWarning,
        }
      ),
      state,
    };
  },

  source_edit: (args, state) => {
    const track = state.tracks.find((candidate) => candidate.id === String(args.trackId));
    if (!track) return { result: "Error: Target track was not found", state };
    const asset = state.mediaAssets?.find((candidate) => candidate.id === String(args.sourceMediaId));
    if (asset?.type === "audio" && track.type !== "audio") {
      return { result: "Error: Audio-only media must be inserted on an audio track", state };
    }
    const result = sourceEdit(
      state.tracks,
      state.transitions || [],
      track.id,
      {
        sourceMediaId: String(args.sourceMediaId),
        startTime: Number(args.startTime),
        duration: Number(args.duration),
        sourceOffset: args.sourceOffset === undefined ? 0 : Number(args.sourceOffset),
        speed: 1,
        transform: { ...DEFAULT_TRANSFORM },
        opacity: 1,
        blendMode: "normal",
        effects: [],
        keyframes: [],
        mask: null,
        muted: false,
        volume: 1,
        ...(asset?.type !== "audio"
          ? { mediaLayout: { schemaVersion: 1 as const, fit: "cover" as const, focalPoint: { x: 0.5, y: 0.5 } } }
          : {}),
      },
      args.mode === "overwrite" ? "overwrite" : "insert",
      randomUUID
    );
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    for (const pair of result.metadata.splitPairs) {
      const first = findClip(state, pair.firstClipId)?.clip;
      const second = findClip(state, pair.secondClipId)?.clip;
      if (first && second) rebindCaptionsAfterSplit(state, first, second);
    }
    for (const clipId of result.metadata.removedClipIds) markCaptionsForMissingSourceStale(state, clipId);
    for (const clipId of result.metadata.changedClipIds) {
      const clip = findClip(state, clipId)?.clip;
      if (clip?.sourceMediaId) syncCaptionsBoundToClip(state, clip);
    }
    return {
      result: JSON.stringify({
        ok: true,
        clipId: result.metadata.insertedClipId,
        mode: args.mode,
        sourceOrientation: asset ? mediaAssetOrientation(asset) : "unknown",
        targetOrientation: orientationFromDimensions(state.settings?.width, state.settings?.height),
        fit: asset?.type === "audio" ? undefined : "cover",
        ...result.metadata,
      }),
      state,
    };
  },

  move_clip: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };

    const nextStart = finiteNumber(args.newStartTime);
    if (nextStart === null || nextStart < 0) return { result: "Error: newStartTime must be a non-negative finite number", state };
    if (found.track.locked) return { result: `Error: Track ${found.track.id} is locked`, state };

    if (found.clip.linkGroupId) {
      if (args.toTrackId && args.toTrackId !== found.track.id) {
        return { result: "Error: Linked groups can be moved in time but cannot be reassigned to one track", state };
      }
      const group = state.tracks.flatMap((track) => track.clips).filter((clip) => clip.linkGroupId === found.clip.linkGroupId);
      if (group.some((clip) => state.tracks.find((track) => track.id === clip.trackId)?.locked)) {
        return { result: "Error: A track containing a linked clip is locked", state };
      }
      const delta = nextStart - found.clip.startTime;
      if (group.some((clip) => clip.startTime + delta < 0)) {
        return { result: "Error: Linked move would place a clip before timeline zero", state };
      }
      for (const clip of group) clip.startTime += delta;
      const groupIds = group.map((clip) => clip.id);
      transitionsWithoutClips(state, new Set(groupIds));
      let updated = 0;
      let stale = 0;
      for (const clipId of groupIds) {
        const clip = findClip(state, clipId)?.clip;
        if (!clip) continue;
        if (!clip.sourceMediaId) continue;
        const sync = syncCaptionsBoundToClip(state, clip);
        updated += sync.updated;
        stale += sync.stale;
      }
      return { result: `Moved ${group.length} linked clips by ${delta}s; captions updated=${updated}, stale=${stale}`, state };
    }

    const toTrackId = args.toTrackId || found.track.id;
    const targetTrack = state.tracks.find((t) => t.id === toTrackId);
    if (!targetTrack) return { result: `Error: Target track ${toTrackId} not found`, state };
    if (targetTrack.locked) return { result: `Error: Track ${targetTrack.id} is locked`, state };
    if (targetTrack.type === "adjustment" && found.track.type !== "adjustment") {
      return { result: "Error: Media clips cannot be moved onto an adjustment track", state };
    }
    if (found.track.type === "adjustment" && targetTrack.type !== "adjustment") {
      return { result: "Error: Adjustment clips must stay on an adjustment track", state };
    }
    found.track.clips = found.track.clips.filter((c) => c.id !== args.clipId);
    found.clip.startTime = nextStart;
    found.clip.trackId = toTrackId;

    targetTrack.clips.push(found.clip);
    transitionsWithoutClips(state, new Set([found.clip.id]));
    const movedClip = findClip(state, found.clip.id)?.clip;
    const sync = movedClip?.sourceMediaId
      ? syncCaptionsBoundToClip(state, movedClip)
      : { updated: 0, stale: 0 };
    return {
      result: `Moved clip to ${nextStart}s on track "${targetTrack.name}"; captions updated=${sync.updated}, stale=${sync.stale}`,
      state,
    };
  },

  trim_clip: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };

    if (found.track.locked) return { result: `Error: Track ${found.track.id} is locked`, state };
    const nextStart = args.startTime === undefined ? found.clip.startTime : finiteNumber(args.startTime);
    const nextDuration = args.duration === undefined ? found.clip.duration : finiteNumber(args.duration);
    if (nextStart === null || nextStart < 0 || nextDuration === null || nextDuration < 0.05) {
      return { result: "Error: startTime must be non-negative and duration must be at least 0.05 seconds", state };
    }
    if (args.startTime === undefined && args.duration === undefined) {
      return { result: "Error: Provide startTime and/or duration", state };
    }

    if (found.clip.linkGroupId) {
      const group = state.tracks.flatMap((track) => track.clips).filter((clip) => clip.linkGroupId === found.clip.linkGroupId);
      if (group.some((clip) => state.tracks.find((track) => track.id === clip.trackId)?.locked)) {
        return { result: "Error: A track containing a linked clip is locked", state };
      }
      const deltaStart = nextStart - found.clip.startTime;
      if (group.some((clip) => clip.sourceMediaId && clip.sourceOffset + deltaStart * (clip.speed || 1) < -0.0001)) {
        return { result: "Error: Linked trim would exceed a member's source in-point", state };
      }
      for (const clip of group) {
        clip.startTime = nextStart;
        clip.duration = nextDuration;
        if (clip.sourceMediaId) clip.sourceOffset = Math.max(0, clip.sourceOffset + deltaStart * (clip.speed || 1));
      }
      const groupIds = group.map((clip) => clip.id);
      transitionsWithoutClips(state, new Set(groupIds));
      for (const clipId of groupIds) {
        const current = findClip(state, clipId)?.clip;
        if (current?.sourceMediaId) syncCaptionsBoundToClip(state, current);
      }
      return { result: `Trimmed ${group.length} linked clips to start=${nextStart}s, duration=${nextDuration}s`, state };
    }

    if (args.startTime !== undefined) {
      const delta = nextStart - found.clip.startTime;
      if (found.clip.sourceMediaId) {
        found.clip.sourceOffset = Math.max(
          0,
          found.clip.sourceOffset + delta * (found.clip.speed || 1)
        );
      }
      found.clip.startTime = nextStart;
    }
    if (args.duration !== undefined) found.clip.duration = nextDuration;
    transitionsWithoutClips(state, new Set([found.clip.id]));
    const trimmedClip = findClip(state, found.clip.id)?.clip;
    const sync = trimmedClip?.sourceMediaId
      ? syncCaptionsBoundToClip(state, trimmedClip)
      : { updated: 0, stale: 0 };
    return {
      result: `Trimmed clip to start=${found.clip.startTime}s, duration=${found.clip.duration}s, sourceOffset=${found.clip.sourceOffset}s; captions updated=${sync.updated}, stale=${sync.stale}`,
      state,
    };
  },

  split_clip: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };

    if (found.track.locked) return { result: `Error: Track ${found.track.id} is locked`, state };

    const { clip, track } = found;
    const splitTime = finiteNumber(args.time);
    if (splitTime === null) return { result: "Error: Split time must be a finite number", state };
    if (splitTime <= clip.startTime || splitTime >= clip.startTime + clip.duration) {
      return { result: `Error: Split time ${splitTime}s is outside clip range [${clip.startTime}, ${clip.startTime + clip.duration}]`, state };
    }

    if (clip.linkGroupId) {
      const group = state.tracks.flatMap((candidate) => candidate.clips).filter((candidate) => candidate.linkGroupId === clip.linkGroupId);
      if (group.some((candidate) => state.tracks.find((candidateTrack) => candidateTrack.id === candidate.trackId)?.locked)) {
        return { result: "Error: A track containing a linked clip is locked", state };
      }
      if (group.some((candidate) => splitTime <= candidate.startTime || splitTime >= candidate.startTime + candidate.duration)) {
        return { result: "Error: Split time must be inside every linked clip", state };
      }
      const rightGroupId = randomUUID();
      const secondIds = new Map(group.map((candidate) => [candidate.id, randomUUID()]));
      for (const candidate of group) {
        const firstDuration = splitTime - candidate.startTime;
        const second: Clip = {
          ...JSON.parse(JSON.stringify(candidate)),
          id: secondIds.get(candidate.id)!,
          linkGroupId: rightGroupId,
          startTime: splitTime,
          duration: candidate.duration - firstDuration,
          sourceOffset: candidate.sourceOffset + firstDuration * (candidate.speed || 1),
        };
        candidate.duration = firstDuration;
        state.tracks.find((candidateTrack) => candidateTrack.id === candidate.trackId)!.clips.push(second);
      }
      const groupIds = group.map((candidate) => candidate.id);
      transitionsWithoutClips(state, new Set(groupIds));
      for (const candidateId of groupIds) {
        const first = findClip(state, candidateId)?.clip;
        const second = findClip(state, secondIds.get(candidateId)!)?.clip;
        if (first?.sourceMediaId && second) rebindCaptionsAfterSplit(state, first, second);
      }
      return { result: `Split ${group.length} linked clips at ${splitTime}s; new selected clip id: ${secondIds.get(clip.id)}`, state };
    }

    const firstDuration = splitTime - clip.startTime;
    const secondDuration = clip.startTime + clip.duration - splitTime;
    const newId = randomUUID();
    const speed = clip.speed || 1;

    const secondClip: Clip = {
      ...JSON.parse(JSON.stringify(clip)),
      id: newId,
      startTime: splitTime,
      duration: secondDuration,
      sourceOffset: clip.sourceOffset + firstDuration * speed,
    };

    clip.duration = firstDuration;
    track.clips.push(secondClip);
    transitionsWithoutClips(state, new Set([clip.id]));
    const currentFirst = findClip(state, clip.id)?.clip;
    const currentSecond = findClip(state, secondClip.id)?.clip;
    const bindings = currentFirst?.sourceMediaId && currentSecond
      ? rebindCaptionsAfterSplit(state, currentFirst, currentSecond)
      : { first: 0, second: 0, stale: 0 };
    return {
      result: `Split clip at ${splitTime}s. Original: ${firstDuration}s, new clip (id: ${newId}): ${secondDuration}s. Caption bindings first=${bindings.first}, second=${bindings.second}, stale=${bindings.stale}`,
      state,
    };
  },

  delete_clip: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    if (isReferenceStructure(found.track, found.clip)) {
      return {
        result: `Error: Clip ${args.clipId} is reference-bound (${found.clip.referenceEditBinding?.kind || "generated"}) and is structurally locked. Preserve its timing/source; adjust keyframes or layout instead of deleting it.`,
        state,
      };
    }
    const result = deleteClipLeaveGap(
      state.tracks,
      state.transitions || [],
      String(args.clipId)
    );
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    const stale = found.clip.sourceMediaId
      ? markCaptionsForMissingSourceStale(state, args.clipId)
      : 0;
    return {
      result: `Deleted clip ${args.clipId} (left gap) from track "${found.track.name}"; marked ${stale} bound caption(s) stale`,
      state,
    };
  },

  ripple_delete_clip: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    if (isReferenceStructure(found.track, found.clip)) {
      return {
        result: `Error: Clip ${args.clipId} is reference-bound and cannot be ripple-deleted. Preserve compiled reference structure.`,
        state,
      };
    }
    const trackId = found.track.id;
    const result = rippleDeleteClip(
      state.tracks,
      state.transitions || [],
      String(args.clipId)
    );
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    const stale = found.clip.sourceMediaId
      ? markCaptionsForMissingSourceStale(state, args.clipId)
      : 0;
    const track = state.tracks.find((t) => t.id === trackId);
    let synced = 0;
    if (track) {
      for (const c of track.clips) {
        if (c.sourceMediaId) {
          const r = syncCaptionsBoundToClip(state, c);
          synced += r.updated;
        }
      }
    }
    return {
      result: `${result.message}; marked ${stale} bound caption(s) stale; re-synced ${synced} caption(s)`,
      state,
    };
  },

  close_gap: (args, state) => {
    const trackId = String(args.trackId);
    if (!state.tracks.some((t) => t.id === trackId)) {
      return { result: `Error: Track ${trackId} not found`, state };
    }
    const atTime =
      args.atTime !== undefined && args.atTime !== null
        ? Number(args.atTime)
        : undefined;
    const result = closeGapOnTrack(
      state.tracks,
      state.transitions || [],
      trackId,
      atTime
    );
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    const track = state.tracks.find((t) => t.id === trackId);
    if (track) {
      for (const c of track.clips) {
        if (c.sourceMediaId) syncCaptionsBoundToClip(state, c);
      }
    }
    return { result: result.message || `Closed gaps on track ${trackId}`, state };
  },

  ripple_trim_clip: (args, state) => {
    const before = findClip(state, args.clipId);
    if (!before) {
      return { result: `Error: Clip ${args.clipId} not found`, state };
    }
    const trackId = before.track.id;
    const patch: { startTime?: number; duration?: number } = {};
    if (args.startTime !== undefined) patch.startTime = Number(args.startTime);
    if (args.duration !== undefined) patch.duration = Number(args.duration);
    if (patch.startTime === undefined && patch.duration === undefined) {
      return {
        result: "Error: Provide startTime and/or duration for ripple_trim_clip",
        state,
      };
    }
    const result = rippleTrimClip(
      state.tracks,
      state.transitions || [],
      String(args.clipId),
      patch
    );
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    const track = state.tracks.find((t) => t.id === trackId);
    if (track) {
      for (const c of track.clips) {
        if (c.sourceMediaId) syncCaptionsBoundToClip(state, c);
      }
    }
    return { result: result.message || `Ripple-trimmed ${args.clipId}`, state };
  },

  replace_clip_media: (args, state) => {
    const before = findClip(state, args.clipId);
    if (!before) {
      return { result: `Error: Clip ${args.clipId} not found`, state };
    }
    const sourceMediaId = String(args.sourceMediaId);
    const mediaDuration =
      args.mediaDuration !== undefined && args.mediaDuration !== null
        ? Number(args.mediaDuration)
        : mediaDurationSec(state, sourceMediaId);
    // Reference-bound clips may be phase-overlapped by design. A replacement
    // must be source-only and keep the compiled timeline slot exactly intact.
    const fit = isReferenceStructure(before.track, before.clip)
      ? ("keep-duration" as const)
      : args.fit === "fit-media" ? "fit-media" : ("keep-duration" as const);
    const result = replaceClipMedia(
      state.tracks,
      state.transitions || [],
      String(args.clipId),
      {
        sourceMediaId,
        sourceOffset:
          args.sourceOffset !== undefined ? Number(args.sourceOffset) : undefined,
        mediaDurationSec: mediaDuration,
        fit,
      }
    );
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    const found = findClip(state, args.clipId);
    if (found?.clip.sourceMediaId) syncCaptionsBoundToClip(state, found.clip);
    return { result: result.message || `Replaced media on ${args.clipId}`, state };
  },

  roll_edit: (args, state) => {
    const result = rollEdit(state.tracks, state.transitions || [], String(args.clipAId), String(args.clipBId), Number(args.deltaSec), Object.fromEntries((state.mediaAssets || []).map((asset) => [asset.id, Number(asset.duration ?? asset.metadata?.duration ?? 0)])));
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    for (const clipId of [String(args.clipAId), String(args.clipBId)]) {
      const clip = findClip(state, clipId)?.clip;
      if (clip?.sourceMediaId) syncCaptionsBoundToClip(state, clip);
    }
    return { result: result.message || "Rolled edit", state };
  },

  slide_edit: (args, state) => {
    const before = findClip(state, String(args.clipId));
    const affectedTrackId = before?.track.id;
    const result = slideEdit(state.tracks, state.transitions || [], String(args.clipId), Number(args.deltaSec), Object.fromEntries((state.mediaAssets || []).map((asset) => [asset.id, Number(asset.duration ?? asset.metadata?.duration ?? 0)])));
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    const affectedTrack = state.tracks.find((track) => track.id === affectedTrackId);
    for (const clip of affectedTrack?.clips || []) {
      if (clip.sourceMediaId) syncCaptionsBoundToClip(state, clip);
    }
    return { result: result.message || "Slid edit", state };
  },

  slip_edit: (args, state) => {
    const result = slipEdit(state.tracks, state.transitions || [], String(args.clipId), Number(args.deltaSourceSec), Object.fromEntries((state.mediaAssets || []).map((asset) => [asset.id, Number(asset.duration ?? asset.metadata?.duration ?? 0)])));
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    const clip = findClip(state, String(args.clipId))?.clip;
    if (clip?.sourceMediaId) syncCaptionsBoundToClip(state, clip);
    return { result: result.message || "Slipped edit", state };
  },

  match_frame: (args, state) => {
    const result = matchFrameTime(state.tracks, String(args.referenceClipId), Number(args.referenceTimelineTime), String(args.targetClipId));
    return { result: result.ok ? JSON.stringify(result) : `Error: ${result.message}`, state };
  },

  link_clips: (args, state) => {
    const clipIds = Array.isArray(args.clipIds) ? args.clipIds.map(String) : [];
    const result = linkClips(state.tracks, clipIds, randomUUID());
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    const groupId = findClip(state, result.clipIds[0]!)?.clip.linkGroupId;
    return { result: JSON.stringify({ ok: true, linkGroupId: groupId, clipIds: result.clipIds }), state };
  },

  unlink_clips: (args, state) => {
    const result = unlinkClips(state.tracks, Array.isArray(args.clipIds) ? args.clipIds.map(String) : []);
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    return { result: JSON.stringify({ ok: true, clipIds: result.clipIds }), state };
  },

  ripple_delete_linked_group: (args, state) => {
    const selected = findClip(state, String(args.clipId))?.clip;
    const removed = selected?.linkGroupId
      ? state.tracks.flatMap((track) => track.clips).filter((clip) => clip.linkGroupId === selected.linkGroupId)
      : [];
    const affectedTrackIds = new Set(removed.map((clip) => clip.trackId));
    const result = rippleDeleteLinkedGroup(state.tracks, state.transitions || [], String(args.clipId));
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    for (const clip of removed) {
      if (clip.sourceMediaId) markCaptionsForMissingSourceStale(state, clip.id);
    }
    for (const track of state.tracks) {
      if (!affectedTrackIds.has(track.id)) continue;
      for (const clip of track.clips) {
        if (clip.sourceMediaId) syncCaptionsBoundToClip(state, clip);
      }
    }
    return { result: result.message || "Ripple-deleted linked group", state };
  },

  resolve_three_point_edit: (args, state) => {
    const result = resolveThreePointEdit({ sourceIn: Number(args.sourceIn), sourceOut: args.sourceOut == null ? undefined : Number(args.sourceOut), timelineIn: Number(args.timelineIn), timelineOut: args.timelineOut == null ? undefined : Number(args.timelineOut), speed: args.speed == null ? undefined : Number(args.speed) });
    return { result: result.ok ? JSON.stringify(result) : `Error: ${result.message}`, state };
  },

  duplicate_clip: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    const { clip, track } = found;
    const newId = randomUUID();
    // Deep-clone then re-id nested entities so original/duplicate never share refs.
    const duplicate: Clip = JSON.parse(JSON.stringify(clip));
    duplicate.id = newId;
    duplicate.startTime = clip.startTime + clip.duration + 0.1;
    duplicate.effects = duplicate.effects.map((e) => ({
      ...e,
      id: randomUUID(),
      params: { ...e.params },
      keyframes: e.keyframes.map((k) => ({ ...k, id: randomUUID() })),
    }));
    duplicate.keyframes = duplicate.keyframes.map((k) => ({
      ...k,
      id: randomUUID(),
    }));
    track.clips.push(duplicate);
    return {
      result: `Duplicated clip ${clip.id} → ${newId} at ${duplicate.startTime}s`,
      state,
    };
  },

  remove_track: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const clipCount = track.clips.length;
    const removedClipIds = new Set(track.clips.map((clip) => clip.id));
    const cleared = removeMatchingTransitions(
      state.tracks,
      state.transitions || [],
      (transition) => transition.trackId === track.id || removedClipIds.has(transition.clipAId) || removedClipIds.has(transition.clipBId)
    );
    state.tracks = cleared.tracks.filter((t) => t.id !== args.trackId);
    state.transitions = cleared.transitions;
    for (const clip of track.clips) {
      if (clip.sourceMediaId) markCaptionsForMissingSourceStale(state, clip.id);
    }
    state.tracks.forEach((t, i) => {
      t.order = i;
    });
    return {
      result: `Removed track "${track.name}" (${args.trackId}) and ${clipCount} clips`,
      state,
    };
  },

  reorder_track: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const requestedOrder = finiteNumber(args.newOrder);
    if (requestedOrder === null || !Number.isInteger(requestedOrder)) return { result: "Error: newOrder must be a finite integer", state };
    const newOrder = Math.max(0, Math.min(state.tracks.length - 1, requestedOrder));
    const sorted = [...state.tracks].sort((a, b) => a.order - b.order);
    const without = sorted.filter((t) => t.id !== track.id);
    without.splice(newOrder, 0, track);
    without.forEach((t, i) => {
      t.order = i;
    });
    state.tracks = without;
    return {
      result: `Reordered track "${track.name}" to order ${newOrder}`,
      state,
    };
  },

  set_track_flags: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const updated: string[] = [];
    if (args.locked !== undefined) {
      if (typeof args.locked !== "boolean") return { result: "Error: locked must be a boolean", state };
      track.locked = args.locked;
      updated.push(`locked=${track.locked}`);
    }
    if (args.visible !== undefined) {
      if (typeof args.visible !== "boolean") return { result: "Error: visible must be a boolean", state };
      track.visible = args.visible;
      updated.push(`visible=${track.visible}`);
    }
    if (args.solo !== undefined) {
      if (typeof args.solo !== "boolean") return { result: "Error: solo must be a boolean", state };
      track.solo = args.solo;
      updated.push(`solo=${track.solo}`);
    }
    if (args.name !== undefined) {
      if (typeof args.name !== "string" || !args.name.trim() || args.name.trim().length > 120) {
        return { result: "Error: name must contain 1 to 120 characters", state };
      }
      track.name = args.name.trim();
      updated.push(`name=${track.name}`);
    }
    if (updated.length === 0) {
      return { result: "Error: No track flags provided", state };
    }
    return { result: `Updated track ${track.id}: ${updated.join(", ")}`, state };
  },
};
