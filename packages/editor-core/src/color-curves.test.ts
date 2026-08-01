import { describe, expect, it } from "vitest";
import {
  normalizeColorCurves,
  normalizeCurvePoints,
  sampleCurve,
  validateCurvePoints,
} from "./color-curves";

describe("color curves", () => {
  it("normalizes malformed payloads to an identity curve", () => {
    expect(normalizeCurvePoints([{ x: 0.5, y: 0.7 }])).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.7 },
      { x: 1, y: 1 },
    ]);
    expect(normalizeColorCurves().red).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it("validates strict monotonic curves and samples linearly", () => {
    const curve = [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }];
    expect(validateCurvePoints(curve).ok).toBe(true);
    expect(validateCurvePoints([{ x: 0, y: 0 }, { x: 0, y: 1 }]).ok).toBe(false);
    expect(sampleCurve(curve, 0.25)).toBeCloseTo(0.35);
  });
});
