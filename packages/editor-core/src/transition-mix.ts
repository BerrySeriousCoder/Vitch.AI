/**
 * Pure transition mix descriptors — single source of truth for preview + policy.
 * Compositor/export consume TransitionMix; do not switch on growing type lists elsewhere.
 */

import { getTransitionType } from "./transition-registry";

export type TransitionDirection = "left" | "right" | "up" | "down";

export type GeometricTransitionKind = "wipe" | "push" | "whip" | "iris" | "zoom-smash" | "spin" | "squeeze" | "peel" | "dip-white" | "flash" | "beat-flash" | "glitch-transition" | "light-leak-transition" | "film-burn-transition";

export type TransitionMix =
  | { mode: "opacity"; opacityA: number; opacityB: number }
  | {
      mode: "geometric";
      kind: GeometricTransitionKind;
      progress: number;
      direction: TransitionDirection;
      softness: number;
      /** Whip motion smear 0..1 */
      blur: number;
      /** Iris center in UV 0..1 */
      centerX: number;
      centerY: number;
    };

const DIRECTIONS = new Set<TransitionDirection>(["left", "right", "up", "down"]);

const GEOMETRIC_KINDS = new Set<GeometricTransitionKind>([
  "wipe",
  "push",
  "whip",
  "iris",
  "zoom-smash",
  "spin",
  "squeeze",
  "peel",
  "dip-white", "flash", "beat-flash", "glitch-transition", "light-leak-transition", "film-burn-transition",
]);

export function normalizeTransitionDirection(
  value: unknown,
  fallback: TransitionDirection = "left"
): TransitionDirection {
  const s = String(value || "").toLowerCase() as TransitionDirection;
  return DIRECTIONS.has(s) ? s : fallback;
}

export function normalizeTransitionSoftness(value: unknown, fallback = 0.08): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(0.5, n));
}

export function normalizeTransitionBlur(value: unknown, fallback = 0.35): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function normalizeUnit(value: unknown, fallback = 0.5): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function clamp01(p: number): number {
  return Math.min(1, Math.max(0, p));
}

function resolveGeometricKind(type: string): GeometricTransitionKind | null {
  if (GEOMETRIC_KINDS.has(type as GeometricTransitionKind)) {
    return type as GeometricTransitionKind;
  }
  return null;
}

/**
 * Resolve how A/B should be mixed at a given progress (0 = all A, 1 = all B).
 */
export function getTransitionMix(
  type: string,
  progress: number,
  params: Record<string, number | string | boolean> = {}
): TransitionMix {
  const p = clamp01(progress);
  const def = getTransitionType(type);
  const geometricKind = resolveGeometricKind(type);

  if (geometricKind && (def?.mixFamily === "geometric" || !def)) {
    const isWipe = geometricKind === "wipe" || geometricKind === "squeeze" || geometricKind === "peel";
    const isIris = geometricKind === "iris";
    const isWhip = geometricKind === "whip";
    return {
      mode: "geometric",
      kind: geometricKind,
      progress: p,
      direction: normalizeTransitionDirection(params.direction, "left"),
      softness:
        isWipe || isIris
          ? normalizeTransitionSoftness(params.softness, 0.08)
          : 0,
      blur: isWhip
        ? normalizeTransitionBlur(params.blur, 0.35)
        : geometricKind === "zoom-smash" || geometricKind === "spin" || geometricKind === "flash" || geometricKind === "beat-flash" || geometricKind === "glitch-transition" || geometricKind === "light-leak-transition" || geometricKind === "film-burn-transition"
          ? normalizeUnit(params.intensity, 0.7)
          : 0,
      centerX: isIris ? normalizeUnit(params.centerX, 0.5) : 0.5,
      centerY: isIris ? normalizeUnit(params.centerY, 0.5) : 0.5,
    };
  }

  // Registered geometric type without mix implementation yet → safe opacity dissolve
  if (def?.mixFamily === "geometric") {
    return {
      mode: "opacity",
      opacityA: 1 - p,
      opacityB: p,
    };
  }

  if (type === "dip-black") {
    return {
      mode: "opacity",
      opacityA: Math.max(0, 1 - p * 2),
      opacityB: Math.max(0, p * 2 - 1),
    };
  }

  // crossfade + unknown → opacity dissolve
  return {
    mode: "opacity",
    opacityA: 1 - p,
    opacityB: p,
  };
}

/**
 * Opacity multiplier for sequential draw path (crossfade / dip-black).
 * Geometric types return 1 for both (caller should use getTransitionMix instead).
 */
export function getTransitionClipOpacity(
  type: string,
  progress: number,
  which: "A" | "B",
  params: Record<string, number | string | boolean> = {}
): number {
  const mix = getTransitionMix(type, progress, params);
  if (mix.mode === "geometric") return 1;
  return which === "A" ? mix.opacityA : mix.opacityB;
}
