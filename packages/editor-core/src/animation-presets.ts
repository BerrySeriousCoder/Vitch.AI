import type { Keyframe, EasingType } from "@tempo/types";

export interface AnimationPreset {
  id: string;
  name: string;
  description: string;
  category: "text" | "shape";
  generateKeyframes: (clipDuration: number) => Keyframe[];
}

let kfCounter = 0;
function kfId() {
  return `kf-preset-${Date.now()}-${++kfCounter}`;
}

function kf(
  property: string,
  time: number,
  value: number | string | boolean,
  easing: EasingType = "linear"
): Keyframe {
  return { id: kfId(), property, time, value, easing };
}

export const TEXT_ANIMATION_PRESETS: AnimationPreset[] = [
  {
    id: "fade-in",
    name: "Fade In",
    description: "Opacity fades from 0 to 1",
    category: "text",
    generateKeyframes: () => [
      kf("opacity", 0, 0, "ease-out"),
      kf("opacity", 0.5, 1, "ease-out"),
    ],
  },
  {
    id: "slide-in-left",
    name: "Slide In Left",
    description: "Slides in from the left with fade",
    category: "text",
    generateKeyframes: () => [
      kf("transform.x", 0, -300, "ease-out"),
      kf("transform.x", 0.6, 0, "ease-out"),
      kf("opacity", 0, 0, "ease-out"),
      kf("opacity", 0.4, 1, "ease-out"),
    ],
  },
  {
    id: "slide-in-up",
    name: "Slide In Up",
    description: "Slides up from below with fade",
    category: "text",
    generateKeyframes: () => [
      kf("transform.y", 0, 150, "ease-out"),
      kf("transform.y", 0.6, 0, "ease-out"),
      kf("opacity", 0, 0, "ease-out"),
      kf("opacity", 0.4, 1, "ease-out"),
    ],
  },
  {
    id: "scale-up",
    name: "Scale Up",
    description: "Scales from 0 to full size",
    category: "text",
    generateKeyframes: () => [
      kf("transform.scaleX", 0, 0, "ease-out"),
      kf("transform.scaleX", 0.5, 1, "ease-out"),
      kf("transform.scaleY", 0, 0, "ease-out"),
      kf("transform.scaleY", 0.5, 1, "ease-out"),
      kf("opacity", 0, 0, "ease-out"),
      kf("opacity", 0.3, 1, "ease-out"),
    ],
  },
  {
    id: "bounce",
    name: "Bounce In",
    description: "Drops in with a bounce",
    category: "text",
    generateKeyframes: () => [
      kf("transform.y", 0, -200, "ease-in"),
      kf("transform.y", 0.3, 20, "ease-out"),
      kf("transform.y", 0.45, -8, "ease-in-out"),
      kf("transform.y", 0.6, 0, "ease-out"),
      kf("opacity", 0, 0, "linear"),
      kf("opacity", 0.15, 1, "linear"),
    ],
  },
  {
    id: "typewriter",
    name: "Typewriter",
    description: "Reveals text with a clip mask effect",
    category: "text",
    generateKeyframes: (duration) => {
      const revealTime = Math.min(duration * 0.8, 2);
      return [
        kf("transform.scaleX", 0, 0.01, "linear"),
        kf("transform.scaleX", revealTime, 1, "linear"),
      ];
    },
  },
  {
    id: "glitch",
    name: "Glitch",
    description: "Rapid position jitter",
    category: "text",
    generateKeyframes: () => {
      const keyframes: Keyframe[] = [];
      const steps = 12;
      // Deterministic jitter (not Math.random) so agent/UI previews match
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * 0.5;
        const offsetX = Math.sin(i * 2.7) * 10;
        const offsetY = Math.cos(i * 1.9) * 5;
        keyframes.push(kf("transform.x", t, offsetX, "linear"));
        keyframes.push(kf("transform.y", t, offsetY, "linear"));
      }
      keyframes.push(kf("transform.x", 0.5, 0, "ease-out"));
      keyframes.push(kf("transform.y", 0.5, 0, "ease-out"));
      return keyframes;
    },
  },
];

export const SHAPE_ANIMATION_PRESETS: AnimationPreset[] = [
  {
    id: "grow",
    name: "Grow",
    description: "Scale from 0 to full size",
    category: "shape",
    generateKeyframes: () => [
      kf("transform.scaleX", 0, 0, "ease-out"),
      kf("transform.scaleX", 0.5, 1, "ease-out"),
      kf("transform.scaleY", 0, 0, "ease-out"),
      kf("transform.scaleY", 0.5, 1, "ease-out"),
    ],
  },
  {
    id: "spin-in",
    name: "Spin In",
    description: "Rotates in while scaling up",
    category: "shape",
    generateKeyframes: () => [
      kf("transform.rotation", 0, 360, "ease-out"),
      kf("transform.rotation", 0.6, 0, "ease-out"),
      kf("transform.scaleX", 0, 0, "ease-out"),
      kf("transform.scaleX", 0.6, 1, "ease-out"),
      kf("transform.scaleY", 0, 0, "ease-out"),
      kf("transform.scaleY", 0.6, 1, "ease-out"),
      kf("opacity", 0, 0, "linear"),
      kf("opacity", 0.2, 1, "linear"),
    ],
  },
  {
    id: "draw-on",
    name: "Draw On",
    description: "Fades in with a scale wipe effect",
    category: "shape",
    generateKeyframes: () => [
      kf("transform.scaleX", 0, 0, "ease-in-out"),
      kf("transform.scaleX", 0.8, 1, "ease-in-out"),
      kf("opacity", 0, 0, "ease-in"),
      kf("opacity", 0.3, 1, "ease-out"),
    ],
  },
  {
    id: "pulse",
    name: "Pulse",
    description: "Repeating scale pulse",
    category: "shape",
    generateKeyframes: (duration) => {
      const keyframes: Keyframe[] = [];
      const pulseInterval = 0.8;
      const pulses = Math.floor(duration / pulseInterval);
      for (let i = 0; i <= pulses; i++) {
        const t = i * pulseInterval;
        if (t > duration) break;
        keyframes.push(kf("transform.scaleX", t, 1, "ease-in-out"));
        keyframes.push(kf("transform.scaleY", t, 1, "ease-in-out"));
        const peakT = t + pulseInterval * 0.5;
        if (peakT <= duration) {
          keyframes.push(kf("transform.scaleX", peakT, 1.15, "ease-in-out"));
          keyframes.push(kf("transform.scaleY", peakT, 1.15, "ease-in-out"));
        }
      }
      return keyframes;
    },
  },
];

const ALL_PRESETS = [...TEXT_ANIMATION_PRESETS, ...SHAPE_ANIMATION_PRESETS];

export function getAnimationPreset(presetId: string): AnimationPreset | undefined {
  return ALL_PRESETS.find((p) => p.id === presetId);
}

export function listAnimationPresetIds(category?: "text" | "shape"): string[] {
  return ALL_PRESETS.filter((p) => !category || p.category === category).map((p) => p.id);
}

/** Apply a preset onto a clip's keyframes (replaces existing keyframes). */
export function applyAnimationPresetToKeyframes(
  presetId: string,
  clipDuration: number
): Keyframe[] | null {
  const preset = getAnimationPreset(presetId);
  if (!preset) return null;
  return preset.generateKeyframes(clipDuration);
}
