import { describe, expect, it } from "vitest";
import { resolveMediaGeometry, resolveMediaLayoutAtTime } from "./media-geometry";

describe("resolveMediaGeometry", () => {
  it("contains landscape media in a portrait composition without distortion", () => {
    const result = resolveMediaGeometry({
      sourceWidth: 1920,
      sourceHeight: 1080,
      compositionWidth: 1080,
      compositionHeight: 1920,
    });
    expect(result.fit).toBe("contain");
    expect(result.destinationRect).toMatchObject({ x: 0, width: 1080 });
    expect(result.destinationRect.height).toBeCloseTo(607.5);
    expect(result.destinationRect.y).toBeCloseTo(656.25);
    expect(result.distortsAspectRatio).toBe(false);
  });

  it("covers a portrait composition by cropping source UV around the focal point", () => {
    const result = resolveMediaGeometry({
      sourceWidth: 1920,
      sourceHeight: 1080,
      compositionWidth: 1080,
      compositionHeight: 1920,
      mediaLayout: { schemaVersion: 1, fit: "cover", focalPoint: { x: 0.75, y: 0.5 } },
    });
    expect(result.destinationRect).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(result.sourceUvRect.width).toBeCloseTo(0.31640625);
    expect(result.sourceUvRect.x).toBeGreaterThan(0.5);
    expect(result.distortsAspectRatio).toBe(false);
  });

  it("uses the cropped source aspect for legacy clips", () => {
    const result = resolveMediaGeometry({
      sourceWidth: 1920,
      sourceHeight: 1080,
      compositionWidth: 1080,
      compositionHeight: 1920,
      crop: { x: 0.341796875, y: 0, width: 0.31640625, height: 1 },
    });
    expect(result.destinationRect).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(result.distortsAspectRatio).toBe(false);
  });

  it("marks only explicit fill as distorted", () => {
    const result = resolveMediaGeometry({
      sourceWidth: 1920,
      sourceHeight: 1080,
      compositionWidth: 1080,
      compositionHeight: 1920,
      mediaLayout: { schemaVersion: 1, fit: "fill" },
    });
    expect(result.destinationRect).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(result.distortsAspectRatio).toBe(true);
  });

  it("covers an exact collage cell without stretching the source", () => {
    const result = resolveMediaGeometry({
      sourceWidth: 1920,
      sourceHeight: 1080,
      compositionWidth: 1080,
      compositionHeight: 1920,
      mediaLayout: {
        schemaVersion: 1,
        fit: "cover",
        viewport: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
      },
    });
    expect(result.destinationRect).toEqual({ x: 540, y: 960, width: 540, height: 960 });
    expect(result.sourceUvRect.width).toBeCloseTo(0.31640625);
    expect(result.distortsAspectRatio).toBe(false);
  });

  it("interpolates an animated viewport independently from source crop", () => {
    const layout = resolveMediaLayoutAtTime(
      { schemaVersion: 1, fit: "cover", viewport: { x: 0, y: 0, width: 0.05, height: 0.5 } },
      [
        { id: "a", property: "mediaLayout.viewport.width", time: 0, value: 0.05, easing: "linear" },
        { id: "b", property: "mediaLayout.viewport.width", time: 1, value: 0.5, easing: "linear" },
      ],
      0.5
    );
    expect(layout?.viewport).toMatchObject({ x: 0, y: 0, height: 0.5 });
    expect(layout?.viewport?.width).toBeCloseTo(0.275);
  });
});
