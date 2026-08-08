import { describe, expect, it } from "vitest";
import { previewRenderDimensions } from "./preview-resolution";

describe("previewRenderDimensions", () => {
  it("renders a portrait monitor near display size instead of delivery size", () => {
    expect(previewRenderDimensions(1080, 1920, 360, 640, 1, "auto")).toEqual({
      width: 406,
      height: 720,
      longEdge: 720,
    });
  });

  it("caps auto and proxy working resolutions", () => {
    expect(previewRenderDimensions(3840, 2160, 1920, 1080, 2, "auto").longEdge).toBe(1280);
    expect(previewRenderDimensions(3840, 2160, 1920, 1080, 2, "proxy").longEdge).toBe(960);
  });

  it("keeps original as a higher-resolution inspection mode without upscaling", () => {
    expect(previewRenderDimensions(3840, 2160, 800, 450, 1, "original").longEdge).toBe(960);
    expect(previewRenderDimensions(640, 360, 300, 170, 1, "original")).toEqual({
      width: 640,
      height: 360,
      longEdge: 640,
    });
  });
});
