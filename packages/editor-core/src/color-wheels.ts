import type { LiftGammaGain } from "@tempo/types";

export const DEFAULT_LIFT_GAMMA_GAIN: LiftGammaGain = {
  liftRed: 0,
  liftGreen: 0,
  liftBlue: 0,
  liftMaster: 0,
  gammaRed: 0,
  gammaGreen: 0,
  gammaBlue: 0,
  gammaMaster: 0,
  gainRed: 0,
  gainGreen: 0,
  gainBlue: 0,
  gainMaster: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalizes persisted/UI/agent wheel controls to a stable neutral-centred range. */
export function normalizeLiftGammaGain(
  input?: Partial<LiftGammaGain> | null
): LiftGammaGain {
  const source = input || {};
  const result = { ...DEFAULT_LIFT_GAMMA_GAIN };
  for (const key of Object.keys(DEFAULT_LIFT_GAMMA_GAIN) as Array<keyof LiftGammaGain>) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) result[key] = clamp(value, -1, 1);
  }
  return result;
}

export function isLiftGammaGainNeutral(input?: Partial<LiftGammaGain> | null): boolean {
  return Object.values(normalizeLiftGammaGain(input)).every((value) => value === 0);
}
