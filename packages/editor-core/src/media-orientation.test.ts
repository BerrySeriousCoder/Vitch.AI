import { describe, expect, it } from "vitest";
import {
  coverRetention,
  mediaDisplayGeometry,
  orientationFromDimensions,
} from "./media-orientation";

describe("media orientation", () => {
  it("uses rotation-corrected display dimensions", () => {
    expect(mediaDisplayGeometry({
      width: 1920,
      height: 1080,
      displayWidth: 1080,
      displayHeight: 1920,
      rotation: 90,
    })).toMatchObject({ width: 1080, height: 1920, orientation: "portrait" });
  });

  it("classifies portrait, landscape, and near-square media", () => {
    expect(orientationFromDimensions(1080, 1920)).toBe("portrait");
    expect(orientationFromDimensions(1920, 1080)).toBe("landscape");
    expect(orientationFromDimensions(1080, 1080)).toBe("square");
  });

  it("quantifies severe cover crop loss", () => {
    expect(coverRetention(1920, 1080, 1080, 1920)).toBeCloseTo(0.3164, 3);
    expect(coverRetention(1080, 1920, 1080, 1920)).toBe(1);
  });
});
