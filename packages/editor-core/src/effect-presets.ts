import type { Effect } from "@tempo/types";

export interface EffectPreset {
  id: string;
  name: string;
  description: string;
  effects: Omit<Effect, "id">[];
}

export const EFFECT_PRESETS: EffectPreset[] = [
  {
    id: "soft-fade-levels",
    name: "Soft Fade Levels",
    description: "Lifted blacks and softened whites for a restrained matte finish",
    effects: [
      {
        type: "levels",
        name: "Levels",
        enabled: true,
        params: { inputBlack: 0.03, inputWhite: 0.98, gamma: 1.03, outputBlack: 0.05, outputWhite: 0.94 },
        keyframes: [],
      },
    ],
  },
  {
    id: "cinematic-split-tone",
    name: "Cinematic Split Tone",
    description: "Cooler shadows and gently warmer highlights using professional color wheels",
    effects: [
      {
        type: "lift-gamma-gain",
        name: "Lift / Gamma / Gain",
        enabled: true,
        params: {
          liftRed: -0.05,
          liftGreen: 0.01,
          liftBlue: 0.1,
          liftMaster: -0.03,
          gammaRed: 0.02,
          gammaGreen: 0,
          gammaBlue: 0.01,
          gammaMaster: 0,
          gainRed: 0.1,
          gainGreen: 0.03,
          gainBlue: -0.04,
          gainMaster: 0.04,
        },
        keyframes: [],
      },
    ],
  },
  {
    id: "skin-warmth",
    name: "Skin Warmth",
    description: "Gently warms and enriches warm skin tones without moving the background",
    effects: [
      {
        type: "hsl-secondary",
        name: "HSL Secondary",
        enabled: true,
        params: {
          hueCenter: 28,
          hueRange: 24,
          saturationMin: 0.12,
          saturationMax: 0.9,
          lightnessMin: 0.12,
          lightnessMax: 0.9,
          feather: 0.18,
          hueShift: -5,
          saturationShift: 10,
          lightnessShift: 3,
          mix: 0.75,
        },
        keyframes: [],
      },
    ],
  },
  {
    id: "soft-s-curve",
    name: "Soft S-Curve",
    description: "Gentle contrast with protected shadows and highlights",
    effects: [
      {
        type: "color-curves",
        name: "RGB / Luma Curves",
        enabled: true,
        params: {
          luma: [{ x: 0, y: 0.03 }, { x: 0.24, y: 0.18 }, { x: 0.72, y: 0.82 }, { x: 1, y: 0.97 }],
          red: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        },
        keyframes: [],
      },
    ],
  },
  {
    id: "warm-punch",
    name: "Warm Punch",
    description: "Warm, rich correction for energetic social edits",
    effects: [
      {
        type: "color-grade",
        name: "Primary Color Grade",
        enabled: true,
        params: {
          exposure: 0.2,
          contrast: 14,
          saturation: 8,
          temperature: 22,
          tint: 4,
          shadows: 10,
          highlights: -14,
          blacks: -6,
          whites: 8,
          vibrance: 18,
        },
        keyframes: [],
      },
    ],
  },
  {
    id: "cool-matte",
    name: "Cool Matte",
    description: "Soft blue-toned grade with protected highlights",
    effects: [
      {
        type: "color-grade",
        name: "Primary Color Grade",
        enabled: true,
        params: {
          exposure: 0.1,
          contrast: -8,
          saturation: -12,
          temperature: -18,
          tint: 2,
          shadows: 18,
          highlights: -24,
          blacks: 12,
          whites: -6,
          vibrance: 6,
        },
        keyframes: [],
      },
    ],
  },
  {
    id: "cinematic",
    name: "Cinematic",
    description: "Warm, desaturated look",
    effects: [
      {
        type: "contrast",
        name: "Contrast",
        enabled: true,
        params: { value: 1.15 },
        keyframes: [],
      },
      {
        type: "saturate",
        name: "Saturation",
        enabled: true,
        params: { value: 0.8 },
        keyframes: [],
      },
    ],
  },
  {
    id: "black-and-white",
    name: "Black & White",
    description: "Full grayscale conversion",
    effects: [
      {
        type: "grayscale",
        name: "Grayscale",
        enabled: true,
        params: { value: 100 },
        keyframes: [],
      },
      {
        type: "contrast",
        name: "Contrast",
        enabled: true,
        params: { value: 1.1 },
        keyframes: [],
      },
    ],
  },
  {
    id: "vintage",
    name: "Vintage",
    description: "Warm sepia tone",
    effects: [
      {
        type: "sepia",
        name: "Sepia",
        enabled: true,
        params: { value: 60 },
        keyframes: [],
      },
      {
        type: "saturate",
        name: "Saturation",
        enabled: true,
        params: { value: 0.7 },
        keyframes: [],
      },
    ],
  },
  {
    id: "high-contrast",
    name: "High Contrast",
    description: "Bold, punchy look",
    effects: [
      {
        type: "contrast",
        name: "Contrast",
        enabled: true,
        params: { value: 1.5 },
        keyframes: [],
      },
      {
        type: "brightness",
        name: "Brightness",
        enabled: true,
        params: { value: 1.1 },
        keyframes: [],
      },
    ],
  },
  {
    id: "dream",
    name: "Dream",
    description: "Soft glow effect",
    effects: [
      {
        type: "blur",
        name: "Blur",
        enabled: true,
        params: { value: 1.5 },
        keyframes: [],
      },
      {
        type: "brightness",
        name: "Brightness",
        enabled: true,
        params: { value: 1.2 },
        keyframes: [],
      },
      {
        type: "saturate",
        name: "Saturation",
        enabled: true,
        params: { value: 1.3 },
        keyframes: [],
      },
    ],
  },
  {
    id: "negative",
    name: "Negative",
    description: "Color inversion",
    effects: [
      {
        type: "invert",
        name: "Invert",
        enabled: true,
        params: { value: 100 },
        keyframes: [],
      },
    ],
  },
];

export function getEffectPreset(idOrName: string): EffectPreset | undefined {
  const key = idOrName.toLowerCase().trim();
  return EFFECT_PRESETS.find(
    (p) =>
      p.id === key ||
      p.name.toLowerCase() === key ||
      p.id.replace(/-/g, " ") === key
  );
}

export function listEffectPresetIds(): string[] {
  return EFFECT_PRESETS.map((p) => p.id);
}
