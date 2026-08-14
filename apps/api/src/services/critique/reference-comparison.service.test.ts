import { describe, expect, it } from "vitest";
import { structuralFrameSignature, structuralSignatureDistance } from "./reference-comparison.service.js";

describe("deterministic reference frame signatures", () => {
  it("distinguishes a small title from a full-frame panel", () => {
    const small = new Uint8Array(20 * 10 * 4);
    const full = new Uint8Array(20 * 10 * 4);
    for (let y = 4; y <= 5; y++) for (let x = 7; x <= 12; x++) {
      const offset = (y * 20 + x) * 4;
      small.set([255, 255, 255, 255], offset);
    }
    for (let index = 0; index < 20 * 10; index++) full.set([180, 180, 180, 255], index * 4);
    const a = structuralFrameSignature(small, 20, 10);
    const b = structuralFrameSignature(full, 20, 10);
    expect(a.foreground!.width).toBeLessThan(b.foreground!.width);
    expect(structuralSignatureDistance(a, b)).toBeGreaterThan(0.25);
  });
});
