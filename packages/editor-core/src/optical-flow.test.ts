import { describe, expect, it } from "vitest";
import { estimateFeatureTranslation, estimateTranslationalFlow } from "./optical-flow";
describe("optical flow", () => it("finds a translated luma feature", () => {
  const w = 40, h = 32, a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  for (let y = 10; y < 18; y++) for (let x = 10; x < 18; x++) { a[y*w+x] = 255; b[y*w+x+3] = 255; }
  const flow = estimateTranslationalFlow(a, b, w, h, 5);
  expect(flow.dx).toBe(3); expect(flow.dy).toBe(0);
}));

describe("feature flow", () => it("finds a local patch translation", () => {
  const w = 48, h = 40, a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  for (let y = 14; y < 24; y++) for (let x = 14; x < 24; x++) { const value = (x * 17 + y * 11) % 255; a[y*w+x] = value; b[(y+2)*w+x+4] = value; }
  expect(estimateFeatureTranslation(a, b, w, h, 19, 19, 4, 6)).toMatchObject({ dx: 4, dy: 2 });
}));
