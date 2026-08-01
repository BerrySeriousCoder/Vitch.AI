import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRIMARY_COLOR_GRADE,
  isPrimaryColorGradeNeutral,
  normalizePrimaryColorGrade,
} from "./color-grade";

describe("primary color grade", () => {
  it("uses neutral defaults", () => {
    expect(normalizePrimaryColorGrade()).toEqual(DEFAULT_PRIMARY_COLOR_GRADE);
    expect(isPrimaryColorGradeNeutral()).toBe(true);
  });

  it("clamps grade controls and ignores invalid values", () => {
    expect(
      normalizePrimaryColorGrade({
        exposure: 9,
        temperature: -300,
        highlights: 32,
        vibrance: Number.NaN,
      })
    ).toMatchObject({ exposure: 4, temperature: -100, highlights: 32, vibrance: 0 });
    expect(isPrimaryColorGradeNeutral({ exposure: 0, tint: 1 })).toBe(false);
  });
});
