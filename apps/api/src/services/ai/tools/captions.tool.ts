import type {
  CaptionBinding,
  Clip,
  MediaAsset,
  MediaAudioTranscript,
  Track,
  TranscriptSegment,
  TranscriptWord,
} from "@tempo/types";
import {
  CAPTION_PRESETS,
  applyCaptionPreset,
  getClipSourceRange,
  getCaptionPreset,
  mapSourceIntervalToTimeline,
  type TimeInterval,
} from "@tempo/editor-core";
import { randomUUID } from "crypto";
import type { ProjectState } from "./project-state.js";
import { refreshMediaAssets } from "./media-assets.js";

const DEFAULT_TRANSFORM = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0,
  anchorY: 0,
};

const SYNC_TOLERANCE_SEC = 0.001;

type CaptionStyle = "lower-third" | "center" | "karaoke" | "broadcast" | "minimal" | "podcast" | "social-pop";

type CaptionCueLayout = {
  maxWords: number;
  maxCharsPerLine: number;
  maxLines: number;
  maxDurationSec: number;
  gapSec: number;
};

type LocatedClip = { track: Track; clip: Clip };

type SourceCueWord = {
  id: string;
  text: string;
  start: number;
  end: number;
};

type SourceCue = {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  words: SourceCueWord[];
};

type MappedCue = SourceCue & {
  timelineStart: number;
  timelineEnd: number;
};

const STYLE_DEFAULTS: Partial<Record<
  CaptionStyle,
  {
    fontSize: number;
    fontFamily: string;
    color: string;
    textAlign: "left" | "center" | "right";
    fontWeight: string;
    y: number;
    stroke?: string;
    strokeWidth?: number;
    backgroundColor?: string;
  }
