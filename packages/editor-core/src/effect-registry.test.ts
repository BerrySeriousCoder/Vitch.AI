import { describe, expect, it } from "vitest";
import {
  getEffectDefinition,
  listEffectTypes,
  validateEffectParams,
  defaultEffectInstance,
  parseCubeLut,
  identityCubeLut,
  cinematicCubeLut,
  serializeCubeLut,
  getBuiltinLut,
  blendCubeLut,
} from "./index";

describe("escape-css effect registry", () => {
  it("registers input color transforms as frame-parity color effects", () => {
    const effect = getEffectDefinition("input-color-transform");
    expect(effect).toMatchObject({ category: "color", exportBackend: "frame" });
    expect(effect?.params.profile?.defaultValue).toBe("rec709");
  });
  it("registers primary grading alongside look effects", () => {
    const types = listEffectTypes();
    expect(types).toContain("color-curves");
    expect(types).toContain("color-grade");
    expect(types).toContain("hsl-secondary");
    expect(types).toContain("lift-gamma-gain");
    expect(types).toContain("levels");
    expect(types).toContain("vignette");
    expect(types).toContain("grain");
    expect(types).toContain("glow");
    expect(types).toContain("lut");
  });

  it("exposes exportBackend hints", () => {
    expect(getEffectDefinition("color-curves")?.exportBackend).toBe("frame");
    expect(getEffectDefinition("color-grade")?.exportBackend).toBe("frame");
    expect(getEffectDefinition("hsl-secondary")?.exportBackend).toBe("frame");
    expect(getEffectDefinition("lift-gamma-gain")?.exportBackend).toBe("frame");
    expect(getEffectDefinition("levels")?.exportBackend).toBe("frame");
    expect(getEffectDefinition("vignette")?.exportBackend).toBe("ffmpeg");
    expect(getEffectDefinition("grain")?.exportBackend).toBe("frame");
    expect(getEffectDefinition("glow")?.exportBackend).toBe("frame");
    expect(getEffectDefinition("lut")?.exportBackend).toBe("ffmpeg");
  });

  it("validates and clamps params", () => {
    const ok = validateEffectParams("glow", { intensity: 5, threshold: 0.2 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.params.intensity).toBe(2);
      expect(ok.params.threshold).toBe(0.2);
    }
    const bad = validateEffectParams("glow", { nope: 1 });
    expect(bad.ok).toBe(false);
  });

  it("validates the full primary-grade schema", () => {
    const result = validateEffectParams("color-grade", {
      exposure: 7,
      temperature: -20,
      highlights: -150,
      vibrance: 18,
    });
    expect(result).toEqual({
      ok: true,
      params: { exposure: 4, temperature: -20, highlights: -100, vibrance: 18 },
    });
  });

  it("validates and clamps HSL secondary controls", () => {
    const result = validateEffectParams("hsl-secondary", {
      hueCenter: 400,
      hueRange: 0,
      saturationMin: -1,
      saturationShift: 140,
    });
    expect(result).toEqual({
      ok: true,
      params: { hueCenter: 360, hueRange: 1, saturationMin: 0, saturationShift: 100 },
    });
  });

  it("validates and clamps Lift/Gamma/Gain controls", () => {
    const result = validateEffectParams("lift-gamma-gain", {
      liftRed: 2,
      gammaGreen: -2,
      gainMaster: 0.35,
    });
    expect(result).toEqual({
      ok: true,
      params: { liftRed: 1, gammaGreen: -1, gainMaster: 0.35 },
    });
  });

  it("validates and clamps Levels controls", () => {
    const result = validateEffectParams("levels", { inputBlack: -1, inputWhite: 2, gamma: 20 });
    expect(result).toEqual({ ok: true, params: { inputBlack: 0, inputWhite: 1, gamma: 10 } });
  });

  it("validates structured curve parameters", () => {
    const result = validateEffectParams("color-curves", {
      luma: [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }],
    });
    expect(result.ok).toBe(true);
    expect(
      validateEffectParams("color-curves", {
        red: [{ x: 0.1, y: 0 }, { x: 1, y: 1 }],
      }).ok
    ).toBe(false);
  });

  it("creates independent default curve arrays per effect instance", () => {
    const first = defaultEffectInstance("color-curves", "curves-a")!;
    const second = defaultEffectInstance("color-curves", "curves-b")!;
    (first.params.luma as Array<{ x: number; y: number }>)[0]!.y = 0.2;
    expect(second.params.luma).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it("builds default instances", () => {
    const lut = defaultEffectInstance("lut", "e1");
    expect(lut?.params.lutId).toBe("builtin:cinematic");
    expect(lut?.params.intensity).toBe(1);
  });
});

describe("cube lut parser", () => {
  it("round-trips identity", () => {
    const id = identityCubeLut(4);
    const text = serializeCubeLut(id);
    const parsed = parseCubeLut(text);
    expect(parsed.size).toBe(4);
    expect(parsed.data.length).toBe(4 * 4 * 4 * 3);
    expect(parsed.data[0]).toBeCloseTo(0);
    expect(parsed.data[parsed.data.length - 1]).toBeCloseTo(1);
  });

  it("loads builtins", () => {
    expect(getBuiltinLut("builtin:identity")?.title).toBe("Identity");
    expect(cinematicCubeLut(8).size).toBe(8);
  });

  it("rejects incomplete data", () => {
    expect(() =>
      parseCubeLut("LUT_3D_SIZE 2\n0 0 0\n1 1 1\n")
    ).toThrow(/incomplete/i);
  });

  it("remaps DOMAIN_MIN/MAX into 0..1", () => {
    const text = `TITLE "Dom"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 2 2 2
0 0 0
2 0 0
0 2 0
2 2 0
0 0 2
2 0 2
0 2 2
2 2 2
`;
    const parsed = parseCubeLut(text);
    expect(parsed.data[0]).toBeCloseTo(0);
    expect(parsed.data[parsed.data.length - 1]).toBeCloseTo(1);
  });

  it("blendCubeLut lerps toward identity", () => {
    const cine = cinematicCubeLut(4);
    const half = blendCubeLut(cine, 0.5);
    const id = identityCubeLut(4);
    expect(half.data[3]).toBeCloseTo((id.data[3]! + cine.data[3]!) / 2, 5);
  });
});
