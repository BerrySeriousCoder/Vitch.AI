import type { Mask } from "@tempo/types";

export const DEFAULT_MASK: Mask = {
  shape: "ellipse",
  x: 0.1,
  y: 0.1,
  width: 0.8,
  height: 0.8,
  feather: 0.05,
  inverted: false,
  opacity: 1,
};

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Normalize / fill defaults for a partial mask. */
export function normalizeMask(input: Partial<Mask> | null | undefined): Mask {
  const shape = input?.shape === "rect" ? "rect" : "ellipse";
  return {
    shape,
    x: clamp(finiteNumber(input?.x, DEFAULT_MASK.x), 0, 1),
    y: clamp(finiteNumber(input?.y, DEFAULT_MASK.y), 0, 1),
    width: clamp(finiteNumber(input?.width, DEFAULT_MASK.width), 0, 1),
    height: clamp(finiteNumber(input?.height, DEFAULT_MASK.height), 0, 1),
    feather: clamp(finiteNumber(input?.feather, DEFAULT_MASK.feather), 0, 0.5),
    inverted: Boolean(input?.inverted ?? false),
    opacity: clamp(finiteNumber(input?.opacity, DEFAULT_MASK.opacity), 0, 1),
  };
}

export function validateMask(
  input: unknown
): { ok: true; value: Mask } | { ok: false; message: string } {
  if (input == null || typeof input !== "object") {
    return { ok: false, message: "Mask must be an object" };
  }
  const raw = input as Record<string, unknown>;
  if (raw.shape !== "rect" && raw.shape !== "ellipse") {
    return { ok: false, message: 'Mask shape must be "rect" or "ellipse"' };
  }
  for (const key of ["x", "y", "width", "height", "feather", "opacity"] as const) {
    if (raw[key] !== undefined && !Number.isFinite(Number(raw[key]))) {
      return { ok: false, message: `Mask ${key} must be a finite number` };
    }
  }
  const value = normalizeMask(raw as Partial<Mask>);
  if (!(value.width > 0) || !(value.height > 0)) {
    return { ok: false, message: "Mask width/height must be > 0" };
  }
  return { ok: true, value };
}

export function clipHasMask(mask: Mask | null | undefined): boolean {
  return mask != null && typeof mask === "object" && "shape" in mask;
}
