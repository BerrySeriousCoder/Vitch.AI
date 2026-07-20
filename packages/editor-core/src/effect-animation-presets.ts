import type { EasingType, Keyframe } from "@tempo/types";

export interface EffectAnimationPreset {
  id: string;
  name: string;
  description: string;
  /** Effect type this preset targets (e.g. blur, glow) */
  effectType: string;
  generateKeyframes: (clipDuration: number) => Keyframe[];
}

let kfCounter = 0;
function kfId() {
  return `efx-preset-${Date.now()}-${++kfCounter}`;
}

function kf(
  property: string,
  time: number,
  value: number | string | boolean,
  easing: EasingType = "linear"
): Keyframe {
  return { id: kfId(), property, time, value, easing };
}

export const EFFECT_ANIMATION_PRESETS: EffectAnimationPreset[] = [
  {
    id: "fade-in-blur",
    name: "Fade-in Blur",
    description: "Blur amount eases from high to zero",
    effectType: "blur",
    generateKeyframes: (duration) => {
      const end = Math.min(0.6, Math.max(0.2, duration * 0.4));
      return [kf("value", 0, 12, "ease-out"), kf("value", end, 0, "ease-out")];
    },
  },
  {
    id: "pulse-glow",
    name: "Pulse Glow",
    description: "Glow intensity pulses once",
    effectType: "glow",
    generateKeyframes: (duration) => {
      const mid = Math.min(0.5, duration * 0.35);
      const end = Math.min(duration, mid + mid);
      return [
        kf("intensity", 0, 0, "ease-in"),
        kf("intensity", mid, 1.2, "ease-in-out"),
        kf("intensity", end, 0, "ease-out"),
      ];
    },
  },
  {
    id: "vignette-in",
    name: "Vignette In",
    description: "Vignette amount fades in",
    effectType: "vignette",
    generateKeyframes: (duration) => {
      const end = Math.min(0.8, Math.max(0.3, duration * 0.5));
      return [kf("amount", 0, 0, "ease-out"), kf("amount", end, 0.7, "ease-out")];
    },
  },
  {
    id: "grain-settle",
    name: "Grain Settle",
    description: "Grain amount settles from heavy to light",
    effectType: "grain",
    generateKeyframes: (duration) => {
      const end = Math.min(1, Math.max(0.4, duration * 0.5));
      return [kf("amount", 0, 0.45, "ease-out"), kf("amount", end, 0.12, "ease-out")];
    },
  },
];

export function getEffectAnimationPreset(
  presetId: string
): EffectAnimationPreset | undefined {
  return EFFECT_ANIMATION_PRESETS.find((p) => p.id === presetId);
}

export function listEffectAnimationPresetIds(effectType?: string): string[] {
  return EFFECT_ANIMATION_PRESETS.filter(
    (p) => !effectType || p.effectType === effectType
  ).map((p) => p.id);
}

export function applyEffectAnimationPresetToKeyframes(
  presetId: string,
  clipDuration: number
): { effectType: string; keyframes: Keyframe[] } | null {
  const preset = getEffectAnimationPreset(presetId);
  if (!preset) return null;
  return {
    effectType: preset.effectType,
    keyframes: preset.generateKeyframes(clipDuration),
  };
}
