import { describe, expect, it } from "vitest";
import type { BlueprintNormalizedRect } from "@tempo/types";
import {
  measurePanelRevealFromFrames,
  type PanelRevealDirection,
} from "./panel-reveal-measurement.service.js";

function syntheticReveal(direction: PanelRevealDirection) {
  const width = 80;
  const height = 48;
  const viewport: BlueprintNormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
  const frames: Uint8Array[] = [];
  const progress = [0, 0.2, 0.38, 0.48, 0.5, 0.52, 0.62, 0.8, 1];
  for (const amount of progress) {
    const pixels = new Uint8Array(width * height);
    const visibleWidth = Math.round(width * amount);
    const visibleHeight = Math.round(height * amount);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const visible = direction === "left-to-right" ? x < visibleWidth
          : direction === "right-to-left" ? x >= width - visibleWidth
            : direction === "top-to-bottom" ? y < visibleHeight
              : y >= height - visibleHeight;
        if (visible) pixels[y * width + x] = 180 + ((x + y) % 40);
      }
    }
    frames.push(pixels);
  }
  return { frames, width, height, viewport };
}

describe("local panel reveal measurement", () => {
  for (const direction of [
    "left-to-right",
    "right-to-left",
    "top-to-bottom",
    "bottom-to-top",
  ] as const) {
    it(`measures a ${direction} expansion`, () => {
      const fixture = syntheticReveal(direction);
      const measured = measurePanelRevealFromFrames({
        ...fixture,
        searchStartFrame: 0,
        searchEndFrame: fixture.frames.length - 1,
      });
      expect(measured?.direction).toBe(direction);
      expect(measured?.startFrame).toBe(0);
      expect(measured?.endFrame).toBe(fixture.frames.length - 1);
      expect(measured?.progress[0]).toBe(0);
      expect(measured?.progress.at(-1)).toBe(1);
      expect(measured?.progress[Math.floor(measured.progress.length / 2)]).toBeCloseTo(0.5, 1);
    });
  }
});
