import type { MotionTrack, MotionTrackSample } from "@tempo/types";

export const MAX_MOTION_TRACK_SAMPLES = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeMotionTrackSamples(
  samples: readonly MotionTrackSample[] | null | undefined
): MotionTrackSample[] {
  if (!Array.isArray(samples)) return [];
  const deduped = new Map<number, MotionTrackSample>();
  for (const raw of samples) {
    const time = Number(raw?.time);
    const x = Number(raw?.x);
    const y = Number(raw?.y);
    if (!Number.isFinite(time) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    deduped.set(Math.max(0, time), {
      time: Math.max(0, time),
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      scale: Number.isFinite(Number(raw.scale)) ? clamp(Number(raw.scale), 0.05, 20) : 1,
      rotation: Number.isFinite(Number(raw.rotation)) ? clamp(Number(raw.rotation), -3600, 3600) : 0,
      confidence: Number.isFinite(Number(raw.confidence)) ? clamp(Number(raw.confidence), 0, 1) : undefined,
    });
  }
  return [...deduped.values()].sort((a, b) => a.time - b.time).slice(0, MAX_MOTION_TRACK_SAMPLES);
}

export function normalizeMotionTrack(input: MotionTrack | null | undefined): MotionTrack | null {
  if (!input || typeof input !== "object" || !input.sourceClipId) return null;
  const samples = normalizeMotionTrackSamples(input.samples);
  if (samples.length < 2) return null;
  return {
    sourceClipId: String(input.sourceClipId),
    subject: String(input.subject || "subject").slice(0, 160),
    samples,
    useScale: input.useScale === true,
    useRotation: input.useRotation === true,
  };
}

export interface ResolvedMotionTrack {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  confidence?: number;
}

/** Linear interpolation with endpoint hold so sparse AI samples remain editable. */
export function resolveMotionTrackAtTime(
  track: MotionTrack | null | undefined,
  time: number
): ResolvedMotionTrack | null {
  const normalized = normalizeMotionTrack(track);
  if (!normalized) return null;
  const samples = normalized.samples;
  const t = Math.max(0, Number(time) || 0);
  let left = samples[0]!;
  let right = samples[samples.length - 1]!;
  for (let index = 1; index < samples.length; index++) {
    if (t <= samples[index]!.time) {
      right = samples[index]!;
      left = samples[index - 1]!;
      break;
    }
  }
  const span = Math.max(0.00001, right.time - left.time);
  const amount = clamp((t - left.time) / span, 0, 1);
  const mix = (a: number | undefined, b: number | undefined, fallback: number) =>
    (a ?? fallback) + ((b ?? fallback) - (a ?? fallback)) * amount;
  return {
    x: mix(left.x, right.x, 0.5),
    y: mix(left.y, right.y, 0.5),
    scale: mix(left.scale, right.scale, 1),
    rotation: mix(left.rotation, right.rotation, 0),
    confidence: mix(left.confidence, right.confidence, 1),
  };
}
