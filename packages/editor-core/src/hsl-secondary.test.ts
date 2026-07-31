import { describe, expect, it } from "vitest";
import {
  DEFAULT_HSL_SECONDARY,
  isHslSecondaryNeutral,
  normalizeHslSecondary,
} from "./hsl-secondary";

describe("HSL secondary", () => {
  it("uses a neutral correction with a full HSL qualifier", () => {
    expect(normalizeHslSecondary()).toEqual(DEFAULT_HSL_SECONDARY);
    expect(isHslSecondaryNeutral()).toBe(true);
  });

  it("clamps controls and orders inverted qualifier ranges", () => {
    expect(normalizeHslSecondary({
      hueCenter: 500,
      hueRange: 0,
      saturationMin: 0.9,
      saturationMax: 0.2,
      lightnessMin: 0.8,
      lightnessMax: 0.1,
      hueShift: -250,
      mix: 2,
    })).toMatchObject({
      hueCenter: 360,
      hueRange: 1,
      saturationMin: 0.2,
      saturationMax: 0.9,
      lightnessMin: 0.1,
      lightnessMax: 0.8,
      hueShift: -180,
      mix: 1,
    });
    expect(isHslSecondaryNeutral({ saturationShift: 10 })).toBe(false);
  });
});
