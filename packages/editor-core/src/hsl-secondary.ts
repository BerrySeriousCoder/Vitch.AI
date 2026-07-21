import type { HslSecondary } from "@tempo/types";

export const DEFAULT_HSL_SECONDARY: HslSecondary = {
  hueCenter: 0,
  hueRange: 30,
  saturationMin: 0,
  saturationMax: 1,
  lightnessMin: 0,
  lightnessMax: 1,
  feather: 0.1,
  hueShift: 0,
  saturationShift: 0,
  lightnessShift: 0,
  mix: 1,
};

const RANGES: Record<keyof HslSecondary, readonly [number, number]> = {
  hueCenter: [0, 360],
  hueRange: [1, 180],
  saturationMin: [0, 1],
  saturationMax: [0, 1],
  lightnessMin: [0, 1],
  lightnessMax: [0, 1],
  feather: [0, 1],
  hueShift: [-180, 180],
  saturationShift: [-100, 100],
  lightnessShift: [-100, 100],
  mix: [0, 1],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalizes a persisted/UI/agent HSL key while keeping qualifier bounds ordered. */
export function normalizeHslSecondary(input?: Partial<HslSecondary> | null): HslSecondary {
  const source = input || {};
  const result = { ...DEFAULT_HSL_SECONDARY };
  for (const key of Object.keys(DEFAULT_HSL_SECONDARY) as Array<keyof HslSecondary>) {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) continue;
    const [min, max] = RANGES[key];
    result[key] = clamp(value, min, max);
  }
  if (result.saturationMin > result.saturationMax) {
    [result.saturationMin, result.saturationMax] = [result.saturationMax, result.saturationMin];
  }
  if (result.lightnessMin > result.lightnessMax) {
    [result.lightnessMin, result.lightnessMax] = [result.lightnessMax, result.lightnessMin];
  }
  return result;
}

export function isHslSecondaryNeutral(input?: Partial<HslSecondary> | null): boolean {
  const secondary = normalizeHslSecondary(input);
  return secondary.hueShift === 0 &&
    secondary.saturationShift === 0 &&
    secondary.lightnessShift === 0;
}
