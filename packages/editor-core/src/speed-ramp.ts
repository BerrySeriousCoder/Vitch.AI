import type { Clip, SpeedRampPoint } from "@tempo/types";
import { normalizeHold } from "./hold";

const EPS = 1e-9;

export const DEFAULT_RETIME_SETTINGS = { interpolation: "nearest", frameRate: 30 } as const;

export function normalizeRetimeSettings(input: Clip["retime"] | null | undefined): Required<NonNullable<Clip["retime"]>> {
  const frameRate = Number(input?.frameRate);
  return {
    interpolation: input?.interpolation === "frame-blend" ? "frame-blend" : "nearest",
    frameRate: Number.isFinite(frameRate) ? Math.max(12, Math.min(60, Math.round(frameRate))) : DEFAULT_RETIME_SETTINGS.frameRate,
  };
}

export function normalizeSpeedRamp(
  points: SpeedRampPoint[] | null | undefined,
  clipDuration: number
): SpeedRampPoint[] | null {
  if (!points || points.length < 2) return null;
  const dur = Math.max(0, clipDuration);
  const cleaned = points
    .map((p) => ({
      time: Math.max(0, Math.min(dur, Number(p.time) || 0)),
      rate: Math.max(0, Number(p.rate) || 0),
      interpolation: p.interpolation === "smooth" || p.interpolation === "hold" ? p.interpolation : "linear" as const,
    }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.rate))
    .sort((a, b) => a.time - b.time);

  if (cleaned.length < 2) return null;

  // Dedupe identical times (keep last)
  const out: SpeedRampPoint[] = [];
  for (const p of cleaned) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.time - p.time) < EPS) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out.length >= 2 ? out : null;
}

export function validateSpeedRamp(
  input: unknown,
  clipDuration: number
):
  | { ok: true; value: SpeedRampPoint[] | null }
  | { ok: false; message: string } {
  if (input == null) return { ok: true, value: null };
  if (!Array.isArray(input)) {
    return { ok: false, message: "speedRamp must be an array or null" };
  }
  if (input.length === 0) return { ok: true, value: null };
  if (input.length === 1) {
    return { ok: false, message: "speedRamp requires at least 2 points" };
  }
  for (let i = 0; i < input.length; i++) {
    const p = input[i] as Record<string, unknown>;
    if (!p || typeof p !== "object") {
      return { ok: false, message: `speedRamp[${i}] must be an object` };
    }
    if (!Number.isFinite(Number(p.time))) {
      return { ok: false, message: `speedRamp[${i}].time must be finite` };
    }
    if (!Number.isFinite(Number(p.rate)) || Number(p.rate) < 0) {
      return {
        ok: false,
        message: `speedRamp[${i}].rate must be a finite number ≥ 0`,
      };
    }
    if (p.interpolation !== undefined && p.interpolation !== "linear" && p.interpolation !== "smooth" && p.interpolation !== "hold") {
      return { ok: false, message: `speedRamp[${i}].interpolation must be linear, smooth, or hold` };
    }
  }
  return {
    ok: true,
    value: normalizeSpeedRamp(input as SpeedRampPoint[], clipDuration),
  };
}

/** Constant speed magnitude (always ≥ 0). */
export function speedMagnitude(clip: Pick<Clip, "speed">): number {
  const s = Number(clip.speed);
  if (!Number.isFinite(s) || s === 0) return 1;
  return Math.abs(s);
}

export function isClipReversed(
  clip: Pick<Clip, "speed" | "reversed" | "speedRamp">
): boolean {
  if (clip.reversed === true) return true;
  const ramp = normalizeSpeedRamp(clip.speedRamp, Number.POSITIVE_INFINITY);
  if (ramp) return false; // direction only via `reversed` when ramping
  return Number(clip.speed) < 0;
}

/**
 * Piecewise-linear rate at clip-local time.
 * Outside the envelope, clamps to first/last rate.
 */
