import type { PrimaryColorGrade } from "@tempo/types";

export const DEFAULT_PRIMARY_COLOR_GRADE: PrimaryColorGrade = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  shadows: 0,
  highlights: 0,
  blacks: 0,
  whites: 0,
  vibrance: 0,
};

const GRADE_RANGES: Record<keyof PrimaryColorGrade, readonly [number, number]> = {
  exposure: [-4, 4],
  contrast: [-100, 100],
  saturation: [-100, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  shadows: [-100, 100],
  highlights: [-100, 100],
  blacks: [-100, 100],
  whites: [-100, 100],
  vibrance: [-100, 100],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalizes persisted, UI, and agent grade params to the supported range. */
export function normalizePrimaryColorGrade(
  input?: Partial<PrimaryColorGrade> | null
): PrimaryColorGrade {
  const source = input || {};
  const result = { ...DEFAULT_PRIMARY_COLOR_GRADE };
  for (const key of Object.keys(DEFAULT_PRIMARY_COLOR_GRADE) as Array<keyof PrimaryColorGrade>) {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) continue;
    const [min, max] = GRADE_RANGES[key];
    result[key] = clamp(value, min, max);
  }
  return result;
}

export function isPrimaryColorGradeNeutral(
  input?: Partial<PrimaryColorGrade> | null
): boolean {
  const grade = normalizePrimaryColorGrade(input);
  return Object.entries(grade).every(([, value]) => value === 0);
}
