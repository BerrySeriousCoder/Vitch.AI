import type { Mask, TrackMatte } from "@tempo/types";
import { normalizeMask } from "./mask";

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

/** Bounds and fills non-destructive controls used by AI/video roto mattes. */
export function normalizeRotoMatteRefinement(input: Partial<NonNullable<TrackMatte["refinement"]>> | null | undefined): NonNullable<TrackMatte["refinement"]> {
  return {
    threshold: clamp(input?.threshold, 0, 1, 0.5),
    feather: clamp(input?.feather, 0, 0.5, 0.02),
    inverted: input?.inverted === true,
    choke: clamp(input?.choke, -0.5, 0.5, 0),
  };
}

export function normalizeRotoRegion(input: Partial<Mask> | Mask | null | undefined): Mask | undefined {
  if (!input) return undefined;
  const normalized = normalizeMask(input);
  return normalized.width > 0 && normalized.height > 0 ? normalized : undefined;
}