export function rateAtTime(points: SpeedRampPoint[], time: number): number {
  if (points.length === 0) return 1;
  if (time <= points[0]!.time) return points[0]!.rate;
  const last = points[points.length - 1]!;
  if (time >= last.time) return last.rate;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      if (span <= EPS) return b.rate;
      const rawU = (time - a.time) / span;
      if (a.interpolation === "hold") return a.rate;
      const u = a.interpolation === "smooth" ? rawU * rawU * (3 - 2 * rawU) : rawU;
      return a.rate + (b.rate - a.rate) * u;
    }
  }
  return last.rate;
}

/**
 * ∫_{t0}^{t1} rate(τ) dτ for piecewise-linear rate envelope.
 */
export function integrateRate(
  points: SpeedRampPoint[],
  t0: number,
  t1: number
): number {
  if (t1 <= t0 + EPS) return 0;
  let total = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (t0 < first.time) total += Math.max(0, Math.min(t1, first.time) - t0) * first.rate;
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index]!;
    const b = points[index + 1]!;
    const start = Math.max(t0, a.time);
    const end = Math.min(t1, b.time);
    const span = b.time - a.time;
    if (end <= start + EPS || span <= EPS) continue;
    const u0 = (start - a.time) / span;
    const u1 = (end - a.time) / span;
    const diff = b.rate - a.rate;
    if (a.interpolation === "hold") {
      total += a.rate * (end - start);
    } else if (a.interpolation === "smooth") {
      // Integral of smoothstep(u) = u³ - 0.5u⁴.
      const primitive = (u: number) => u * u * u - 0.5 * u * u * u * u;
      total += span * (a.rate * (u1 - u0) + diff * (primitive(u1) - primitive(u0)));
    } else {
      total += span * (a.rate * (u1 - u0) + diff * 0.5 * (u1 * u1 - u0 * u0));
    }
  }
  if (t1 > last.time) total += Math.max(0, t1 - Math.max(t0, last.time)) * last.rate;
  return total;
}

function motionWindow(clip: Clip): {
  motionStart: number;
  motionEnd: number;
  hold: ReturnType<typeof normalizeHold>;
} {
  const hold = normalizeHold(clip.hold);
  const dur = Math.max(0, clip.duration);
  if (!hold) {
    return { motionStart: 0, motionEnd: dur, hold: null };
  }
  const holdDur = Math.min(hold.durationSec, dur);
  if (hold.at === "in") {
    return { motionStart: holdDur, motionEnd: dur, hold };
  }
  return { motionStart: 0, motionEnd: Math.max(0, dur - holdDur), hold };
}

/**
 * Source seconds consumed over the full motion window (before reverse flip).
 */
export function motionSourceSpan(
  clip: Clip,
  mediaDurationSec?: number | null
): number {
  const { motionStart, motionEnd } = motionWindow(clip);
  const motionDur = Math.max(0, motionEnd - motionStart);
  const ramp = normalizeSpeedRamp(clip.speedRamp, clip.duration);
  let span: number;
  if (ramp) {
    span = integrateRate(ramp, motionStart, motionEnd);
  } else {
    span = speedMagnitude(clip) * motionDur;
  }
  if (mediaDurationSec != null && Number.isFinite(mediaDurationSec)) {
    const maxSpan = Math.max(0, mediaDurationSec - (clip.sourceOffset || 0));
    span = Math.min(span, maxSpan);
  }
  return Math.max(0, span);
}

export interface SourceTimeResult {
  sourceTime: number;
  frozen: boolean;
  /** Instantaneous rate magnitude at this time (0 if frozen) */
  rate: number;
}

/**
 * Map clip-local timeline time → source media time.
 * Applies hold freezes, speed ramp (or constant speed), then optional reverse.
 */
