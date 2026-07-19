import type { EasingType, Effect, EffectParamValue, Keyframe } from "@tempo/types";
import { getEffectDefinition } from "./effect-registry";

export type EasingFunction = (t: number) => number;

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

export function linear(t: number): number {
  return clamp01(t);
}

export function easeIn(t: number): number {
  t = clamp01(t);
  return t * t;
}

export function easeOut(t: number): number {
  t = clamp01(t);
  return 1 - (1 - t) * (1 - t);
}

export function easeInOut(t: number): number {
  t = clamp01(t);
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): EasingFunction {
  return (t: number): number => {
    t = clamp01(t);
    if (t === 0 || t === 1) return t;

    const sampleCurveX = (st: number) =>
      (((1 - 3 * x2 + 3 * x1) * st + (3 * x2 - 6 * x1)) * st + 3 * x1) * st;
    const sampleCurveY = (st: number) =>
      (((1 - 3 * y2 + 3 * y1) * st + (3 * y2 - 6 * y1)) * st + 3 * y1) * st;
    const sampleCurveDerivativeX = (st: number) =>
      3 * (1 - 3 * x2 + 3 * x1) * st * st +
      2 * (3 * x2 - 6 * x1) * st +
      3 * x1;

    let guess = t;
    for (let i = 0; i < 8; i++) {
      const currentX = sampleCurveX(guess) - t;
      if (Math.abs(currentX) < 1e-7) break;
      const derivative = sampleCurveDerivativeX(guess);
      if (Math.abs(derivative) < 1e-7) break;
      guess -= currentX / derivative;
    }

    return sampleCurveY(clamp01(guess));
  };
}

export function getEasingFunction(
  easing: EasingType,
  handles?: [number, number, number, number]
): EasingFunction {
  switch (easing) {
    case "hold":
      return () => 0;
    case "linear":
      return linear;
    case "ease-in":
      return easeIn;
    case "ease-out":
      return easeOut;
    case "ease-in-out":
      return easeInOut;
    case "cubic-bezier":
      if (handles) return cubicBezier(...handles);
      return linear;
    default:
      return linear;
  }
}

export function interpolateValue(
  keyframes: Keyframe[],
  time: number,
  property: string
): number | string | boolean | undefined {
  const relevant = keyframes
    .filter((k) => k.property === property)
    .sort((a, b) => a.time - b.time);

  if (relevant.length === 0) return undefined;

  if (time <= relevant[0]!.time) return relevant[0]!.value;
  if (time >= relevant[relevant.length - 1]!.time) {
    return relevant[relevant.length - 1]!.value;
  }

  let prevKf = relevant[0]!;
  let nextKf = relevant[1]!;

  for (let i = 0; i < relevant.length - 1; i++) {
    if (time >= relevant[i]!.time && time < relevant[i + 1]!.time) {
      prevKf = relevant[i]!;
      nextKf = relevant[i + 1]!;
      break;
    }
  }

  if (typeof prevKf.value === "boolean" || typeof prevKf.value === "string") {
    return prevKf.value;
  }

  const span = nextKf.time - prevKf.time;
  if (span <= 0) return prevKf.value;

  const rawT = (time - prevKf.time) / span;
  const easingFn = getEasingFunction(nextKf.easing, nextKf.bezierHandles);
  const easedT = easingFn(rawT);

  const prev = prevKf.value as number;
  const next = nextKf.value as number;
  return prev + (next - prev) * easedT;
}

export function resolveKeyframeValues(
  keyframes: Keyframe[],
  timeInClip: number
): Record<string, number | string | boolean> {
  const properties = new Set(keyframes.map((k) => k.property));
  const resolved: Record<string, number | string | boolean> = {};

  for (const prop of properties) {
    const val = interpolateValue(keyframes, timeInClip, prop);
    if (val !== undefined) {
      resolved[prop] = val;
    }
  }

  return resolved;
}

/**
 * Merge static effect.params with animated keyframeable params at timeInClip.
 */
export function resolveEffectParamsAtTime(
  effect: Effect,
  timeInClip: number
): Record<string, EffectParamValue> {
  const base: Record<string, EffectParamValue> = {
    ...(effect.params || {}),
  };
  const kfs = effect.keyframes || [];
  if (kfs.length === 0) return base;

  const def = getEffectDefinition(effect.type);
  const animated = resolveKeyframeValues(kfs, timeInClip);
  for (const [key, value] of Object.entries(animated)) {
    const paramDef = def?.params[key];
    if (paramDef && paramDef.keyframeable === false) continue;
    base[key] = value;
  }
  return base;
}
