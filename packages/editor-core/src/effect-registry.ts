import type { ColorCurves, Effect, EffectParamValue, HslSecondary, Levels, LiftGammaGain, PrimaryColorGrade } from "@tempo/types";
import { DEFAULT_PRIMARY_COLOR_GRADE } from "./color-grade";
import { createDefaultCurve, validateCurvePoints } from "./color-curves";
import { DEFAULT_LIFT_GAMMA_GAIN } from "./color-wheels";
import { DEFAULT_LEVELS } from "./levels";
import { DEFAULT_HSL_SECONDARY } from "./hsl-secondary";

export type EffectPreviewBackend = "webgpu";
export type EffectExportBackend = "ffmpeg" | "frame" | "approx";

export interface EffectParamDefinition {
  type: "number" | "string" | "boolean" | "color" | "curve";
  label: string;
  defaultValue: EffectParamValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  keyframeable?: boolean;
}

export interface EffectDefinition {
  type: string;
  name: string;
  category: "color" | "blur" | "distort" | "stylize";
  params: Record<string, EffectParamDefinition>;
  previewBackend: EffectPreviewBackend;
  /** How export should treat this effect until frame-path parity */
  exportBackend?: EffectExportBackend;
  /** WGSL / pipeline id hint for the WebGPU compositor */
  shaderId: string;
}

const registry = new Map<string, EffectDefinition>();

export function registerEffect(def: EffectDefinition): void {
  registry.set(def.type, def);
}

export function getEffectDefinition(type: string): EffectDefinition | undefined {
  return registry.get(type);
}

export function listEffectDefinitions(): EffectDefinition[] {
  return Array.from(registry.values());
}

export function listEffectTypes(): string[] {
  return listEffectDefinitions().map((e) => e.type);
}

export function getEffectSchema(type: string): EffectDefinition | undefined {
  return getEffectDefinition(type);
}

export function defaultEffectInstance(
  type: string,
  id: string
): Omit<Effect, "keyframes"> & { keyframes: Effect["keyframes"] } | null {
  const def = getEffectDefinition(type);
  if (!def) return null;
  const params: Record<string, EffectParamValue> = {};
  for (const [key, p] of Object.entries(def.params)) {
    params[key] = Array.isArray(p.defaultValue)
      ? p.defaultValue.map((point) => ({ ...point }))
      : p.defaultValue;
  }
  return {
    id,
    type: def.type,
    name: def.name,
    enabled: true,
    params,
    keyframes: [],
  };
}

/** Merge/validate partial params against the registered schema. */
export function validateEffectParams(
  type: string,
  partial: Record<string, EffectParamValue>
):
  | { ok: true; params: Record<string, EffectParamValue> }
  | { ok: false; message: string } {
  const def = getEffectDefinition(type);
  if (!def) return { ok: false, message: `Unknown effect type "${type}"` };
  const out: Record<string, EffectParamValue> = {};
  for (const [key, value] of Object.entries(partial)) {
    const schema = def.params[key];
    if (!schema) {
      return { ok: false, message: `Unknown param "${key}" for effect ${type}` };
    }
    if (schema.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, message: `Param "${key}" must be a number` };
      }
      let n = value;
      if (schema.min != null) n = Math.max(schema.min, n);
      if (schema.max != null) n = Math.min(schema.max, n);
      out[key] = n;
    } else if (schema.type === "boolean") {
      if (typeof value !== "boolean") {
        return { ok: false, message: `Param "${key}" must be a boolean` };
      }
      out[key] = value;
    } else if (schema.type === "curve") {
      const curve = validateCurvePoints(value);
      if (!curve.ok) return { ok: false, message: `Param "${key}" ${curve.message}` };
      out[key] = curve.value;
    } else {
      if (typeof value !== "string") {
        return { ok: false, message: `Param "${key}" must be a string` };
      }
      out[key] = String(value);
    }
  }
  return { ok: true, params: out };
}

function numParam(
  label: string,
  defaultValue: number,
  min: number,
  max: number,
  step: number,
  unit?: string
): EffectParamDefinition {
  return {
    type: "number",
    label,
    defaultValue,
    min,
    max,
    step,
    unit,
    keyframeable: true,
  };
}

function strParam(
  label: string,
  defaultValue: string
): EffectParamDefinition {
  return {
    type: "string",
    label,
    defaultValue,
    keyframeable: false,
  };
}

function curveParam(label: string): EffectParamDefinition {
  return {
    type: "curve",
    label,
    defaultValue: createDefaultCurve(),
    keyframeable: false,
  };
}

registerEffect({
  type: "input-color-transform",
  name: "Input Color Transform",
  category: "color",
  previewBackend: "webgpu",
  // Conversion happens before all grades in the shared WebGPU layer pipeline.
  exportBackend: "frame",
  shaderId: "input-color-transform",
  params: {
    profile: strParam("Input Profile", "rec709"),
    exposureCompensation: numParam("Exposure Compensation", 0, -4, 4, 0.05, " EV"),
  },
});

