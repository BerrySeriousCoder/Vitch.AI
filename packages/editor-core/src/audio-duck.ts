import type {
  AudioDuckSettings,
  AudioMixer,
  Track,
  TrackAudioRole,
  TrackEqSettings,
} from "@tempo/types";

export const DEFAULT_AUDIO_DUCK: AudioDuckSettings = {
  enabled: false,
  mode: "rule",
  level: 0.25,
  attackSec: 0.12,
  releaseSec: 0.25,
};

export const DEFAULT_TRACK_EQ: TrackEqSettings = {
  lowGainDb: 0,
  midGainDb: 0,
  highGainDb: 0,
};

export type TimeInterval = { start: number; end: number };

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function normalizeDuckSettings(
  duck?: Partial<AudioDuckSettings> | null
): AudioDuckSettings {
  const mode = duck?.mode === "sidechain" ? "sidechain" : "rule";
  return {
    enabled: Boolean(duck?.enabled ?? DEFAULT_AUDIO_DUCK.enabled),
    mode,
    level: clamp(finiteNumber(duck?.level, DEFAULT_AUDIO_DUCK.level), 0, 1),
    attackSec: Math.max(
      0,
      finiteNumber(duck?.attackSec, DEFAULT_AUDIO_DUCK.attackSec)
    ),
    releaseSec: Math.max(
      0,
      finiteNumber(duck?.releaseSec, DEFAULT_AUDIO_DUCK.releaseSec)
    ),
  };
}

export function normalizeTrackEq(
  eq?: Partial<TrackEqSettings> | null
): TrackEqSettings {
  return {
    lowGainDb: clamp(finiteNumber(eq?.lowGainDb, 0), -12, 12),
    midGainDb: clamp(finiteNumber(eq?.midGainDb, 0), -12, 12),
    highGainDb: clamp(finiteNumber(eq?.highGainDb, 0), -12, 12),
  };
}

/** FFmpeg equalizer filter chain for 3-band EQ (no-op if flat). */
export function ffmpegEqFilters(eq: TrackEqSettings): string[] {
  const n = normalizeTrackEq(eq);
  const filters: string[] = [];
  if (Math.abs(n.lowGainDb) > 0.05) {
    filters.push(
      `equalizer=f=100:width_type=h:width=100:g=${n.lowGainDb.toFixed(2)}`
    );
  }
  if (Math.abs(n.midGainDb) > 0.05) {
    filters.push(
      `equalizer=f=1000:width_type=h:width=800:g=${n.midGainDb.toFixed(2)}`
    );
  }
  if (Math.abs(n.highGainDb) > 0.05) {
    filters.push(
      `equalizer=f=8000:width_type=h:width=2000:g=${n.highGainDb.toFixed(2)}`
    );
  }
  return filters;
}

export function getTrackRole(
  mixer: AudioMixer | null | undefined,
  trackId: string
): TrackAudioRole {
  const role = mixer?.trackRoles?.[trackId];
  if (role === "music" || role === "voice" || role === "other") return role;
  return "other";
}

export function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: TimeInterval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

export function coalesceIntervals(
  intervals: TimeInterval[],
  maxGap: number
): TimeInterval[] {
  if (intervals.length === 0) return [];
  const sorted = mergeIntervals(intervals);
  const out: TimeInterval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start - last.end <= maxGap) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

export interface VoiceWindowOptions {
  honorSolo?: boolean;
}

export function voiceActivityWindows(
  tracks: readonly Track[],
  mixer: AudioMixer | null | undefined,
  options: VoiceWindowOptions = {}
): TimeInterval[] {
  const honorSolo = options.honorSolo !== false;
  const anySolo = honorSolo && tracks.some((t) => t.solo);
  const intervals: TimeInterval[] = [];
  for (const track of tracks) {
    if (getTrackRole(mixer, track.id) !== "voice") continue;
    if (!track.visible) continue;
    if (mixer?.trackMutes?.[track.id]) continue;
    if (anySolo && !track.solo) continue;
    for (const clip of track.clips || []) {
      if (clip.muted) continue;
      const start = clip.startTime;
      const end = clip.startTime + clip.duration;
      if (end > start) intervals.push({ start, end });
    }
  }
  return mergeIntervals(intervals);
}

