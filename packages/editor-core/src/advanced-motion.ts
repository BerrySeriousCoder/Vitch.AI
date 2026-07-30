import type { MotionBlurSettings, Transform3D } from "@tempo/types";

export const DEFAULT_MOTION_BLUR: MotionBlurSettings = { enabled: false, shutterAngle: 180, samples: 8 };
export const DEFAULT_TRANSFORM_3D: Transform3D = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, anchorX: 0, anchorY: 0, anchorZ: 0 };

const clamp = (value: unknown, min: number, max: number, fallback: number) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;

export function normalizeMotionBlur(input?: Partial<MotionBlurSettings> | null): MotionBlurSettings {
  return { enabled: Boolean(input?.enabled), shutterAngle: clamp(input?.shutterAngle, 0, 360, DEFAULT_MOTION_BLUR.shutterAngle), samples: Math.round(clamp(input?.samples, 2, 32, DEFAULT_MOTION_BLUR.samples)) };
}

export function normalizeTransform3D(input?: Partial<Transform3D> | null): Transform3D {
  const out = { ...DEFAULT_TRANSFORM_3D };
  for (const key of Object.keys(out) as Array<keyof Transform3D>) out[key] = clamp(input?.[key], key.startsWith("scale") ? 0.001 : -100000, 100000, out[key]);
  return out;
}
