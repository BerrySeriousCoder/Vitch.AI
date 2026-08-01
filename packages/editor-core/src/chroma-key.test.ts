import { describe, expect, it } from "vitest";
import {
  applyChromaPreset,
  applySpillSuppress,
  computeChromaMatte,
  normalizeChromaKey,
  parseKeyColorRgb,
  validateChromaKey,
} from "./chroma-key";

describe("chroma-key core", () => {
  it("parses and normalizes hex", () => {
    expect(parseKeyColorRgb("#0f0")).toEqual({ r: 0, g: 1, b: 0 });
    const n = normalizeChromaKey({ keyColor: "#0f0", similarity: 2 });
    expect(n.keyColor).toBe("#00FF00");
    expect(n.similarity).toBe(1);
  });

  it("validates keyColor", () => {
    expect(validateChromaKey({ keyColor: "nope" }).ok).toBe(false);
    expect(validateChromaKey({ keyColor: "#00FF00" }).ok).toBe(true);
  });

  it("mattes exact key to ~0 and opposite to ~1", () => {
    const key = { r: 0, g: 1, b: 0 };
    const onKey = computeChromaMatte(key, key, 0.4, 0.1);
    expect(onKey).toBeLessThan(0.15);
    const red = computeChromaMatte({ r: 1, g: 0, b: 0 }, key, 0.4, 0.1);
    expect(red).toBeGreaterThan(0.85);
  });

  it("spill reduces green on fringe", () => {
    const key = { r: 0, g: 1, b: 0 };
    const fringe = { r: 0.2, g: 0.8, b: 0.2 };
    const out = applySpillSuppress(fringe, key, 0.3, 1);
    expect(out.g).toBeLessThan(fringe.g);
  });

  it("applies presets", () => {
    const g = applyChromaPreset("green-screen");
    expect(g?.screen).toBe("green");
    const b = applyChromaPreset("blue-screen");
    expect(b?.screen).toBe("blue");
    expect(applyChromaPreset("nope")).toBeNull();
  });
});
