import { describe, expect, it } from "vitest";
import { normalizeMask, validateMask, DEFAULT_MASK } from "./mask";

describe("mask", () => {
  it("defaults to soft ellipse", () => {
    expect(normalizeMask({})).toMatchObject({
      shape: "ellipse",
      feather: DEFAULT_MASK.feather,
    });
  });

  it("validates and clamps", () => {
    const ok = validateMask({
      shape: "rect",
      x: -1,
      y: 2,
      width: 0.5,
      height: 0.5,
      feather: 9,
      inverted: true,
      opacity: 0.5,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.x).toBe(0);
      expect(ok.value.y).toBe(1);
      expect(ok.value.feather).toBe(0.5);
      expect(ok.value.inverted).toBe(true);
    }
  });

  it("rejects non-finite numbers", () => {
    expect(validateMask({ shape: "rect", x: NaN }).ok).toBe(false);
    expect(validateMask({ shape: "ellipse", width: Infinity }).ok).toBe(false);
    expect(normalizeMask({ x: NaN as unknown as number }).x).toBe(DEFAULT_MASK.x);
  });

  it("rejects bad shape", () => {
    expect(validateMask({ shape: "bezier" }).ok).toBe(false);
  });
});
