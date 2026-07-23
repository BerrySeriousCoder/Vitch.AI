import type { MasteringSettings, TrackAudioPostSettings } from "@tempo/types";

export const DEFAULT_TRACK_AUDIO_POST: TrackAudioPostSettings = {
  denoise: { enabled: false, amount: 12 },
  deEsser: { enabled: false, intensity: 0.35, frequency: 0.5 },
  compressor: { enabled: false, thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, makeupDb: 0 },
  limiter: { enabled: false, ceilingDb: -1 },
};

export const DEFAULT_MASTERING: MasteringSettings = {
  limiterEnabled: true, ceilingDb: -1, loudnessEnabled: false, targetLufs: -14,
};

const num = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;

export function normalizeTrackAudioPost(input?: Partial<TrackAudioPostSettings> | null): TrackAudioPostSettings {
  const source = input || {};
  return {
    denoise: { enabled: Boolean(source.denoise?.enabled), amount: num(source.denoise?.amount, DEFAULT_TRACK_AUDIO_POST.denoise.amount, 0.01, 40) },
    deEsser: { enabled: Boolean(source.deEsser?.enabled), intensity: num(source.deEsser?.intensity, DEFAULT_TRACK_AUDIO_POST.deEsser.intensity, 0, 1), frequency: num(source.deEsser?.frequency, DEFAULT_TRACK_AUDIO_POST.deEsser.frequency, 0, 1) },
    compressor: { enabled: Boolean(source.compressor?.enabled), thresholdDb: num(source.compressor?.thresholdDb, DEFAULT_TRACK_AUDIO_POST.compressor.thresholdDb, -60, 0), ratio: num(source.compressor?.ratio, DEFAULT_TRACK_AUDIO_POST.compressor.ratio, 1, 20), attackMs: num(source.compressor?.attackMs, DEFAULT_TRACK_AUDIO_POST.compressor.attackMs, 0, 1000), releaseMs: num(source.compressor?.releaseMs, DEFAULT_TRACK_AUDIO_POST.compressor.releaseMs, 10, 5000), makeupDb: num(source.compressor?.makeupDb, DEFAULT_TRACK_AUDIO_POST.compressor.makeupDb, -12, 24) },
    limiter: { enabled: Boolean(source.limiter?.enabled), ceilingDb: num(source.limiter?.ceilingDb, DEFAULT_TRACK_AUDIO_POST.limiter.ceilingDb, -12, 0) },
  };
}

export function normalizeMastering(input?: Partial<MasteringSettings> | null): MasteringSettings {
  return {
    limiterEnabled: input?.limiterEnabled ?? DEFAULT_MASTERING.limiterEnabled,
    ceilingDb: num(input?.ceilingDb, DEFAULT_MASTERING.ceilingDb, -12, 0),
    loudnessEnabled: Boolean(input?.loudnessEnabled),
    targetLufs: num(input?.targetLufs, DEFAULT_MASTERING.targetLufs, -30, -5),
  };
}

/** FFmpeg filters matching the persisted track cleanup/dynamics semantics. */
export function ffmpegAudioPostFilters(input?: Partial<TrackAudioPostSettings> | null): string[] {
  const post = normalizeTrackAudioPost(input);
  const filters: string[] = [];
  if (post.denoise.enabled) filters.push(`afftdn=nr=${post.denoise.amount.toFixed(2)}:nf=-50:tn=1`);
  if (post.deEsser.enabled) filters.push(`deesser=i=${post.deEsser.intensity.toFixed(3)}:m=0.7:f=${post.deEsser.frequency.toFixed(3)}`);
  if (post.compressor.enabled) filters.push(`acompressor=threshold=${Math.pow(10, post.compressor.thresholdDb / 20).toFixed(6)}:ratio=${post.compressor.ratio.toFixed(2)}:attack=${post.compressor.attackMs.toFixed(2)}:release=${post.compressor.releaseMs.toFixed(2)}:makeup=${Math.pow(10, post.compressor.makeupDb / 20).toFixed(6)}`);
  if (post.limiter.enabled) filters.push(`alimiter=limit=${Math.pow(10, post.limiter.ceilingDb / 20).toFixed(6)}:level=false`);
  return filters;
}

export function ffmpegMasteringFilters(input?: Partial<MasteringSettings> | null): string[] {
  const master = normalizeMastering(input);
  const filters: string[] = [];
  if (master.loudnessEnabled) filters.push(`loudnorm=I=${master.targetLufs.toFixed(1)}:TP=${master.ceilingDb.toFixed(1)}:LRA=11`);
  if (master.limiterEnabled) filters.push(`alimiter=limit=${Math.pow(10, master.ceilingDb / 20).toFixed(6)}:level=false`);
  return filters;
}