>> = {
  "lower-third": {
    fontSize: 36,
    fontFamily: "Inter, sans-serif",
    color: "#ffffff",
    textAlign: "center",
    fontWeight: "600",
    y: 280,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  center: {
    fontSize: 52,
    fontFamily: "Inter, sans-serif",
    color: "#ffffff",
    textAlign: "center",
    fontWeight: "700",
    y: 0,
    stroke: "#000000",
    strokeWidth: 2,
  },
  karaoke: {
    fontSize: 48,
    fontFamily: "Inter, sans-serif",
    color: "#ffffff",
    textAlign: "center",
    fontWeight: "800",
    y: 220,
    stroke: "#000000",
    strokeWidth: 3,
  },
};

function findAsset(state: ProjectState, mediaId: string): MediaAsset | undefined {
  return (state.mediaAssets || []).find((asset) => asset.id === mediaId);
}

function findClip(state: ProjectState, clipId: string): LocatedClip | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

function findSourceClip(state: ProjectState, clipId: string): LocatedClip | null {
  const found = findClip(state, clipId);
  if (!found?.clip.sourceMediaId) return null;
  if (found.track.type !== "audio" && found.track.type !== "video") return null;
  return found;
}

function transcriptRevision(transcript: MediaAudioTranscript): string {
  return transcript.revision || `legacy:${transcript.analyzedAt}`;
}

function seedBeatTimesFromAsset(state: ProjectState, asset: MediaAsset) {
  const beats = asset.metadata?.audioRhythm?.beats;
  if (beats?.length) {
    state.beatTimes = beats.map((beat) => beat.time).filter(Number.isFinite);
  }
}

function ensureCaptionsTrack(
  state: ProjectState,
  trackId?: string,
  name = "Captions"
): string {
  if (trackId) {
    const existing = state.tracks.find((track) => track.id === trackId);
    if (!existing) throw new Error(`Track ${trackId} not found`);
    if (existing.type !== "text") throw new Error(`Track ${trackId} is not a text track`);
    return trackId;
  }

  const found = state.tracks.find(
    (track) => track.type === "text" && /caption/i.test(track.name)
  );
  if (found) return found.id;

  const id = randomUUID();
  const textCount = state.tracks.filter((track) => track.type === "text").length;
  state.tracks.push({
    id,
    name: name || `Captions ${textCount + 1}`,
    type: "text",
    order: state.tracks.length,
    locked: false,
    visible: true,
    solo: false,
    clips: [],
  });
  return id;
}

function joinWords(words: SourceCueWord[]): string {
  let text = "";
  for (const word of words) {
    const token = word.text.trim();
    if (!token) continue;
    if (!text) text = token;
    else if (/^[,.;:!?%)}\]]/.test(token)) text += token;
    else if (/[({\[]$/.test(text)) text += token;
    else text += ` ${token}`;
  }
  return text;
}

function wordsFromTranscript(transcript: MediaAudioTranscript): SourceCueWord[] {
  return (transcript.words || [])
    .filter(
      (word): word is TranscriptWord =>
        Boolean(word.text.trim()) &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start
    )
    .map((word, index) => ({
      id: word.id || `word-${index}`,
      text: word.text,
      start: word.start,
      end: word.end,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function cueLayout(args: Record<string, any>, style: CaptionStyle): CaptionCueLayout {
  const preset = getCaptionPreset(style);
  const defaults = preset?.cue || { maxWords: 8, maxCharsPerLine: 32, maxLines: 2, maxDurationSec: 4.5, gapSec: 0.65 };
  const bounded = (value: unknown, min: number, max: number, fallback: number) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
  return {
    maxWords: Math.floor(bounded(args.maxWords, 1, 16, defaults.maxWords)),
    maxCharsPerLine: Math.floor(bounded(args.maxCharsPerLine, 12, 80, defaults.maxCharsPerLine)),
    maxLines: Math.floor(bounded(args.maxLines, 1, 3, defaults.maxLines)),
    maxDurationSec: bounded(args.maxDurationSec, 0.5, 8, defaults.maxDurationSec),
    gapSec: bounded(args.gapSec, 0.05, 2, defaults.gapSec),
  };
}

function joinCaptionToken(line: string, token: string): string {
  if (!line) return token;
  return /^[,.;:!?%)}\]]/.test(token) ? `${line}${token}` : `${line} ${token}`;
}

/** Wrap cue text at word boundaries so preview, export, and edit data agree. */
function wrapCueText(words: SourceCueWord[], maxCharsPerLine: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const token = word.text.trim();
    if (!token) continue;
    const candidate = joinCaptionToken(line, token);
    if (line && candidate.length > maxCharsPerLine) {
      lines.push(line);
      line = token;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function buildWordCues(words: SourceCueWord[], speed: number, layout: CaptionCueLayout): SourceCue[] {
  const cues: SourceCue[] = [];
  let current: SourceCueWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      text: wrapCueText(current, layout.maxCharsPerLine),
      sourceStart: current[0]!.start,
      sourceEnd: current[current.length - 1]!.end,
      words: current,
    });
    current = [];
  };

  for (const word of words) {
    const candidate = [...current, word];
    const text = wrapCueText(candidate, layout.maxCharsPerLine);
    const timelineDuration =
      candidate.length > 0
        ? (candidate[candidate.length - 1]!.end - candidate[0]!.start) / speed
        : 0;
    const gap = current.length > 0 ? word.start - current[current.length - 1]!.end : 0;
    const previousEndsPhrase = current.length > 0 && /[.!?]$/.test(current[current.length - 1]!.text);
    const shouldSplit =
      current.length > 0 &&
      (current.length >= layout.maxWords || text.split("\n").length > layout.maxLines || timelineDuration > layout.maxDurationSec || gap > layout.gapSec || previousEndsPhrase);

    if (shouldSplit) flush();
    current.push(word);

    if (/[.!?]$/.test(word.text) && current.length >= 3) flush();
  }
  flush();
  return cues;
}

function buildSegmentCues(segments: TranscriptSegment[]): SourceCue[] {
  return segments
    .filter(
      (segment) =>
        Boolean(segment.text.trim()) &&
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start
    )
    .map((segment, index) => ({
      text: segment.text.trim(),
      sourceStart: segment.start,
      sourceEnd: segment.end,
      words: [
        {
          id: segment.id || `segment-${index}`,
          text: segment.text.trim(),
          start: segment.start,
          end: segment.end,
        },
      ],
    }));
}

function mappedCuesForClip(
  transcript: MediaAudioTranscript,
  sourceClip: Clip,
  layout: CaptionCueLayout = cueLayout({}, "lower-third")
): MappedCue[] {
  const sourceWords = wordsFromTranscript(transcript).filter((word) =>
    Boolean(mapSourceIntervalToTimeline(sourceClip, [word.start, word.end]))
  );
  const sourceCues =
    sourceWords.length > 0
      ? buildWordCues(sourceWords, sourceClip.speed, layout)
      : buildSegmentCues(transcript.segments);

  const mapped: MappedCue[] = [];
  for (const cue of sourceCues) {
    const interval = mapSourceIntervalToTimeline(sourceClip, [cue.sourceStart, cue.sourceEnd]);
    if (!interval || interval[1] - interval[0] < 0.04) continue;
    const sourceRange = getClipSourceRange(sourceClip);
    mapped.push({
      ...cue,
      sourceStart: Math.max(cue.sourceStart, sourceRange[0]),
      sourceEnd: Math.min(cue.sourceEnd, sourceRange[1]),
      timelineStart: interval[0],
      timelineEnd: interval[1],
    });
  }
  return mapped;
}

function styleKey(value: unknown): CaptionStyle {
  return value === "center" || value === "karaoke" || value === "lower-third" || value === "broadcast" || value === "minimal" || value === "podcast" || value === "social-pop"
    ? value
    : "lower-third";
}

function createCaptionClip(params: {
  cue: MappedCue;
  sourceClip: Clip;
  sourceMediaId: string;
  transcript: MediaAudioTranscript;
  trackId: string;
  style: CaptionStyle;
  args: Record<string, any>;
}): Clip {
  const { cue, sourceClip, sourceMediaId, transcript, trackId, args } = params;
  const style = STYLE_DEFAULTS[params.style] || STYLE_DEFAULTS["lower-third"]!;
  const preset = getCaptionPreset(params.style);
  const binding: CaptionBinding = {
    sourceClipId: sourceClip.id,
    sourceMediaId,
    transcriptRevision: transcriptRevision(transcript),
    sourceStart: cue.sourceStart,
    sourceEnd: cue.sourceEnd,
    wordIds: cue.words.map((word) => word.id),
    generatedTiming: true,
  };
  const duration = cue.timelineEnd - cue.timelineStart;
  const karaokeWords =
    params.style === "karaoke"
      ? cue.words.flatMap((word) => {
          const mapped = mapSourceIntervalToTimeline(sourceClip, [word.start, word.end]);
          if (!mapped) return [];
          return [
            {
              text: word.text.trim(),
              start: Math.max(0, mapped[0] - cue.timelineStart),
              end: Math.min(duration, mapped[1] - cue.timelineStart),
            },
          ];
        })
      : undefined;

  return {
    id: randomUUID(),
    trackId,
    sourceMediaId: null,
    startTime: cue.timelineStart,
    duration,
    sourceOffset: 0,
    speed: 1,
    transform: { ...DEFAULT_TRANSFORM, y: style.y },
    opacity: 1,
    blendMode: "normal",
    effects: [],
    keyframes: [],
    mask: null,
    muted: false,
    volume: 1,
    captionBinding: binding,
    textParams: (() => {
      const textParams = {
      text: cue.text,
      fontSize: args.fontSize ?? preset?.params.fontSize ?? style.fontSize,
      fontFamily: args.fontFamily || preset?.params.fontFamily || style.fontFamily,
      color: args.color || preset?.params.color || style.color,
      textAlign: style.textAlign,
      fontWeight: preset?.params.fontWeight || style.fontWeight,
      lineHeight: preset?.params.lineHeight ?? 1.25,
      ...(preset?.params || {}),
      ...(style.stroke && !preset ? { stroke: style.stroke } : {}),
      ...(style.strokeWidth !== undefined && !preset ? { strokeWidth: style.strokeWidth } : {}),
      ...(style.backgroundColor && !preset ? { backgroundColor: style.backgroundColor } : {}),
      ...(karaokeWords
        ? {
            karaokeWords,
            karaokeActiveColor: args.color || "#ffe566",
            karaokeInactiveColor: "#ffffff",
          }
        : {}),
      };
      return preset ? applyCaptionPreset(textParams, preset.id, duration)! : textParams;
    })(),
  };
}

function transcriptError(asset: MediaAsset): string | null {
  const status = asset.metadata?.audioAnalysisStatus;
  const transcript = asset.metadata?.audioTranscript;
  if (status === "pending") return "Audio transcript still pending. Wait for analysis or re-analyze the media.";
  if (status === "error" || transcript?.error) {
    return `Audio transcript analysis failed${transcript?.error ? `: ${transcript.error}` : ""}. Re-analyze before creating captions.`;
  }
  if (!transcript) return "No audio transcript exists on this media. Re-analyze it first.";
  if (transcript.kind === "music_instrumental" || transcript.segments.length === 0) {
    return `No captionable transcript (kind=${transcript.kind}, segments=${transcript.segments.length}).`;
  }
  return null;
}

async function createForSourceClip(
  args: Record<string, any>,
  state: ProjectState,
  forceReplace = false
): Promise<{ result: string; state: ProjectState }> {
  await refreshMediaAssets(state);
  const located = findSourceClip(state, String(args.sourceClipId || ""));
  if (!located) {
    return { result: `Error: Caption source clip ${args.sourceClipId || "(missing)"} not found on an audio/video track`, state };
  }

  const sourceMediaId = located.clip.sourceMediaId!;
  const asset = findAsset(state, sourceMediaId);
  if (!asset) return { result: `Error: Media ${sourceMediaId} not found`, state };
  const error = transcriptError(asset);
  if (error) return { result: `Error: ${error}`, state };
  const transcript = asset.metadata.audioTranscript!;

  let trackId: string;
  try {
    trackId = ensureCaptionsTrack(state, args.trackId, args.trackName || "Captions");
  } catch (err: any) {
    return { result: `Error: ${err.message}`, state };
  }
  const track = state.tracks.find((candidate) => candidate.id === trackId)!;
  if (forceReplace || args.replaceForSourceClip !== false) {
    track.clips = track.clips.filter(
      (clip) => clip.captionBinding?.sourceClipId !== located.clip.id
    );
  }

  const style = styleKey(args.style);
  const cues = mappedCuesForClip(transcript, located.clip, cueLayout(args, style));
  const requestedLimit = Number(args.maxCaptions);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : Number.POSITIVE_INFINITY;
  const selected = cues.slice(0, limit);
  const created = selected.map((cue) =>
    createCaptionClip({
      cue,
      sourceClip: located.clip,
      sourceMediaId,
      transcript,
      trackId,
      style,
      args,
    })
  );
  track.clips.push(...created);
  track.clips.sort((a, b) => a.startTime - b.startTime);

  const sourceRange = getClipSourceRange(located.clip);
  const warnings = [
    ...(transcript.warnings || []),
    ...(selected.length < cues.length
      ? [`Generation limited to ${selected.length}/${cues.length} audible cues.`]
      : []),
  ];
  return {
    result: JSON.stringify(
      {
        created: created.length,
        sourceClipId: located.clip.id,
        mediaId: sourceMediaId,
        trackId,
        style,
        sourceRange: sourceRange.map((time) => Number(time.toFixed(3))),
        timelineRange: [
          Number(located.clip.startTime.toFixed(3)),
          Number((located.clip.startTime + located.clip.duration).toFixed(3)),
        ],
        speed: located.clip.speed,
        transcriptRevision: transcriptRevision(transcript),
        coverageComplete: selected.length === cues.length,
        warnings,
        captionIds: created.map((clip) => clip.id),
        next: "Call validate_caption_sync with this sourceClipId before claiming completion.",
      },
      null,
      2
    ),
    state,
  };
}

function nearestBeat(
  time: number,
  beats: number[],
  preferDownbeat: boolean,
  downbeats: Set<number>
): number {
  if (beats.length === 0) return time;
  let best = beats[0]!;
  let bestDistance = Math.abs(best - time);
  for (const beat of beats) {
    const distance = Math.abs(beat - time);
    const prefer =
      preferDownbeat && downbeats.has(beat) && !downbeats.has(best)
        ? distance <= bestDistance + 0.08
        : distance < bestDistance;
    if (prefer) {
      best = beat;
      bestDistance = distance;
    }
  }
  return best;
}

export const captionsToolDefinitions = [
  {
    name: "list_caption_presets",
    description: "List the built-in reusable caption-graphics looks and their safe cue-layout defaults.",
    parameters: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "list_caption_sources",
    description:
      "List captionable audio/video clips currently placed on the timeline. Returns each sourceClipId with its exact timeline range, source-media range, speed, transcript revision, and status. Use this before captioning when the desired clip is not already unambiguous.",
    parameters: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_audio_timeline",
    description:
      "Return stored source-media beat and transcript facts for a media asset. This is analysis data, not timeline-mapped caption timing. Use get_clip_transcript for an edited timeline clip.",
    parameters: {
      type: "object" as const,
      properties: {
        mediaId: { type: "string" },
        maxBeats: { type: "number" },
        maxSegments: { type: "number" },
        maxWords: { type: "number" },
      },
      required: ["mediaId"],
    },
  },
  {
    name: "get_clip_transcript",
    description:
      "Return transcript words/segments mapped deterministically to one timeline audio/video clip, accounting for sourceOffset, trims, timeline start, and speed. Never calculate these offsets yourself.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string" },
        granularity: { type: "string", enum: ["word", "segment", "cue"] },
        cursor: { type: "number", description: "Zero-based result cursor" },
        limit: { type: "number", description: "Page size, default 100, max 300" },
      },
      required: ["sourceClipId"],
    },
  },
  {
    name: "search_transcript",
    description: "Find source transcript segments matching a phrase (case-insensitive).",
    parameters: {
      type: "object" as const,
      properties: { mediaId: { type: "string" }, query: { type: "string" } },
      required: ["mediaId", "query"],
    },
  },
  {
    name: "create_captions_for_clip",
    description:
      "Create synchronized captions for one concrete timeline audio/video clip. Timing is derived from sourceClipId, including sourceOffset, trims, splits, and speed. Defaults to replacing only captions previously bound to this source clip.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string" },
        style: { type: "string", enum: ["lower-third", "center", "karaoke", "broadcast", "minimal", "podcast", "social-pop"] },
        trackId: { type: "string" },
        trackName: { type: "string" },
        maxCaptions: { type: "number" },
        fontSize: { type: "number" },
        fontFamily: { type: "string" },
        color: { type: "string" },
        maxWords: { type: "number", description: "1..16 visible words per cue" },
        maxCharsPerLine: { type: "number", description: "12..80 characters per line" },
        maxLines: { type: "number", description: "1..3 lines per cue" },
        maxDurationSec: { type: "number", description: "0.5..8 seconds before a cue is split" },
        gapSec: { type: "number", description: "0.05..2 seconds gap that starts a new cue" },
        replaceForSourceClip: { type: "boolean" },
      },
      required: ["sourceClipId"],
    },
  },
  {
    name: "regenerate_captions_for_clip",
    description:
      "Regenerate synchronized captions bound to a timeline source clip after trims, speed changes, splits, transcript updates, or style changes.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string" },
        style: { type: "string", enum: ["lower-third", "center", "karaoke", "broadcast", "minimal", "podcast", "social-pop"] },
        trackId: { type: "string" },
        fontSize: { type: "number" },
        fontFamily: { type: "string" },
        color: { type: "string" },
        maxWords: { type: "number" }, maxCharsPerLine: { type: "number" }, maxLines: { type: "number" }, maxDurationSec: { type: "number" }, gapSec: { type: "number" },
      },
      required: ["sourceClipId"],
    },
  },
  {
    name: "apply_caption_preset",
    description: "Apply a reusable caption-graphics look to existing bound captions without touching their transcript text, timing, or provenance. social-pop uses word animation and therefore frame export.",
    parameters: {
      type: "object" as const,
      properties: {
        presetId: { type: "string", enum: ["broadcast", "minimal", "podcast", "social-pop", "karaoke"] },
        trackId: { type: "string", description: "Optional text/caption track scope" },
        sourceClipId: { type: "string", description: "Optional source-clip scope" },
        clipIds: { type: "array", items: { type: "string" }, description: "Optional explicit caption ids" },
      },
      required: ["presetId"],
    },
  },
  {
    name: "validate_caption_sync",
    description:
      "Validate bound captions against their source clip and transcript revision. Reports stale, missing, trimmed-away, or mistimed captions. Call after caption creation and before claiming sync is complete.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string" },
        trackId: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "create_captions_from_transcript",
    description:
      "Deprecated compatibility tool. Prefer create_captions_for_clip with sourceClipId. mediaId + timeOffset cannot account for source trims or speed.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string" },
        mediaId: { type: "string" },
        style: { type: "string", enum: ["lower-third", "center", "karaoke", "broadcast", "minimal", "podcast", "social-pop"] },
        timeOffset: { type: "number" },
        trackId: { type: "string" },
        trackName: { type: "string" },
        maxCaptions: { type: "number" },
        fontSize: { type: "number" },
        fontFamily: { type: "string" },
        color: { type: "string" },
        replaceExisting: { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "snap_captions_to_beats",
    description:
      "Explicit creative effect that offsets caption starts toward musical beats. This can reduce vocal sync and is never part of automatic caption synchronization. The introduced offset is recorded in caption provenance.",
    parameters: {
      type: "object" as const,
      properties: {
        clipIds: { type: "array", items: { type: "string" } },
        mediaId: { type: "string" },
        sourceClipId: { type: "string" },
        preferDownbeat: { type: "boolean" },
        maxDelta: { type: "number", description: "Default 0.12s; maximum 0.2s" },
      },
      required: [],
    },
  },
];