registerEffect({
  type: "color-curves",
  name: "RGB / Luma Curves",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "color-curves",
  params: {
    luma: curveParam("Luma"),
    red: curveParam("Red"),
    green: curveParam("Green"),
    blue: curveParam("Blue"),
  } satisfies Record<keyof ColorCurves, EffectParamDefinition>,
});

registerEffect({
  type: "color-grade",
  name: "Primary Color Grade",
  category: "color",
  previewBackend: "webgpu",
  // Primary grading has deliberate WebGPU semantics; the frame exporter runs
  // that same compositor rather than maintaining a lossy FFmpeg approximation.
  exportBackend: "frame",
  shaderId: "primary-color-grade",
  params: {
    exposure: numParam("Exposure", DEFAULT_PRIMARY_COLOR_GRADE.exposure, -4, 4, 0.05, " EV"),
    contrast: numParam("Contrast", DEFAULT_PRIMARY_COLOR_GRADE.contrast, -100, 100, 1, "%"),
    saturation: numParam("Saturation", DEFAULT_PRIMARY_COLOR_GRADE.saturation, -100, 100, 1, "%"),
    temperature: numParam("Temperature", DEFAULT_PRIMARY_COLOR_GRADE.temperature, -100, 100, 1),
    tint: numParam("Tint", DEFAULT_PRIMARY_COLOR_GRADE.tint, -100, 100, 1),
    shadows: numParam("Shadows", DEFAULT_PRIMARY_COLOR_GRADE.shadows, -100, 100, 1, "%"),
    highlights: numParam("Highlights", DEFAULT_PRIMARY_COLOR_GRADE.highlights, -100, 100, 1, "%"),
    blacks: numParam("Blacks", DEFAULT_PRIMARY_COLOR_GRADE.blacks, -100, 100, 1, "%"),
    whites: numParam("Whites", DEFAULT_PRIMARY_COLOR_GRADE.whites, -100, 100, 1, "%"),
    vibrance: numParam("Vibrance", DEFAULT_PRIMARY_COLOR_GRADE.vibrance, -100, 100, 1, "%"),
  } satisfies Record<keyof PrimaryColorGrade, EffectParamDefinition>,
});

registerEffect({
  type: "hsl-secondary",
  name: "HSL Secondary",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "hsl-secondary",
  params: {
    hueCenter: numParam("Hue Center", DEFAULT_HSL_SECONDARY.hueCenter, 0, 360, 1, "°"),
    hueRange: numParam("Hue Range", DEFAULT_HSL_SECONDARY.hueRange, 1, 180, 1, "°"),
    saturationMin: numParam("Saturation Min", DEFAULT_HSL_SECONDARY.saturationMin, 0, 1, 0.01),
    saturationMax: numParam("Saturation Max", DEFAULT_HSL_SECONDARY.saturationMax, 0, 1, 0.01),
    lightnessMin: numParam("Lightness Min", DEFAULT_HSL_SECONDARY.lightnessMin, 0, 1, 0.01),
    lightnessMax: numParam("Lightness Max", DEFAULT_HSL_SECONDARY.lightnessMax, 0, 1, 0.01),
    feather: numParam("Qualifier Feather", DEFAULT_HSL_SECONDARY.feather, 0, 1, 0.01),
    hueShift: numParam("Hue Shift", DEFAULT_HSL_SECONDARY.hueShift, -180, 180, 1, "°"),
    saturationShift: numParam("Saturation Shift", DEFAULT_HSL_SECONDARY.saturationShift, -100, 100, 1, "%"),
    lightnessShift: numParam("Lightness Shift", DEFAULT_HSL_SECONDARY.lightnessShift, -100, 100, 1, "%"),
    mix: numParam("Mix", DEFAULT_HSL_SECONDARY.mix, 0, 1, 0.01),
  } satisfies Record<keyof HslSecondary, EffectParamDefinition>,
});

registerEffect({
  type: "lift-gamma-gain",
  name: "Lift / Gamma / Gain",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "lift-gamma-gain",
  params: {
    liftRed: numParam("Lift Red", DEFAULT_LIFT_GAMMA_GAIN.liftRed, -1, 1, 0.01),
    liftGreen: numParam("Lift Green", DEFAULT_LIFT_GAMMA_GAIN.liftGreen, -1, 1, 0.01),
    liftBlue: numParam("Lift Blue", DEFAULT_LIFT_GAMMA_GAIN.liftBlue, -1, 1, 0.01),
    liftMaster: numParam("Lift Master", DEFAULT_LIFT_GAMMA_GAIN.liftMaster, -1, 1, 0.01),
    gammaRed: numParam("Gamma Red", DEFAULT_LIFT_GAMMA_GAIN.gammaRed, -1, 1, 0.01),
    gammaGreen: numParam("Gamma Green", DEFAULT_LIFT_GAMMA_GAIN.gammaGreen, -1, 1, 0.01),
    gammaBlue: numParam("Gamma Blue", DEFAULT_LIFT_GAMMA_GAIN.gammaBlue, -1, 1, 0.01),
    gammaMaster: numParam("Gamma Master", DEFAULT_LIFT_GAMMA_GAIN.gammaMaster, -1, 1, 0.01),
    gainRed: numParam("Gain Red", DEFAULT_LIFT_GAMMA_GAIN.gainRed, -1, 1, 0.01),
    gainGreen: numParam("Gain Green", DEFAULT_LIFT_GAMMA_GAIN.gainGreen, -1, 1, 0.01),
    gainBlue: numParam("Gain Blue", DEFAULT_LIFT_GAMMA_GAIN.gainBlue, -1, 1, 0.01),
    gainMaster: numParam("Gain Master", DEFAULT_LIFT_GAMMA_GAIN.gainMaster, -1, 1, 0.01),
  } satisfies Record<keyof LiftGammaGain, EffectParamDefinition>,
});

