import { describe, expect, it } from "vitest";
import { DEFAULT_LEVELS, isLevelsNeutral, normalizeLevels } from "./levels";

describe("levels", () => {
  it("uses neutral defaults", () => {
    expect(normalizeLevels()).toEqual(DEFAULT_LEVELS);
    expect(isLevelsNeutral()).toBe(true);
  });

  it("clamps controls and keeps level ranges non-zero", () => {
    expect(normalizeLevels({ inputBlack: 1.2, inputWhite: -1, gamma: 20, outputBlack: 0.8, outputWhite: 0.2 }))
      .toMatchObject({ inputBlack: 0, inputWhite: 1, gamma: 10, outputBlack: 0.2, outputWhite: 0.8 });
    expect(normalizeLevels({ inputBlack: 0.4, inputWhite: 0.4 }).inputWhite).toBeGreaterThan(0.4);
  });
});
