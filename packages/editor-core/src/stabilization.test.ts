import { describe, expect, it } from "vitest";
import { normalizeStabilization, resolveStabilizationAtTime } from "./stabilization";

describe("stabilization", () => {
  it("normalizes bounded editable settings", () => {
    const result = normalizeStabilization({
      enabled: true, smoothness: 4, cropScale: 4,
      samples: [{ time: 1, x: 0.7, y: 0.5 }, { time: 0, x: 0.4, y: 0.5 }],
    });
    expect(result).toMatchObject({ enabled: true, smoothness: 1, cropScale: 1.5 });
    expect(result?.samples.map((sample) => sample.time)).toEqual([0, 1]);
  });

  it("returns inverse correction only when enabled", () => {
    const settings = normalizeStabilization({
      enabled: true, smoothness: 1, cropScale: 1.1,
      samples: [{ time: 0, x: 0.4, y: 0.5 }, { time: 1, x: 0.6, y: 0.5 }, { time: 2, x: 0.4, y: 0.5 }],
    });
    expect(resolveStabilizationAtTime(settings, 1)?.offsetX).toBeLessThan(0);
    expect(resolveStabilizationAtTime({ ...settings!, enabled: false }, 1)).toBeNull();
  });
});
