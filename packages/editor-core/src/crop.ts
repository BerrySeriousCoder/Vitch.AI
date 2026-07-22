import type { Clip, Crop, Keyframe } from "@tempo/types";
import { resolveKeyframeValues } from "./keyframes";

export const DEFAULT_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 };

export type KenBurnsPresetId = "zoom-in" | "zoom-out" | "pan-left" | "pan-right";

const KEN_BURNS_PRESETS: Record<KenBurnsPresetId, { from: Crop; to: Crop }> = {
  "zoom-in": {
    from: DEFAULT_CROP,
    to: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  },
  "zoom-out": {
    from: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    to: DEFAULT_CROP,
  },
  "pan-left": {
    from: { x: 0.2, y: 0.1, width: 0.8, height: 0.8 },
    to: { x: 0, y: 0.1, width: 0.8, height: 0.8 },
  },
  "pan-right": {
    from: { x: 0, y: 0.1, width: 0.8, height: 0.8 },
    to: { x: 0.2, y: 0.1, width: 0.8, height: 0.8 },
  },
};

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Keyframes are polymorphic, but crop properties must always resolve to numbers. */
function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Normalize a crop while preserving a rectangle fully inside the source. */
export function normalizeCrop(input: Partial<Crop> | null | undefined): Crop {
  const x = clamp(numberOr(input?.x, DEFAULT_CROP.x), 0, 1);
  const y = clamp(numberOr(input?.y, DEFAULT_CROP.y), 0, 1);
  const width = clamp(numberOr(input?.width, DEFAULT_CROP.width), 0.001, 1 - x);
  const height = clamp(numberOr(input?.height, DEFAULT_CROP.height), 0.001, 1 - y);
  return { x, y, width, height };
}

export function validateCrop(
  input: unknown
): { ok: true; value: Crop } | { ok: false; message: string } {
  if (input == null || typeof input !== "object") {
    return { ok: false, message: "Crop must be an object" };
  }
  const raw = input as Record<string, unknown>;
  for (const key of ["x", "y", "width", "height"] as const) {
    if (raw[key] !== undefined && !Number.isFinite(Number(raw[key]))) {
      return { ok: false, message: `Crop ${key} must be a finite number` };
    }
  }
  if (raw.width !== undefined && Number(raw.width) <= 0) {
    return { ok: false, message: "Crop width must be positive" };
  }
  if (raw.height !== undefined && Number(raw.height) <= 0) {
    return { ok: false, message: "Crop height must be positive" };
  }
  const x = numberOr(raw.x, DEFAULT_CROP.x);
  const y = numberOr(raw.y, DEFAULT_CROP.y);
  const width = numberOr(raw.width, DEFAULT_CROP.width);
  const height = numberOr(raw.height, DEFAULT_CROP.height);
  if (x < 0 || y < 0 || x > 1 || y > 1 || width > 1 || height > 1) {
    return { ok: false, message: "Crop values must be between 0 and 1" };
  }
  if (x + width > 1 || y + height > 1) {
    return { ok: false, message: "Crop bounds must stay inside the source" };
  }
  const value = normalizeCrop(raw as Partial<Crop>);
  if (value.width <= 0 || value.height <= 0) {
    return { ok: false, message: "Crop width and height must be positive" };
  }
  return { ok: true, value };
}

export function cropIsIdentity(crop: Crop | null | undefined): boolean {
  if (!crop) return true;
  const c = normalizeCrop(crop);
  return c.x === 0 && c.y === 0 && c.width === 1 && c.height === 1;
}

/** Resolve the crop at a clip-local time from static values plus crop keyframes. */
export function resolveCropAtTime(
  crop: Crop | null | undefined,
  keyframes: readonly Keyframe[] = [],
  timeInClip: number
): Crop {
  const base = normalizeCrop(crop);
  const values = resolveKeyframeValues([...keyframes], timeInClip);
  return normalizeCrop({
    x: finiteNumberOr(values["crop.x"], base.x),
    y: finiteNumberOr(values["crop.y"], base.y),
    width: finiteNumberOr(values["crop.width"], base.width),
    height: finiteNumberOr(values["crop.height"], base.height),
  });
}

export function listKenBurnsPresetIds(): KenBurnsPresetId[] {
  return Object.keys(KEN_BURNS_PRESETS) as KenBurnsPresetId[];
}

export interface ApplyKenBurnsInput {
  presetId?: KenBurnsPresetId;
  from?: Partial<Crop>;
  to?: Partial<Crop>;
  duration: number;
  keyframes: readonly Keyframe[];
  createKeyframeId: () => string;
}

export type ApplyKenBurnsResult =
  | { ok: true; crop: Crop; keyframes: Keyframe[]; from: Crop; to: Crop }
  | { ok: false; message: string };

/**
 * Replaces only crop keyframes, leaving transform/effect animation intact.
 * The static crop is the final state, so the last frame stays correct after
 * the animated interval.
 */
export function applyKenBurns(input: ApplyKenBurnsInput): ApplyKenBurnsResult {
  if (!Number.isFinite(input.duration) || input.duration <= 0) {
    return { ok: false, message: "Clip duration must be positive" };
  }
  const preset = input.presetId ? KEN_BURNS_PRESETS[input.presetId] : undefined;
  if (input.presetId && !preset) {
    return { ok: false, message: `Unknown Ken Burns preset "${input.presetId}"` };
  }
  const from = normalizeCrop(input.from ?? preset?.from ?? DEFAULT_CROP);
  const to = normalizeCrop(input.to ?? preset?.to ?? DEFAULT_CROP);
  const keyframes = input.keyframes.filter((keyframe) => !keyframe.property.startsWith("crop."));

  for (const [property, start, end] of [
    ["crop.x", from.x, to.x],
    ["crop.y", from.y, to.y],
    ["crop.width", from.width, to.width],
    ["crop.height", from.height, to.height],
  ] as const) {
    keyframes.push(
      { id: input.createKeyframeId(), property, time: 0, value: start, easing: "linear" },
      { id: input.createKeyframeId(), property, time: input.duration, value: end, easing: "ease-in-out" }
    );
  }

  return { ok: true, crop: to, keyframes, from, to };
}
