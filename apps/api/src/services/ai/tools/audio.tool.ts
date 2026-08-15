import type { AudioAutomationPoint, Track, Clip, TrackAudioRole } from "@tempo/types";
import { randomUUID } from "crypto";
import { normalizeAudioAutomationPoints, normalizeDuckSettings, normalizeTrackEq, normalizeTrackAudioPost, normalizeMastering, removeMatchingTransitions, toolErr, toolOk } from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";
import { ensureAudioMixer } from "./project-state.js";
import { syncCaptionsBoundToClip } from "./caption-binding-sync.js";

function findClip(state: ProjectState, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

const DEFAULT_TRANSFORM = {
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0,
};

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseAutomationPoints(input: unknown, property: "volume" | "pan", duration?: number): AudioAutomationPoint[] {
  const points = Array.isArray(input) ? input.map((point) => ({
    id: typeof point?.id === "string" ? point.id : randomUUID(),
    time: Number(point?.time),
    value: Number(point?.value),
    interpolation: point?.interpolation === "hold" ? "hold" as const : "linear" as const,
  })) : [];
  return normalizeAudioAutomationPoints(points, property, duration);
}

function resolveBeatTimes(args: Record<string, any>, state: ProjectState): number[] {
  if (Array.isArray(args.beatTimes) && args.beatTimes.length > 0) {
    return args.beatTimes.map(Number).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  }
  if (state.beatTimes && state.beatTimes.length > 0) {
    return state.beatTimes.filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  }
  const beats = state.editBlueprint?.audioAnalysis?.beats;
  if (beats?.length) {
    return beats.map((b) => b.time).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  }
  return [];
}

function nearestBeat(time: number, beats: number[]): number {
  let best = beats[0]!;
  let bestDist = Math.abs(best - time);
  for (const b of beats) {
    const d = Math.abs(b - time);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

export const audioToolDefinitions = [
  {
    name: "get_audio_events",
    description: "Read measured reference audio events for exact animation/cut synchronization. Returns irregular impacts even when no reliable BPM grid exists; use their stable ids with set_keyframe_curve or their times with text unitStartTimes. This is observational and does not edit the timeline.",
    parameters: {
      type: "object" as const,
      properties: {
        startTime: { type: "number", description: "Optional inclusive timeline start in seconds" },
        endTime: { type: "number", description: "Optional exclusive timeline end in seconds" },
        minimumStrength: { type: "number", description: "Optional 0..1 threshold" },
      },
      required: [],
    },
  },
  {
    name: "set_volume",
    description: "Set the audio volume for a clip (0 = silent, 1 = full volume).",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip" },
        volume: { type: "number", description: "Volume level (0.0 to 1.0)" },
      },
      required: ["clipId", "volume"],
    },
  },
  {
    name: "mute_clip",
    description: "Mute or unmute a clip's audio.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip" },
        muted: { type: "boolean", description: "true to mute, false to unmute" },
      },
      required: ["clipId", "muted"],
    },
  },
  {
    name: "fade_audio",
    description:
      "Set audio fade-in and/or fade-out durations (seconds) on a clip. Use for music intros/outros and soft clip edges.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip" },
        fadeInSec: { type: "number", description: "Fade-in duration in seconds (0 to clear)" },
        fadeOutSec: { type: "number", description: "Fade-out duration in seconds (0 to clear)" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "crossfade_audio",
    description: "Create a constant-power crossfade across two audio clips that already overlap on the timeline. The requested duration must fit inside that overlap.",
    parameters: { type: "object" as const, properties: { outgoingClipId: { type: "string" }, incomingClipId: { type: "string" }, duration: { type: "number", description: "Seconds; defaults to full existing overlap" } }, required: ["outgoingClipId", "incomingClipId"] },
  },
  {
    name: "set_master_volume",
    description: "Set the project master mixer volume (0–1).",
    parameters: {
      type: "object" as const,
      properties: {
        volume: { type: "number", description: "Master volume 0.0 to 1.0" },
      },
      required: ["volume"],
    },
  },
  {
    name: "set_track_volume",
    description: "Set mixer volume for an entire track (0–1).",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string", description: "Track ID" },
        volume: { type: "number", description: "Track volume 0.0 to 1.0" },
      },
      required: ["trackId", "volume"],
    },
  },
  {
    name: "set_track_pan",
    description: "Set a track's static stereo pan (-1 fully left, 0 center, 1 fully right).",
    parameters: { type: "object" as const, properties: { trackId: { type: "string" }, pan: { type: "number", description: "-1 to 1" } }, required: ["trackId", "pan"] },
  },
  {
    name: "set_clip_audio_automation",
    description: "Replace one clip-local volume (0–2) or pan (-1…1) envelope. Point times are seconds from the clip start; use hold interpolation for stepped ducking/stingers.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" }, property: { type: "string", enum: ["volume", "pan"] }, points: { type: "array", items: { type: "object", properties: { time: { type: "number" }, value: { type: "number" }, interpolation: { type: "string", enum: ["linear", "hold"] } }, required: ["time", "value"] } } }, required: ["clipId", "property", "points"] },
  },
  {
    name: "set_track_audio_automation",
    description: "Replace a track-wide volume (0–2) or pan (-1…1) envelope. Point times are absolute timeline seconds and affect every audio-bearing clip on the track.",
    parameters: { type: "object" as const, properties: { trackId: { type: "string" }, property: { type: "string", enum: ["volume", "pan"] }, points: { type: "array", items: { type: "object", properties: { time: { type: "number" }, value: { type: "number" }, interpolation: { type: "string", enum: ["linear", "hold"] } }, required: ["time", "value"] } } }, required: ["trackId", "property", "points"] },
  },
  {
    name: "mute_track",
    description: "Mute or unmute an entire track via the project mixer.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string", description: "Track ID" },
        muted: { type: "boolean", description: "true to mute, false to unmute" },
      },
      required: ["trackId", "muted"],
    },
  },
  {
    name: "sync_clips_to_beats",
    description:
      "Snap clip start times to the nearest beat. Pass beatTimes (seconds), or rely on Edit Like This blueprint beats already on the project.",
    parameters: {
      type: "object" as const,
      properties: {
        clipIds: {
          type: "array",
          items: { type: "string" },
          description: "Clip IDs to snap",
        },
        beatTimes: {
          type: "array",
          items: { type: "number" },
          description: "Beat times in seconds (optional if blueprint beats exist)",
        },
      },
      required: ["clipIds"],
    },
  },
  {
    name: "add_music_track",
    description:
      "Create an audio track and place a music/media clip on it. Prefer this for background music beds. Marks the track role as music for ducking.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceMediaId: { type: "string", description: "Media asset ID for the music" },
        startTime: { type: "number", description: "Timeline start (default 0)" },
        duration: { type: "number", description: "Clip duration in seconds (required)" },
        volume: { type: "number", description: "Clip volume 0–1 (default 0.7)" },
        trackName: { type: "string", description: "Track name (default Background Music)" },
        fadeInSec: { type: "number", description: "Optional fade-in seconds" },
        fadeOutSec: { type: "number", description: "Optional fade-out seconds" },
        sourceOffset: { type: "number", description: "Offset into source media (default 0)" },
      },
      required: ["sourceMediaId", "duration"],
    },
  },
  {
    name: "set_track_audio_role",
    description:
      "Tag a track as music, voice, or other for rule-based ducking (music ducks under voice overlaps).",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string" },
        role: { type: "string", description: "music | voice | other" },
      },
      required: ["trackId", "role"],
    },
  },
  {
    name: "set_audio_duck",
    description:
      "Enable/configure automatic music ducking under voice-role tracks. mode=rule|sidechain. level is music gain while ducked (0..1).",
    parameters: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" },
        mode: { type: "string", enum: ["rule", "sidechain"] },
        level: { type: "number" },
        attackSec: { type: "number" },
        releaseSec: { type: "number" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "set_track_eq",
    description: "Set 3-band EQ (low/mid/high gain in dB, ±12) on a track.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string" },
        lowGainDb: { type: "number" },
        midGainDb: { type: "number" },
        highGainDb: { type: "number" },
      },
      required: ["trackId"],
    },
  },
  {
    name: "set_track_audio_post",
    description: "Configure track cleanup and dynamics: FFT denoise, de-esser, compressor, and limiter. Use primarily on voice tracks; settings preview in Web Audio and export with FFmpeg.",
    parameters: { type: "object" as const, properties: { trackId: { type: "string" }, denoiseEnabled: { type: "boolean" }, denoiseAmount: { type: "number" }, deEsserEnabled: { type: "boolean" }, deEsserIntensity: { type: "number" }, deEsserFrequency: { type: "number" }, compressorEnabled: { type: "boolean" }, thresholdDb: { type: "number" }, ratio: { type: "number" }, attackMs: { type: "number" }, releaseMs: { type: "number" }, makeupDb: { type: "number" }, limiterEnabled: { type: "boolean" }, ceilingDb: { type: "number" } }, required: ["trackId"] },
  },
  {
    name: "apply_voice_post_preset",
    description: "Apply a practical voice-post chain to a track: clean-dialogue, podcast, or aggressive-ad. Use after tagging the track voice; inspect and adjust afterwards.",
    parameters: { type: "object" as const, properties: { trackId: { type: "string" }, preset: { type: "string", enum: ["clean-dialogue", "podcast", "aggressive-ad"] } }, required: ["trackId", "preset"] },
  },
  {
    name: "set_mastering",
    description: "Configure final-bus loudness normalization and true-peak-style limiting. Social default is targetLufs=-14, ceilingDb=-1. Loudness is exact in export; preview applies the safety limiter but cannot pre-measure integrated LUFS.",
    parameters: { type: "object" as const, properties: { limiterEnabled: { type: "boolean" }, ceilingDb: { type: "number" }, loudnessEnabled: { type: "boolean" }, targetLufs: { type: "number" } }, required: [] },
  },
];