registerEffect({
  type: "levels",
  name: "Levels",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "levels",
  params: {
    inputBlack: numParam("Input Black", DEFAULT_LEVELS.inputBlack, 0, 1, 0.01),
    inputWhite: numParam("Input White", DEFAULT_LEVELS.inputWhite, 0, 1, 0.01),
    gamma: numParam("Midtone Gamma", DEFAULT_LEVELS.gamma, 0.1, 10, 0.01),
    outputBlack: numParam("Output Black", DEFAULT_LEVELS.outputBlack, 0, 1, 0.01),
    outputWhite: numParam("Output White", DEFAULT_LEVELS.outputWhite, 0, 1, 0.01),
  } satisfies Record<keyof Levels, EffectParamDefinition>,
});

registerEffect({
  type: "clarity",
  name: "Clarity",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "detail-enhance",
  params: { amount: numParam("Amount", 0, -1, 1, 0.01) },
});

registerEffect({
  type: "dehaze",
  name: "Dehaze",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "detail-enhance",
  params: { amount: numParam("Amount", 0, 0, 1, 0.01) },
});

registerEffect({
  type: "sharpen",
  name: "Sharpen",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "detail-enhance",
  params: { amount: numParam("Amount", 0, 0, 2, 0.01) },
});

registerEffect({
  type: "posterize",
  name: "Posterize",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "post-stylize",
  params: { levels: numParam("Levels", 8, 2, 32, 1) },
});

registerEffect({
  type: "chromatic-aberration",
  name: "Chromatic Aberration",
  category: "distort",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "post-stylize",
  params: { amount: numParam("Amount", 0, 0, 1, 0.01) },
});

registerEffect({
  type: "light-leak",
  name: "Light Leak",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "post-stylize",
  params: {
    amount: numParam("Amount", 0, 0, 1, 0.01),
    position: numParam("Position", 0.2, 0, 1, 0.01),
  },
});

registerEffect({
  type: "brightness",
  name: "Brightness",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "color-grade",
  params: { value: numParam("Amount", 1, 0, 3, 0.05) },
});

registerEffect({
  type: "contrast",
  name: "Contrast",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "color-grade",
  params: { value: numParam("Amount", 1, 0, 3, 0.05) },
});

registerEffect({
  type: "saturate",
  name: "Saturation",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "color-grade",
  params: { value: numParam("Amount", 1, 0, 3, 0.05) },
});

registerEffect({
  type: "hue-rotate",
  name: "Hue Rotate",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "color-grade",
  params: { value: numParam("Degrees", 0, 0, 360, 1, "deg") },
});

registerEffect({
  type: "blur",
  name: "Blur",
  category: "blur",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "blur",
  params: { value: numParam("Radius", 0, 0, 24, 0.5, "px") },
});

registerEffect({
  type: "grayscale",
  name: "Grayscale",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "color-grade",
  params: { value: numParam("Amount", 100, 0, 100, 1, "%") },
});

registerEffect({
  type: "sepia",
  name: "Sepia",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "color-grade",
  params: { value: numParam("Amount", 100, 0, 100, 1, "%") },
});

registerEffect({
  type: "invert",
  name: "Invert",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "color-grade",
  params: { value: numParam("Amount", 100, 0, 100, 1, "%") },
});

registerEffect({
  type: "vignette",
  name: "Vignette",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "vignette",
  params: {
    amount: numParam("Amount", 0.45, 0, 1, 0.01),
    softness: numParam("Softness", 0.5, 0, 1, 0.01),
  },
});

registerEffect({
  type: "grain",
  name: "Film Grain",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "grain",
  params: {
    amount: numParam("Amount", 0.25, 0, 1, 0.01),
    size: numParam("Size", 1, 0.5, 3, 0.05),
  },
});

registerEffect({
  type: "glow",
  name: "Soft Glow",
  category: "stylize",
  previewBackend: "webgpu",
  exportBackend: "frame",
  shaderId: "glow",
  params: {
    intensity: numParam("Intensity", 0.6, 0, 2, 0.05),
    threshold: numParam("Threshold", 0.55, 0, 1, 0.01),
    radius: numParam("Radius", 8, 0, 24, 0.5, "px"),
  },
});

registerEffect({
  type: "lut",
  name: "LUT",
  category: "color",
  previewBackend: "webgpu",
  exportBackend: "ffmpeg",
  shaderId: "lut3d",
  params: {
    lutId: strParam("LUT", "builtin:cinematic"),
    intensity: numParam("Intensity", 1, 0, 1, 0.01),
  },
});
