import type { AudioAutomation, AudioAutomationPoint, AudioMixer, Clip } from "@tempo/types";

export type AudioAutomationProperty = "volume" | "pan";
export type AudioAutomationBreakpoint = { t: number; value: number; interpolation?: "linear" | "hold" };

const EPSILON = 1e-4;

function finite(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function audioAutomationBounds(property: AudioAutomationProperty): [number, number] {
  return property === "volume" ? [0, 2] : [-1, 1];
}

/**
 * Sanitise imported/user-authored points, sort them, and coalesce equal times.
 * The later point wins, matching a normal keyframe edit at the same frame.
 */
export function normalizeAudioAutomationPoints(
  points: readonly AudioAutomationPoint[] | null | undefined,
  property: AudioAutomationProperty,
  duration?: number
): AudioAutomationPoint[] {
  const [min, max] = audioAutomationBounds(property);
  const maximumTime = Number.isFinite(duration) ? Math.max(0, duration!) : Number.POSITIVE_INFINITY;
  const sorted = (points || [])
    .filter((point): point is AudioAutomationPoint => Boolean(point) && Number.isFinite(Number(point.time)))
    .map((point) => ({
      ...(point.id ? { id: point.id } : {}),
      time: clamp(finite(point.time, 0), 0, maximumTime),
      value: clamp(finite(point.value, property === "volume" ? 1 : 0), min, max),
      interpolation: point.interpolation === "hold" ? "hold" as const : "linear" as const,
    }))
    .sort((a, b) => a.time - b.time);

  const result: AudioAutomationPoint[] = [];
  for (const point of sorted) {
    const last = result[result.length - 1];
    if (last && Math.abs(last.time - point.time) < EPSILON) {
      result[result.length - 1] = point;
    } else {
      result.push(point);
    }
  }
  return result;
}

export function normalizeAudioAutomation(
  automation: AudioAutomation | null | undefined,
  duration?: number
): AudioAutomation {
  return {
    volume: normalizeAudioAutomationPoints(automation?.volume, "volume", duration),
    pan: normalizeAudioAutomationPoints(automation?.pan, "pan", duration),
  };
}

export function audioAutomationValueAt(
  points: readonly AudioAutomationPoint[] | null | undefined,
  property: AudioAutomationProperty,
  time: number,
  fallback?: number
): number {
  const defaultValue = fallback ?? (property === "volume" ? 1 : 0);
  const normalized = normalizeAudioAutomationPoints(points, property);
  if (!normalized.length) return defaultValue;
  const t = Math.max(0, finite(time, 0));
  if (t <= normalized[0]!.time) return normalized[0]!.value;
  for (let i = 0; i < normalized.length - 1; i++) {
    const start = normalized[i]!;
    const end = normalized[i + 1]!;
    if (t <= end.time) {
      if (start.interpolation === "hold") return start.value;
      const amount = (t - start.time) / Math.max(EPSILON, end.time - start.time);
      return start.value + (end.value - start.value) * amount;
    }
  }
  return normalized[normalized.length - 1]!.value;
}

function distinctTimes(times: number[], duration: number): number[] {
  return times
    .map((time) => clamp(time, 0, duration))
    .sort((a, b) => a - b)
    .filter((time, index, values) => index === 0 || Math.abs(time - values[index - 1]!) >= EPSILON);
}

/**
 * Combined clip + track envelope in clip-local seconds. Track automation is
 * evaluated at absolute timeline time, so moving a clip keeps its own shape
 * while correctly passing through track-wide moves.
 */
export function resolveAudioAutomationBreakpoints(
  clip: Pick<Clip, "startTime" | "duration" | "audioAutomation" | "pan">,
  mixer: Pick<AudioMixer, "trackAutomation" | "trackPans"> | null | undefined,
  trackId: string,
  property: AudioAutomationProperty
): AudioAutomationBreakpoint[] {
  const duration = Math.max(0, finite(clip.duration, 0));
  const clipPoints = normalizeAudioAutomationPoints(clip.audioAutomation?.[property], property, duration);
  const trackPoints = normalizeAudioAutomationPoints(mixer?.trackAutomation?.[trackId]?.[property], property);
  const times = distinctTimes(
    [0, duration, ...clipPoints.map((point) => point.time), ...trackPoints.map((point) => point.time - clip.startTime)],
    duration
  );

  return times.map((t) => {
    const clipValue = audioAutomationValueAt(clipPoints, property, t, property === "pan" ? clamp(finite(clip.pan, 0), -1, 1) : 1);
    const trackValue = audioAutomationValueAt(trackPoints, property, clip.startTime + t, property === "pan" ? clamp(finite(mixer?.trackPans?.[trackId], 0), -1, 1) : 1);
    return {
      t,
      value: property === "volume" ? clipValue * trackValue : clamp(clipValue + trackValue, -1, 1),
      interpolation: "linear",
    };
  });
}

/** Combine multiplicative gain envelopes while retaining all control points. */
export function multiplyAudioAutomationBreakpoints(
  duration: number,
  ...envelopes: ReadonlyArray<readonly AudioAutomationBreakpoint[] | undefined>
): AudioAutomationBreakpoint[] {
  const safeDuration = Math.max(0, finite(duration, 0));
  const points: readonly (readonly AudioAutomationBreakpoint[])[] = envelopes.filter(
    (envelope): envelope is readonly AudioAutomationBreakpoint[] => Boolean(envelope)
  );
  const times = distinctTimes([0, safeDuration, ...points.flatMap((envelope) => envelope.map((point) => point.t))], safeDuration);
  const valueAt = (envelope: readonly AudioAutomationBreakpoint[], time: number) => {
    if (!envelope.length) return 1;
    if (time <= envelope[0]!.t) return envelope[0]!.value;
    for (let index = 0; index < envelope.length - 1; index++) {
      const start = envelope[index]!;
      const end = envelope[index + 1]!;
      if (time <= end.t) {
        if (start.interpolation === "hold") return start.value;
        const amount = (time - start.t) / Math.max(EPSILON, end.t - start.t);
        return start.value + (end.value - start.value) * amount;
      }
    }
    return envelope[envelope.length - 1]!.value;
  };
  return times.map((t) => ({ t, value: points.reduce((value, envelope) => value * valueAt(envelope, t), 1), interpolation: "linear" }));
}

/** FFmpeg expression evaluated with clip-local `t`, for volume or pan values. */
export function ffmpegAudioAutomationExpr(
  points: readonly AudioAutomationBreakpoint[] | null | undefined,
  fallback: number
): string {
  const normalized = (points || [])
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value))
    .sort((a, b) => a.t - b.t);
  if (!normalized.length) return String(fallback);
  if (normalized.length === 1) return normalized[0]!.value.toFixed(6);

  let expression = normalized[normalized.length - 1]!.value.toFixed(6);
  for (let index = normalized.length - 2; index >= 0; index--) {
    const start = normalized[index]!;
    const end = normalized[index + 1]!;
    const begin = start.t.toFixed(4);
    const finish = end.t.toFixed(4);
    const value = start.interpolation === "hold"
      ? start.value.toFixed(6)
      : `${start.value.toFixed(6)}+(${(end.value - start.value).toFixed(6)})*(t-${begin})/${Math.max(EPSILON, end.t - start.t).toFixed(4)}`;
    expression = `if(between(t,${begin},${finish}),${value},${expression})`;
  }
  return expression;
}