type CaptionToolResult = { result: string; state: ProjectState };

export const captionsToolExecutors: Record<
  string,
  (args: Record<string, any>, state: ProjectState) => Promise<CaptionToolResult>
> = {
  list_caption_presets: async (_args, state) => ({
    result: JSON.stringify({ presets: CAPTION_PRESETS.map(({ id, name, description, cue }) => ({ id, name, description, cue })) }, null, 2),
    state,
  }),
  list_caption_sources: async (_args, state) => {
    await refreshMediaAssets(state);
    const sources = state.tracks
      .filter((track) => track.type === "audio" || track.type === "video")
      .flatMap((track) =>
        track.clips.flatMap((clip) => {
          if (!clip.sourceMediaId) return [];
          const asset = findAsset(state, clip.sourceMediaId);
          const sourceRange = getClipSourceRange(clip);
          return [
            {
              sourceClipId: clip.id,
              trackId: track.id,
              trackName: track.name,
              mediaId: clip.sourceMediaId,
              mediaName: asset?.name || "unknown",
              timelineRange: [clip.startTime, clip.startTime + clip.duration],
              sourceRange,
              speed: clip.speed,
              transcriptRevision: asset?.metadata.audioTranscript
                ? transcriptRevision(asset.metadata.audioTranscript)
                : null,
              status: asset?.metadata.audioAnalysisStatus || "none",
              captionable: asset ? !transcriptError(asset) : false,
            },
          ];
        })
      );
    return { result: JSON.stringify({ sources }, null, 2), state };
  },

  get_audio_timeline: async (args, state) => {
    await refreshMediaAssets(state);
    const asset = findAsset(state, args.mediaId);
    if (!asset) return { result: `Error: Media ${args.mediaId} not found`, state };
    const rhythm = asset.metadata?.audioRhythm;
    const transcript = asset.metadata?.audioTranscript;
    if (rhythm?.beats?.length) seedBeatTimesFromAsset(state, asset);
    const maxBeats = Math.min(Math.max(Number(args.maxBeats) || 80, 1), 300);
    const maxSegments = Math.min(Math.max(Number(args.maxSegments) || 80, 1), 300);
    const maxWords = Math.min(Math.max(Number(args.maxWords) || 120, 1), 500);
    return {
      result: JSON.stringify(
        {
          mediaId: asset.id,
          name: asset.name,
          duration: asset.duration ?? asset.metadata?.duration ?? null,
          audioAnalysisStatus: asset.metadata?.audioAnalysisStatus || "none",
          rhythm: rhythm
            ? {
                bpm: rhythm.bpm,
                mood: rhythm.mood,
                genre: rhythm.genre,
                beatCount: rhythm.beats.length,
                beats: rhythm.beats.slice(0, maxBeats),
                beatsTruncated: rhythm.beats.length > maxBeats,
              }
            : null,
          transcript: transcript
            ? {
                schemaVersion: transcript.schemaVersion || 1,
                revision: transcriptRevision(transcript),
                kind: transcript.kind,
                language: transcript.language,
                summary: transcript.summary,
                wordCount: transcript.words?.length || 0,
                segmentCount: transcript.segments.length,
                words: (transcript.words || []).slice(0, maxWords),
                segments: transcript.segments.slice(0, maxSegments),
                wordsTruncated: (transcript.words?.length || 0) > maxWords,
                segmentsTruncated: transcript.segments.length > maxSegments,
                warnings: transcript.warnings || [],
                error: transcript.error,
              }
            : null,
          guidance:
            "Source times are analysis facts. For timeline captions, select a sourceClipId and use create_captions_for_clip; do not add offsets manually.",
        },
        null,
        2
      ),
      state,
    };
  },

  get_clip_transcript: async (args, state) => {
    await refreshMediaAssets(state);
    const located = findSourceClip(state, String(args.sourceClipId || ""));
    if (!located) return { result: `Error: Source clip ${args.sourceClipId} not found`, state };
    const asset = findAsset(state, located.clip.sourceMediaId!);
    if (!asset) return { result: `Error: Media ${located.clip.sourceMediaId} not found`, state };
    const error = transcriptError(asset);
    if (error) return { result: `Error: ${error}`, state };
    const transcript = asset.metadata.audioTranscript!;
    const granularity = args.granularity || "cue";
    let mapped: Array<Record<string, unknown>>;

    if (granularity === "word" && transcript.words?.length) {
      mapped = transcript.words.flatMap((word) => {
        const interval = mapSourceIntervalToTimeline(located.clip, [word.start, word.end]);
        return interval
          ? [{ id: word.id, text: word.text, source: [word.start, word.end], timeline: interval }]
          : [];
      });
    } else if (granularity === "segment") {
      mapped = transcript.segments.flatMap((segment, index) => {
        const interval = mapSourceIntervalToTimeline(located.clip, [segment.start, segment.end]);
        return interval
          ? [{ id: segment.id || `segment-${index}`, text: segment.text, source: [segment.start, segment.end], timeline: interval }]
          : [];
      });
    } else {
      mapped = mappedCuesForClip(transcript, located.clip).map((cue, index) => ({
        id: `cue-${index}`,
        text: cue.text,
        source: [cue.sourceStart, cue.sourceEnd],
        timeline: [cue.timelineStart, cue.timelineEnd],
        wordIds: cue.words.map((word) => word.id),
      }));
    }

    const cursor = Math.max(0, Math.floor(Number(args.cursor) || 0));
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 100), 1), 300);
    const page = mapped.slice(cursor, cursor + limit);
    return {
      result: JSON.stringify(
        {
          sourceClipId: located.clip.id,
          mediaId: located.clip.sourceMediaId,
          sourceRange: getClipSourceRange(located.clip),
          timelineRange: [located.clip.startTime, located.clip.startTime + located.clip.duration],
          speed: located.clip.speed,
          granularity,
          total: mapped.length,
          cursor,
          nextCursor: cursor + page.length < mapped.length ? cursor + page.length : null,
          items: page,
        },
        null,
        2
      ),
      state,
    };
  },

  search_transcript: async (args, state) => {
    await refreshMediaAssets(state);
    const asset = findAsset(state, args.mediaId);
    if (!asset) return { result: `Error: Media ${args.mediaId} not found`, state };
    const query = String(args.query || "").toLowerCase().trim();
    if (!query) return { result: "Error: query required", state };
    const transcript = asset.metadata.audioTranscript;
    if (!transcript) {
      return { result: `Error: ${asset.name} has no transcript metadata; analyze its audio before searching`, state };
    }
    if (transcript.error && transcript.segments.length === 0) {
      return { result: `Error: transcript unavailable for ${asset.name}: ${transcript.error}`, state };
    }
    const hits = transcript.segments.filter((segment) =>
      segment.text.toLowerCase().includes(query)
    );
    if (hits.length === 0) return { result: `No transcript matches for "${args.query}" on ${asset.name}`, state };
    return {
      result: `${hits.length} match(es) on "${asset.name}":\n${hits
        .slice(0, 30)
        .map((segment) => `- [${segment.start.toFixed(2)}–${segment.end.toFixed(2)}] ${segment.text}`)
        .join("\n")}`,
      state,
    };
  },

  create_captions_for_clip: async (args, state) => createForSourceClip(args, state),
  regenerate_captions_for_clip: async (args, state) => createForSourceClip(args, state, true),

  apply_caption_preset: async (args, state) => {
    const preset = getCaptionPreset(args.presetId);
    if (!preset) return { result: `Error: Unknown caption preset ${String(args.presetId)}`, state };
    const wantedIds = new Set(Array.isArray(args.clipIds) ? args.clipIds.map(String) : []);
    const candidates = state.tracks
      .filter((track) => !args.trackId || track.id === args.trackId)
      .flatMap((track) => track.clips)
      .filter((clip) => Boolean(clip.textParams) && Boolean(clip.captionBinding))
      .filter((clip) => wantedIds.size === 0 || wantedIds.has(clip.id))
      .filter((clip) => !args.sourceClipId || clip.captionBinding?.sourceClipId === args.sourceClipId);
    if (candidates.length === 0) return { result: "Error: No bound caption clips matched the requested scope", state };
    for (const clip of candidates) clip.textParams = applyCaptionPreset(clip.textParams!, preset.id, clip.duration)!;
    return { result: JSON.stringify({ ok: true, presetId: preset.id, updated: candidates.length, captionIds: candidates.map((clip) => clip.id), note: preset.id === "social-pop" ? "Animated captions use the Chromium frame-export path." : undefined }), state };
  },

  validate_caption_sync: async (args, state) => {
    await refreshMediaAssets(state);
    const selectedTracks = args.trackId
      ? state.tracks.filter((track) => track.id === args.trackId)
      : state.tracks.filter((track) => track.type === "text");
    const captions = selectedTracks.flatMap((track) => track.clips).filter((clip) => {
      if (!clip.captionBinding) return false;
      return !args.sourceClipId || clip.captionBinding.sourceClipId === args.sourceClipId;
    });
    if (captions.length === 0) {
      return { result: "Error: No bound captions found for the requested scope", state };
    }

    const issues: Array<Record<string, unknown>> = [];
    let valid = 0;
    for (const caption of captions) {
      const binding = caption.captionBinding!;
      const source = findSourceClip(state, binding.sourceClipId);
      if (!source) {
        issues.push({ captionId: caption.id, code: "source_clip_missing" });
        continue;
      }
      const asset = findAsset(state, binding.sourceMediaId);
      const transcript = asset?.metadata.audioTranscript;
      if (!transcript) {
        issues.push({ captionId: caption.id, code: "transcript_missing" });
        continue;
      }
      if (transcriptRevision(transcript) !== binding.transcriptRevision) {
        issues.push({ captionId: caption.id, code: "transcript_revision_stale" });
        continue;
      }
      const expected = mapSourceIntervalToTimeline(source.clip, [binding.sourceStart, binding.sourceEnd]);
      if (!expected) {
        issues.push({ captionId: caption.id, code: "caption_over_trimmed_audio" });
        continue;
      }
      const intentionalOffset = (binding.intentionalOffsetMs || 0) / 1000;
      const expectedStart = expected[0] + intentionalOffset;
      const expectedEnd = expected[1] + intentionalOffset;
      const actualEnd = caption.startTime + caption.duration;
      const startErrorMs = (caption.startTime - expectedStart) * 1000;
      const endErrorMs = (actualEnd - expectedEnd) * 1000;
      if (
        Math.abs(startErrorMs) > SYNC_TOLERANCE_SEC * 1000 ||
        Math.abs(endErrorMs) > SYNC_TOLERANCE_SEC * 1000 ||
        binding.stale
      ) {
        issues.push({
          captionId: caption.id,
          code: binding.stale ? "caption_marked_stale" : "timing_mismatch",
          startErrorMs: Number(startErrorMs.toFixed(3)),
          endErrorMs: Number(endErrorMs.toFixed(3)),
        });
        continue;
      }
      valid++;
    }

    return {
      result: JSON.stringify(
        {
          ok: issues.length === 0,
          checked: captions.length,
          valid,
          issueCount: issues.length,
          toleranceMs: SYNC_TOLERANCE_SEC * 1000,
          issues,
          guidance:
            issues.length === 0
              ? "Caption timing is structurally synchronized to the selected source clip."
              : "Regenerate captions for affected source clips before claiming synchronization is complete.",
        },
        null,
        2
      ),
      state,
    };
  },

  create_captions_from_transcript: async (args, state) => {
    if (args.sourceClipId) return createForSourceClip(args, state);
    await refreshMediaAssets(state);
    const matching = state.tracks
      .filter((track) => track.type === "audio" || track.type === "video")
      .flatMap((track) => track.clips)
      .filter((clip) => clip.sourceMediaId === args.mediaId);
    if (matching.length === 1) {
      return createForSourceClip(
        {
          ...args,
          sourceClipId: matching[0]!.id,
          replaceForSourceClip: args.replaceExisting !== false,
        },
        state
      );
    }
    if (matching.length > 1) {
      return {
        result: `Error: Media ${args.mediaId} is used by ${matching.length} timeline clips. Pass sourceClipId; timeOffset is ambiguous and unsafe.`,
        state,
      };
    }
    return {
      result:
        "Error: Deprecated mediaId + timeOffset captioning requires the media to be placed exactly once on the timeline. Add/select the audio clip and pass sourceClipId.",
      state,
    };
  },

  snap_captions_to_beats: async (args, state) => {
    await refreshMediaAssets(state);
    let asset: MediaAsset | undefined;
    let sourceClip: Clip | undefined;
    if (args.sourceClipId) {
      const located = findSourceClip(state, args.sourceClipId);
      if (!located) return { result: `Error: Source clip ${args.sourceClipId} not found`, state };
      sourceClip = located.clip;
      asset = findAsset(state, located.clip.sourceMediaId!);
    } else if (args.mediaId) {
      asset = findAsset(state, args.mediaId);
    }
    if (asset) seedBeatTimesFromAsset(state, asset);
    const rhythmBeats = asset?.metadata.audioRhythm?.beats || [];
    const beats = rhythmBeats.length ? rhythmBeats.map((beat) => beat.time) : state.beatTimes || [];
    const downbeats = new Set(rhythmBeats.filter((beat) => beat.isDownbeat).map((beat) => beat.time));
    if (beats.length === 0) return { result: "Error: No beat grid available", state };

    let clipIds: string[] = Array.isArray(args.clipIds) ? args.clipIds : [];
    if (clipIds.length === 0) {
      clipIds = state.tracks
        .filter((track) => track.type === "text" && /caption/i.test(track.name))
        .flatMap((track) => track.clips)
        .filter((clip) => !sourceClip || clip.captionBinding?.sourceClipId === sourceClip.id)
        .map((clip) => clip.id);
    }
    const preferDownbeat = args.preferDownbeat !== false;
    const maxDelta = Math.min(
      Math.max(Number.isFinite(Number(args.maxDelta)) ? Number(args.maxDelta) : 0.12, 0),
      0.2
    );
    const changes: Array<Record<string, unknown>> = [];

    for (const id of clipIds) {
      const caption = findClip(state, id)?.clip;
      if (!caption?.textParams) continue;
      const binding = caption.captionBinding;
      const boundSource = binding ? findSourceClip(state, binding.sourceClipId)?.clip : sourceClip;
      if (!boundSource) {
        changes.push({ captionId: id, status: "skipped_unbound" });
        continue;
      }
      const sourceTime =
        boundSource.sourceOffset + (caption.startTime - boundSource.startTime) * boundSource.speed;
      const snappedSource = nearestBeat(sourceTime, beats, preferDownbeat, downbeats);
      const snappedInterval = mapSourceIntervalToTimeline(boundSource, [
        snappedSource,
        snappedSource + Math.max(0.001, caption.duration * boundSource.speed),
      ]);
      if (!snappedInterval) continue;
      const delta = snappedInterval[0] - caption.startTime;
      if (Math.abs(delta) > maxDelta) {
        changes.push({ captionId: id, status: "kept", nearestDeltaMs: Math.round(delta * 1000) });
        continue;
      }
      caption.startTime += delta;
      if (binding) binding.intentionalOffsetMs = (binding.intentionalOffsetMs || 0) + delta * 1000;
      changes.push({ captionId: id, status: "offset", deltaMs: Math.round(delta * 1000) });
    }

    return {
      result: JSON.stringify(
        {
          warning: "Creative beat offsets were applied to captions; this is not vocal synchronization.",
          maxDeltaMs: Math.round(maxDelta * 1000),
          changes,
        },
        null,
        2
      ),
      state,
    };
  },
};
