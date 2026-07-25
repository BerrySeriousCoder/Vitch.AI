import type { MotionTrackSample, StabilizationSettings } from "@tempo/types";
import { normalizeMotionTrackSamples } from "./motion-track";

export const DEFAULT_STABILIZATION: Omit<StabilizationSettings, "samples"> = {
  enabled: false, smoothness: 0.65, cropScale: 1.08,
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;

export function normalizeStabilization(input?: Partial<StabilizationSettings> | null): StabilizationSettings | null {
  const samples = normalizeMotionTrackSamples(input?.samples);
  if (samples.length < 2) return null;
  return { enabled: Boolean(input?.enabled), samples, smoothness: clamp(input?.smoothness, 0, 1, DEFAULT_STABILIZATION.smoothness), cropScale: clamp(input?.cropScale, 1, 1.5, DEFAULT_STABILIZATION.cropScale) };
}

function interpolate(samples: MotionTrackSample[], time: number): MotionTrackSample {
  let left = samples[0]!; let right = samples[samples.length - 1]!;
  for (let index = 1; index < samples.length; index++) if (time <= samples[index]!.time) { left = samples[index - 1]!; right = samples[index]!; break; }
  const amount = Math.max(0, Math.min(1, (time - left.time) / Math.max(0.00001, right.time - left.time)));
  return { time, x: left.x + (right.x - left.x) * amount, y: left.y + (right.y - left.y) * amount };
}

/** Returns inverse normalized offset and edge-hiding crop for a stabilized clip. */
export function resolveStabilizationAtTime(input: StabilizationSettings | null | undefined, time: number): { offsetX: number; offsetY: number; cropScale: number } | null {
  const settings = normalizeStabilization(input);
  if (!settings?.enabled) return null;
  const samples = settings.samples;
  const raw = interpolate(samples, Math.max(0, time));
  const radius = Math.max(1, Math.round(1 + settings.smoothness * 8));
  const nearest = samples.reduce((best, sample, index) => Math.abs(sample.time - time) < Math.abs(samples[best]!.time - time) ? index : best, 0);
  const start = Math.max(0, nearest - radius); const end = Math.min(samples.length - 1, nearest + radius);
  let x = 0; let y = 0; let count = 0;
  for (let index = start; index <= end; index++) { x += samples[index]!.x; y += samples[index]!.y; count++; }
  return { offsetX: (x / count - raw.x) * settings.smoothness, offsetY: (y / count - raw.y) * settings.smoothness, cropScale: settings.cropScale };
}
