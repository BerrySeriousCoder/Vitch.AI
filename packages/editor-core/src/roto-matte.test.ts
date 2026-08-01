import { describe, expect, it } from "vitest";
import { normalizeRotoMatteRefinement, normalizeRotoRegion } from "./roto-matte";

describe("roto matte controls", () => {
  it("bounds non-destructive matte cleanup controls", () => {
    expect(normalizeRotoMatteRefinement({ threshold: 2, feather: -1, choke: 9, inverted: true })).toEqual({
      threshold: 1, feather: 0, choke: 0.5, inverted: true,
    });
  });

  it("normalizes a usable holdout/garbage region", () => {
    expect(normalizeRotoRegion({ shape: "rect", x: -1, y: 0.2, width: 0.4, height: 0.3, feather: 0.8 })).toMatchObject({
      x: 0, y: 0.2, width: 0.4, height: 0.3, feather: 0.5,
    });
  });
});