export const audioToolExecutors: Record<
  string,
  (args: any, state: ProjectState) => { result: string; state: ProjectState }
> = {
  get_audio_events: (args, state) => {
    const analysis = state.editBlueprint?.audioAnalysis;
    if (!analysis) return { result: "Error: No saved reference audio analysis is available", state };
    const start = Number.isFinite(Number(args.startTime)) ? Math.max(0, Number(args.startTime)) : 0;
    const end = Number.isFinite(Number(args.endTime)) ? Math.max(start, Number(args.endTime)) : Number.POSITIVE_INFINITY;
    const minimumStrength = Number.isFinite(Number(args.minimumStrength))
      ? Math.max(0, Math.min(1, Number(args.minimumStrength)))
      : 0;
    const impacts = (analysis.impacts || [])
      .filter((event) => event.time >= start && event.time < end && event.strength >= minimumStrength)
      .map((event) => ({ id: event.id, time: event.time, kind: event.kind, strength: event.strength, confidence: event.confidence }));
    const beats = analysis.beats
      .filter((event) => event.time >= start && event.time < end && event.strength >= minimumStrength)
      .map((event) => ({ time: event.time, strength: event.strength, isDownbeat: event.isDownbeat }));
    return {
      result: JSON.stringify({
        ok: true,
        bpm: analysis.bpm,
        beatSource: analysis.beatSource || (analysis.beats.length ? "detected" : "unavailable"),
        impacts,
        beats,
        note: impacts.length
          ? "Use impact ids for exact event-anchored motion; a BPM grid is not required."
          : "No measured impacts exist in this range; do not invent rhythmic timestamps.",
      }),
      state,
    };
  },
  set_volume: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    const volume = finiteNumber(args.volume);
    if (volume === null) return { result: "Error: volume must be a finite number", state };
    found.clip.volume = Math.max(0, Math.min(1, volume));
    return { result: `Set volume to ${found.clip.volume} on clip`, state };
  },

  mute_clip: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    if (typeof args.muted !== "boolean") return { result: "Error: muted must be a boolean", state };
    found.clip.muted = args.muted;
    return { result: `${args.muted ? "Muted" : "Unmuted"} clip`, state };
  },

  fade_audio: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    if (args.fadeInSec !== undefined) {
      const fade = finiteNumber(args.fadeInSec);
      if (fade === null) return { result: "Error: fadeInSec must be a finite number", state };
      found.clip.fadeInSec = Math.max(0, Math.min(found.clip.duration, fade));
    }
    if (args.fadeOutSec !== undefined) {
      const fade = finiteNumber(args.fadeOutSec);
      if (fade === null) return { result: "Error: fadeOutSec must be a finite number", state };
      found.clip.fadeOutSec = Math.max(0, Math.min(found.clip.duration, fade));
    }
    return {
      result: `Set fades on clip: fadeIn=${found.clip.fadeInSec ?? 0}s, fadeOut=${found.clip.fadeOutSec ?? 0}s`,
      state,
    };
  },

  crossfade_audio: (args, state) => {
    const outgoing = findClip(state, String(args.outgoingClipId));
    const incoming = findClip(state, String(args.incomingClipId));
    if (!outgoing || !incoming) return { result: "Error: Both audio clips must exist", state };
    const overlapStart = Math.max(outgoing.clip.startTime, incoming.clip.startTime);
    const overlapEnd = Math.min(outgoing.clip.startTime + outgoing.clip.duration, incoming.clip.startTime + incoming.clip.duration);
    const available = overlapEnd - overlapStart;
    const duration = args.duration == null ? available : Number(args.duration);
    if (!(available > 0) || !(duration > 0) || duration > available + 1e-4) return { result: `Error: Clips need a real overlap; available=${Math.max(0, available).toFixed(3)}s`, state };
    outgoing.clip.fadeOutSec = duration;
    incoming.clip.fadeInSec = duration;
    outgoing.clip.audioFadeCurve = "equal-power";
    incoming.clip.audioFadeCurve = "equal-power";
    return { result: JSON.stringify({ ok: true, duration, curve: "equal-power", overlapStart, overlapEnd }), state };
  },

  set_master_volume: (args, state) => {
    const volume = finiteNumber(args.volume);
    if (volume === null) return { result: "Error: volume must be a finite number", state };
    const mixer = ensureAudioMixer(state);
    mixer.masterVolume = Math.max(0, Math.min(1, volume));
    return { result: `Master volume set to ${mixer.masterVolume}`, state };
  },

  set_track_volume: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const volume = finiteNumber(args.volume);
    if (volume === null) return { result: "Error: volume must be a finite number", state };
    const mixer = ensureAudioMixer(state);
    mixer.trackVolumes[args.trackId] = Math.max(0, Math.min(1, volume));
    return {
      result: `Track "${track.name}" volume set to ${mixer.trackVolumes[args.trackId]}`,
      state,
    };
  },

  set_track_pan: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const pan = finiteNumber(args.pan);
    if (pan === null) return { result: "Error: pan must be a finite number", state };
    const mixer = ensureAudioMixer(state);
    mixer.trackPans![track.id] = Math.max(-1, Math.min(1, pan));
    return { result: `Track "${track.name}" pan set to ${mixer.trackPans![track.id]}`, state };
  },

  set_clip_audio_automation: (args, state) => {
    const found = findClip(state, String(args.clipId));
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    const property = args.property === "pan" ? "pan" : args.property === "volume" ? "volume" : null;
    if (!property) return { result: 'Error: property must be "volume" or "pan"', state };
    const points = parseAutomationPoints(args.points, property, found.clip.duration);
    found.clip.audioAutomation = { ...(found.clip.audioAutomation || {}), [property]: points };
    return { result: JSON.stringify({ ok: true, clipId: found.clip.id, property, points }), state };
  },

  set_track_audio_automation: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const property = args.property === "pan" ? "pan" : args.property === "volume" ? "volume" : null;
    if (!property) return { result: 'Error: property must be "volume" or "pan"', state };
    const points = parseAutomationPoints(args.points, property);
    const mixer = ensureAudioMixer(state);
    mixer.trackAutomation![track.id] = { ...(mixer.trackAutomation![track.id] || {}), [property]: points };
    return { result: JSON.stringify({ ok: true, trackId: track.id, property, points }), state };
  },

  mute_track: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    if (typeof args.muted !== "boolean") return { result: "Error: muted must be a boolean", state };
    const mixer = ensureAudioMixer(state);
    mixer.trackMutes[args.trackId] = args.muted;
    return {
      result: `${args.muted ? "Muted" : "Unmuted"} track "${track.name}"`,
      state,
    };
  },

  sync_clips_to_beats: (args, state) => {
    const beats = resolveBeatTimes(args, state);
    if (beats.length === 0) {
      return {
        result:
          "Error: No beat times available. Pass beatTimes[] or run Edit Like This first so blueprint beats exist.",
        state,
      };
    }
    const clipIds: string[] = Array.isArray(args.clipIds) ? args.clipIds : [];
    if (clipIds.length === 0) return { result: "Error: clipIds required", state };

    const moved: string[] = [];
    const movedClipIds = new Set<string>();
    for (const clipId of clipIds) {
      const found = findClip(state, clipId);
      if (!found) {
        moved.push(`${clipId}: not found`);
        continue;
      }
      const snapped = nearestBeat(found.clip.startTime, beats);
      const prev = found.clip.startTime;
      const group = found.clip.linkGroupId
        ? state.tracks.flatMap((track) => track.clips).filter((clip) => clip.linkGroupId === found.clip.linkGroupId)
        : [found.clip];
      if (group.some((clip) => movedClipIds.has(clip.id))) continue;
      const delta = snapped - prev;
      for (const clip of group) {
        clip.startTime = Math.max(0, clip.startTime + delta);
        movedClipIds.add(clip.id);
      }
      moved.push(`${clipId}: ${prev.toFixed(2)}s → ${snapped.toFixed(2)}s`);
    }
    if (movedClipIds.size > 0) {
      const cleared = removeMatchingTransitions(
        state.tracks,
        state.transitions || [],
        (transition) => movedClipIds.has(transition.clipAId) || movedClipIds.has(transition.clipBId)
      );
      state.tracks = cleared.tracks;
      state.transitions = cleared.transitions;
      for (const clipId of movedClipIds) {
        const clip = findClip(state, clipId)?.clip;
        if (clip?.sourceMediaId) syncCaptionsBoundToClip(state, clip);
      }
    }
    return { result: `Synced ${clipIds.length} clip(s) to beats:\n${moved.join("\n")}`, state };
  },

  add_music_track: (args, state) => {
    if (typeof args.sourceMediaId !== "string" || !args.sourceMediaId.trim()) return { result: "Error: sourceMediaId required", state };
    const asset = state.mediaAssets?.find((candidate) => candidate.id === args.sourceMediaId);
    if (state.mediaAssets && !asset) return { result: `Error: Media ${args.sourceMediaId} not found`, state };
    if (asset?.type === "image") return { result: "Error: Images cannot be used as music", state };
    const duration = typeof args.duration === "number" ? args.duration : Number.NaN;
    if (!Number.isFinite(duration) || duration <= 0) {
      return { result: "Error: duration must be a positive number", state };
    }
    const startTime = args.startTime === undefined ? 0 : typeof args.startTime === "number" ? args.startTime : Number.NaN;
    const sourceOffset = args.sourceOffset === undefined ? 0 : typeof args.sourceOffset === "number" ? args.sourceOffset : Number.NaN;
    const volume = args.volume === undefined ? 0.7 : typeof args.volume === "number" ? args.volume : Number.NaN;
    const fadeInSec = args.fadeInSec === undefined ? undefined : typeof args.fadeInSec === "number" ? args.fadeInSec : Number.NaN;
    const fadeOutSec = args.fadeOutSec === undefined ? undefined : typeof args.fadeOutSec === "number" ? args.fadeOutSec : Number.NaN;
    if (!Number.isFinite(startTime) || startTime < 0 || !Number.isFinite(sourceOffset) || sourceOffset < 0) {
      return { result: "Error: startTime and sourceOffset must be non-negative finite numbers", state };
    }
    const mediaDuration = asset?.duration ?? asset?.metadata?.duration;
    if (
      typeof mediaDuration === "number" && mediaDuration > 0 &&
      sourceOffset + duration > mediaDuration + 0.001
    ) {
      return {
        result: toolErr(
          `Music source range ends at ${(sourceOffset + duration).toFixed(3)}s, beyond media duration ${mediaDuration.toFixed(3)}s`,
          { code: "SOURCE_RANGE_OVERRUN", mediaDuration, maxDuration: Math.max(0, mediaDuration - sourceOffset) }
        ),
        state,
      };
    }
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) return { result: "Error: volume must be from 0 to 1", state };
    if ((fadeInSec !== undefined && (!Number.isFinite(fadeInSec) || fadeInSec < 0)) || (fadeOutSec !== undefined && (!Number.isFinite(fadeOutSec) || fadeOutSec < 0))) {
      return { result: "Error: fades must be non-negative finite numbers", state };
    }
    const trackName = args.trackName === undefined ? "Background Music" : typeof args.trackName === "string" ? args.trackName.trim() : "";
    if (!trackName || trackName.length > 120) return { result: "Error: trackName must contain 1 to 120 characters", state };

    const trackId = randomUUID();
    const maxOrder = state.tracks.reduce((m, t) => Math.max(m, t.order), -1);
    const track: Track = {
      id: trackId,
      name: trackName,
      type: "audio",
      order: maxOrder + 1,
      locked: false,
      visible: true,
      solo: false,
      clips: [],
    };

    const clipId = randomUUID();
    const clip: Clip = {
      id: clipId,
      trackId,
      sourceMediaId: args.sourceMediaId,
      startTime,
      duration,
      sourceOffset,
      speed: 1,
      transform: { ...DEFAULT_TRANSFORM },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume,
      fadeInSec: fadeInSec === undefined ? undefined : Math.min(duration, fadeInSec),
      fadeOutSec: fadeOutSec === undefined ? undefined : Math.min(duration, fadeOutSec),
    };
    track.clips.push(clip);
    state.tracks.push(track);

    const mixer = ensureAudioMixer(state);
    mixer.trackRoles = { ...(mixer.trackRoles || {}), [trackId]: "music" };

    return {
      result: toolOk(`Created music track "${track.name}" at ${clip.startTime}s for ${duration}s (role=music)`, {
        trackId,
        clipId,
      }),
      state,
    };
  },

  set_track_audio_role: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const role = String(args.role || "").toLowerCase() as TrackAudioRole;
    if (role !== "music" && role !== "voice" && role !== "other") {
      return { result: 'Error: role must be "music", "voice", or "other"', state };
    }
    const mixer = ensureAudioMixer(state);
    mixer.trackRoles = { ...(mixer.trackRoles || {}), [track.id]: role };
    return { result: `Track "${track.name}" role set to ${role}`, state };
  },

  set_audio_duck: (args, state) => {
    if (typeof args.enabled !== "boolean") return { result: "Error: enabled must be a boolean", state };
    for (const key of ["level", "attackSec", "releaseSec"] as const) {
      if (args[key] !== undefined && (typeof args[key] !== "number" || !Number.isFinite(args[key]))) {
        return { result: `Error: ${key} must be a finite number`, state };
      }
    }
    if (args.mode !== undefined && args.mode !== "rule" && args.mode !== "sidechain") {
      return { result: 'Error: mode must be "rule" or "sidechain"', state };
    }
    const mixer = ensureAudioMixer(state);
    mixer.duck = normalizeDuckSettings({
      ...(mixer.duck || {}),
      enabled: args.enabled,
      mode: args.mode === "sidechain" ? "sidechain" : args.mode === "rule" ? "rule" : mixer.duck?.mode,
      level: args.level !== undefined ? args.level : mixer.duck?.level,
      attackSec:
        args.attackSec !== undefined ? args.attackSec : mixer.duck?.attackSec,
      releaseSec:
        args.releaseSec !== undefined ? args.releaseSec : mixer.duck?.releaseSec,
    });
    return {
      result: `Audio duck ${mixer.duck.enabled ? "enabled" : "disabled"} mode=${mixer.duck.mode || "rule"} (level=${mixer.duck.level}, attack=${mixer.duck.attackSec}s, release=${mixer.duck.releaseSec}s)`,
      state,
    };
  },

  set_track_eq: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const mixer = ensureAudioMixer(state);
    const eq = normalizeTrackEq({
      lowGainDb: args.lowGainDb,
      midGainDb: args.midGainDb,
      highGainDb: args.highGainDb,
    });
    mixer.trackEq = { ...(mixer.trackEq || {}), [track.id]: eq };
    return {
      result: `EQ on "${track.name}": low=${eq.lowGainDb} mid=${eq.midGainDb} high=${eq.highGainDb} dB`,
      state,
    };
  },

  set_track_audio_post: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const mixer = ensureAudioMixer(state);
    const current = normalizeTrackAudioPost(mixer.trackPost?.[track.id]);
    const post = normalizeTrackAudioPost({
      denoise: { enabled: args.denoiseEnabled ?? current.denoise.enabled, amount: args.denoiseAmount ?? current.denoise.amount },
      deEsser: { enabled: args.deEsserEnabled ?? current.deEsser.enabled, intensity: args.deEsserIntensity ?? current.deEsser.intensity, frequency: args.deEsserFrequency ?? current.deEsser.frequency },
      compressor: { enabled: args.compressorEnabled ?? current.compressor.enabled, thresholdDb: args.thresholdDb ?? current.compressor.thresholdDb, ratio: args.ratio ?? current.compressor.ratio, attackMs: args.attackMs ?? current.compressor.attackMs, releaseMs: args.releaseMs ?? current.compressor.releaseMs, makeupDb: args.makeupDb ?? current.compressor.makeupDb },
      limiter: { enabled: args.limiterEnabled ?? current.limiter.enabled, ceilingDb: args.ceilingDb ?? current.limiter.ceilingDb },
    });
    mixer.trackPost = { ...(mixer.trackPost || {}), [track.id]: post };
    return { result: JSON.stringify({ ok: true, trackId: track.id, post }), state };
  },

  apply_voice_post_preset: (args, state) => {
    const track = state.tracks.find((t) => t.id === args.trackId);
    if (!track) return { result: `Error: Track ${args.trackId} not found`, state };
    const preset = String(args.preset || "");
    const post = preset === "podcast"
      ? normalizeTrackAudioPost({ denoise: { enabled: true, amount: 10 }, deEsser: { enabled: true, intensity: 0.35, frequency: 0.55 }, compressor: { enabled: true, thresholdDb: -20, ratio: 3, attackMs: 12, releaseMs: 140, makeupDb: 3 }, limiter: { enabled: true, ceilingDb: -1 } })
      : preset === "aggressive-ad"
        ? normalizeTrackAudioPost({ denoise: { enabled: true, amount: 14 }, deEsser: { enabled: true, intensity: 0.5, frequency: 0.6 }, compressor: { enabled: true, thresholdDb: -24, ratio: 5, attackMs: 5, releaseMs: 80, makeupDb: 5 }, limiter: { enabled: true, ceilingDb: -1 } })
        : preset === "clean-dialogue"
          ? normalizeTrackAudioPost({ denoise: { enabled: true, amount: 8 }, deEsser: { enabled: true, intensity: 0.25, frequency: 0.5 }, compressor: { enabled: true, thresholdDb: -18, ratio: 2.5, attackMs: 15, releaseMs: 160, makeupDb: 2 }, limiter: { enabled: true, ceilingDb: -1 } })
          : null;
    if (!post) return { result: "Error: preset must be clean-dialogue, podcast, or aggressive-ad", state };
    const mixer = ensureAudioMixer(state);
    mixer.trackPost = { ...(mixer.trackPost || {}), [track.id]: post };
    mixer.trackRoles = { ...(mixer.trackRoles || {}), [track.id]: "voice" };
    return { result: JSON.stringify({ ok: true, trackId: track.id, preset, post }), state };
  },

  set_mastering: (args, state) => {
    const mixer = ensureAudioMixer(state);
    mixer.mastering = normalizeMastering({ ...(mixer.mastering || {}), limiterEnabled: args.limiterEnabled ?? mixer.mastering?.limiterEnabled, ceilingDb: args.ceilingDb ?? mixer.mastering?.ceilingDb, loudnessEnabled: args.loudnessEnabled ?? mixer.mastering?.loudnessEnabled, targetLufs: args.targetLufs ?? mixer.mastering?.targetLufs });
    return { result: JSON.stringify({ ok: true, mastering: mixer.mastering }), state };
  },
};