export function sourceTimeAt(
  clip: Clip,
  timeInClip: number,
  mediaDurationSec?: number | null
): SourceTimeResult {
  const offset = clip.sourceOffset || 0;
  const t = Math.max(0, Math.min(clip.duration, timeInClip));
  const { motionStart, motionEnd, hold } = motionWindow(clip);
  const ramp = normalizeSpeedRamp(clip.speedRamp, clip.duration);
  const reversed = isClipReversed(clip);
  const span = motionSourceSpan(clip, mediaDurationSec);

  // In-hold freeze
  if (hold?.at === "in" && t <= motionStart) {
    const src = reversed ? offset + span : offset;
    return { sourceTime: clampSource(src, mediaDurationSec), frozen: true, rate: 0 };
  }
  // Out-hold freeze
  if (hold?.at === "out" && t >= motionEnd) {
    const src = reversed ? offset : offset + span;
    return { sourceTime: clampSource(src, mediaDurationSec), frozen: true, rate: 0 };
  }

  // Motion
  const motionT = Math.max(motionStart, Math.min(motionEnd, t));
  let delta: number;
  let rate: number;
  if (ramp) {
    delta = integrateRate(ramp, motionStart, motionT);
    rate = rateAtTime(ramp, motionT);
  } else {
    const mag = speedMagnitude(clip);
    delta = mag * (motionT - motionStart);
    rate = mag;
  }

  // Clamp delta into [0, span]
  delta = Math.max(0, Math.min(span, delta));
  const forward = offset + delta;
  const sourceTime = reversed ? offset + span - delta : forward;

  return {
    sourceTime: clampSource(sourceTime, mediaDurationSec),
    /** True only for marked hold freezes (not ultra-slow ramp rates). */
    frozen: false,
    rate,
  };
}

/** Back-compat alias used by compositor / tests — same as sourceTimeAt without rate. */
export function sourceTimeWithHold(
  clip: Clip,
  timeInClip: number,
  mediaDurationSec?: number | null
): { sourceTime: number; frozen: boolean } {
  const r = sourceTimeAt(clip, timeInClip, mediaDurationSec);
  return { sourceTime: r.sourceTime, frozen: r.frozen };
}

function clampSource(src: number, mediaDurationSec?: number | null): number {
  let s = Math.max(0, src);
  if (mediaDurationSec != null && Number.isFinite(mediaDurationSec)) {
    s = Math.min(s, Math.max(0, mediaDurationSec - 1 / 60));
  }
  return s;
}

/** Built-in speed envelope presets (clip-local). */
export type SpeedPresetId =
  | "slow-mo-middle"
  | "ramp-in"
  | "ramp-out"
  | "speed-up-middle"
  | "reverse";

export function listSpeedPresetIds(): SpeedPresetId[] {
  return [
    "slow-mo-middle",
    "ramp-in",
    "ramp-out",
    "speed-up-middle",
    "reverse",
  ];
}

export function applySpeedPreset(
  presetId: string,
  clipDuration: number
): {
  speed: number;
  reversed: boolean;
  speedRamp: SpeedRampPoint[] | null;
} | null {
  const d = Math.max(0.05, clipDuration);
  const mid = d / 2;
  switch (presetId) {
    case "slow-mo-middle":
      return {
        speed: 1,
        reversed: false,
        speedRamp: [
          { time: 0, rate: 1 },
          { time: mid * 0.5, rate: 1, interpolation: "smooth" },
          { time: mid, rate: 0.35, interpolation: "smooth" },
          { time: mid + mid * 0.5, rate: 1, interpolation: "smooth" },
          { time: d, rate: 1 },
        ],
      };
    case "ramp-in":
      return {
        speed: 1,
        reversed: false,
        speedRamp: [
          { time: 0, rate: 0.25, interpolation: "smooth" },
          { time: Math.min(d, d * 0.6), rate: 1 },
          { time: d, rate: 1 },
        ],
      };
    case "ramp-out":
      return {
        speed: 1,
        reversed: false,
        speedRamp: [
          { time: 0, rate: 1 },
          { time: Math.max(0, d * 0.4), rate: 1, interpolation: "smooth" },
          { time: d, rate: 0.25 },
        ],
      };
    case "speed-up-middle":
      return {
        speed: 1,
        reversed: false,
        speedRamp: [
          { time: 0, rate: 1 },
          { time: mid * 0.5, rate: 1, interpolation: "smooth" },
          { time: mid, rate: 2.5, interpolation: "smooth" },
          { time: mid + mid * 0.5, rate: 1, interpolation: "smooth" },
          { time: d, rate: 1 },
        ],
      };
    case "reverse":
      return { speed: 1, reversed: true, speedRamp: null };
    default:
      return null;
  }
}