export function musicDuckBreakpoints(
  clipStart: number,
  clipDuration: number,
  voiceWindows: readonly TimeInterval[],
  duck: AudioDuckSettings
): Array<{ t: number; gain: number }> {
  if (!duck.enabled || clipDuration <= 0 || !Number.isFinite(duck.level)) {
    return [
      { t: 0, gain: 1 },
      { t: clipDuration, gain: 1 },
    ];
  }

  const level = clamp(duck.level, 0, 1);
  const attack = Math.max(0, duck.attackSec);
  const release = Math.max(0, duck.releaseSec);
  const clipEnd = clipStart + clipDuration;

  const relative: TimeInterval[] = [];
  for (const w of voiceWindows) {
    const overlapStart = Math.max(clipStart, w.start);
    const overlapEnd = Math.min(clipEnd, w.end);
    if (overlapEnd <= overlapStart) continue;
    relative.push({
      start: overlapStart - clipStart,
      end: overlapEnd - clipStart,
    });
  }

  const active = coalesceIntervals(relative, release);

  if (active.length === 0) {
    return [
      { t: 0, gain: 1 },
      { t: clipDuration, gain: 1 },
    ];
  }

  const points: Array<{ t: number; gain: number }> = [{ t: 0, gain: 1 }];
  for (const iv of active) {
    const s = clamp(iv.start, 0, clipDuration);
    const e = clamp(iv.end, 0, clipDuration);
    if (e <= s) continue;
    points.push({ t: s, gain: 1 });
    points.push({ t: clamp(s + attack, 0, clipDuration), gain: level });
    points.push({ t: e, gain: level });
    points.push({ t: clamp(e + release, 0, clipDuration), gain: 1 });
  }
  points.push({ t: clipDuration, gain: 1 });

  points.sort((a, b) => a.t - b.t);
  const out: Array<{ t: number; gain: number }> = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - p.t) < 1e-4) {
      last.gain = Math.min(last.gain, p.gain);
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

export function ffmpegVolumeExprFromBreakpoints(
  breakpoints: Array<{ t: number; gain: number }>,
  baseVolume: number
): string {
  const base = Math.max(0, Number.isFinite(baseVolume) ? baseVolume : 1);
  if (breakpoints.length < 2) return String(base);

  let pts = breakpoints;
  if (pts.length > 24) {
    const step = Math.ceil(pts.length / 20);
    pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }

  let expr = String(pts[pts.length - 1]!.gain * base);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const g0 = a.gain * base;
    const g1 = b.gain * base;
    const dt = Math.max(1e-6, b.t - a.t);
    const seg = `${g0}+(${g1}-${g0})*(t-${a.t.toFixed(4)})/${dt.toFixed(4)}`;
    expr = `if(between(t,${a.t.toFixed(4)},${b.t.toFixed(4)}),${seg},${expr})`;
  }
  return expr;
}

/**
 * FFmpeg sidechaincompress params from duck settings.
 * threshold ~0.02 is a gentle VO trigger; ratio maps from duck level.
 */
export function ffmpegSidechainCompressOpts(duck: AudioDuckSettings): string {
  const d = normalizeDuckSettings(duck);
  const ratio = Math.max(2, Math.min(20, 2 + (1 - d.level) * 16));
  const attackMs = Math.max(1, Math.round(d.attackSec * 1000));
  const releaseMs = Math.max(1, Math.round(d.releaseSec * 1000));
  return `threshold=0.02:ratio=${ratio.toFixed(2)}:attack=${attackMs}:release=${releaseMs}:level_sc=1:detection=rms`;
}
