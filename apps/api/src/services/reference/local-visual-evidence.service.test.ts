import { describe, expect, it } from "vitest";
import {
  connectedForegroundComponents,
  frameEvidence,
  selectVisualEventTimes,
} from "./local-visual-evidence.service.js";

describe("local reference visual evidence", () => {
  it("measures disconnected panel surfaces and their normalized bounds", () => {
    const width = 20;
    const height = 10;
    const pixels = new Uint8Array(width * height);
    for (let y = 1; y < 5; y++) for (let x = 1; x < 9; x++) pixels[y * width + x] = 220;
    for (let y = 5; y < 9; y++) for (let x = 11; x < 19; x++) pixels[y * width + x] = 180;
    const components = connectedForegroundComponents(pixels, width, height);
    expect(components).toHaveLength(2);
    expect(components[0]).toMatchObject({ x: 0.05, y: 0.1, width: 0.4, height: 0.4 });
  });

  it("retains pixel-change peaks as internal animation events", () => {
    const scores = [0, 0.01, 0.09, 0.01, 0.02, 0.11, 0.01];
    const frames = scores.map((changeScore, index) => ({
      time: index / 10,
      changeScore,
      meanLuma: 0.2,
      blackRatio: 0.5,
      components: [],
    }));
    expect(selectVisualEventTimes(frames, 10)).toEqual([0.2, 0.5]);
  });

  it("tracks foreground geometry independently of prose interpretation", () => {
    const pixels = new Uint8Array(100);
    for (let y = 2; y <= 5; y++) for (let x = 3; x <= 7; x++) pixels[y * 10 + x] = 255;
    const evidence = frameEvidence(pixels, undefined, 10, 10, 0);
    expect(evidence.foreground).toEqual({ x: 0.3, y: 0.2, width: 0.5, height: 0.4 });
  });
});
