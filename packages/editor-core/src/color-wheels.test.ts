import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIFT_GAMMA_GAIN,
  isLiftGammaGainNeutral,
  normalizeLiftGammaGain,
} from "./color-wheels";

describe("Lift/Gamma/Gain color wheels", () => {
  it("uses neutral defaults", () => {
    expect(normalizeLiftGammaGain()).toEqual(DEFAULT_LIFT_GAMMA_GAIN);
    expect(isLiftGammaGainNeutral()).toBe(true);
  });

  it("clamps each RGB and master control", () => {
    expect(normalizeLiftGammaGain({ liftRed: 2, gammaGreen: -3, gainMaster: 0.4 })).toMatchObject({
      liftRed: 1,
      gammaGreen: -1,
      gainMaster: 0.4,
    });
    expect(isLiftGammaGainNeutral({ gainBlue: 0.01 })).toBe(false);
  });
});
