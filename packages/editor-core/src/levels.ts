import type { Levels } from "@tempo/types";

export const DEFAULT_LEVELS: Levels = {
  inputBlack: 0,
  inputWhite: 1,
  gamma: 1,
  outputBlack: 0,
  outputWhite: 1,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalizes level controls while retaining usable non-zero input/output spans. */
export function normalizeLevels(input?: Partial<Levels> | null): Levels {
  const source = input || {};
  const result = { ...DEFAULT_LEVELS };
  const ranges: Record<keyof Levels, readonly [number, number]> = {
    inputBlack: [0, 1],
    inputWhite: [0, 1],
    gamma: [0.1, 10],
    outputBlack: [0, 1],
    outputWhite: [0, 1],
  };
  for (const key of Object.keys(DEFAULT_LEVELS) as Array<keyof Levels>) {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) continue;
    const [min, max] = ranges[key];
    result[key] = clamp(value, min, max);
  }
  if (result.inputBlack >= result.inputWhite) {
    [result.inputBlack, result.inputWhite] = [
      Math.min(result.inputBlack, result.inputWhite),
      Math.max(result.inputBlack, result.inputWhite),
    ];
    if (result.inputBlack === result.inputWhite) result.inputWhite = Math.min(1, result.inputBlack + 0.001);
  }
  if (result.outputBlack >= result.outputWhite) {
    [result.outputBlack, result.outputWhite] = [
      Math.min(result.outputBlack, result.outputWhite),
      Math.max(result.outputBlack, result.outputWhite),
    ];
    if (result.outputBlack === result.outputWhite) result.outputWhite = Math.min(1, result.outputBlack + 0.001);
  }
  return result;
}

export function isLevelsNeutral(input?: Partial<Levels> | null): boolean {
  const levels = normalizeLevels(input);
  return levels.inputBlack === 0 && levels.inputWhite === 1 && levels.gamma === 1 &&
    levels.outputBlack === 0 && levels.outputWhite === 1;
}
