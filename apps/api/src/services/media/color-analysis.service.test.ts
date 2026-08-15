import { describe, expect, it } from "vitest";
import { colorStatisticsFromRgbBytes } from "./color-analysis.service.js";

describe("decoded color statistics", () => {
  it("measures rgb/luma/saturation from raw RGB pixels", () => {
    const stats = colorStatisticsFromRgbBytes(new Uint8Array([
      255, 0, 0,
      0, 0, 255,
    ]));
    expect(stats?.meanRed).toBeCloseTo(0.5);
    expect(stats?.meanBlue).toBeCloseTo(0.5);
    expect(stats?.meanSaturation).toBeCloseTo(1);
    expect(stats?.sampleCount).toBe(2);
  });
});
