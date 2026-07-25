import type { TextAnimator, TextSplitMode } from "@tempo/types";

export interface TextAnimatorPreset {
  id: string;
  name: string;
  description: string;
  split: TextSplitMode;
  build: (clipDuration: number) => TextAnimator[];
}

function animator(input: TextAnimator): TextAnimator {
  return input;
}

/**
 * Built-in kinetic styles. Pack importers can use this same preset shape
 * without depending on the timing resolver or renderer.
 */
export const TEXT_ANIMATOR_PRESETS: TextAnimatorPreset[] = [
  {
    id: "typewriter",
    name: "Typewriter",
    description: "Characters appear one-by-one",
    split: "char",
    build: (clipDuration) => {
      const reveal = Math.min(Math.max(clipDuration * 0.7, 0.4), 2.5);
      const stagger = Math.min(0.08, reveal / 24);
      return [
        animator({
          property: "opacity",
          offsetSec: 0,
          durationSec: 0.02,
          staggerSec: stagger,
          from: 0,
          to: 1,
          ease: "linear",
        }),
      ];
    },
  },
  {
    id: "word-slam",
    name: "Word Slam",
    description: "Words punch in with rotation, scale, and color",
    split: "word",
    build: () => [
      animator({ property: "opacity", offsetSec: 0, durationSec: 0.18, staggerSec: 0.08, from: 0, to: 1, ease: "ease-out" }),
      animator({ property: "scale", offsetSec: 0, durationSec: 0.24, staggerSec: 0.08, from: 1.8, to: 1, ease: "ease-out" }),
      animator({ property: "rotation", offsetSec: 0, durationSec: 0.24, staggerSec: 0.08, from: -14, to: 0, ease: "ease-out" }),
      animator({ property: "color", offsetSec: 0, durationSec: 0.22, staggerSec: 0.08, from: 0, to: 1, fromColor: "#FFE500", toColor: "#FFFFFF", ease: "ease-out" }),
    ],
  },
  {
    id: "neon-cascade",
    name: "Neon Cascade",
    description: "Characters rise, sharpen, and shift from pink to white",
    split: "char",
    build: () => [
      animator({ property: "opacity", offsetSec: 0, durationSec: 0.28, staggerSec: 0.025, from: 0, to: 1, ease: "ease-out" }),
      animator({ property: "offsetY", offsetSec: 0, durationSec: 0.32, staggerSec: 0.025, from: 28, to: 0, ease: "ease-out" }),
      animator({ property: "blur", offsetSec: 0, durationSec: 0.28, staggerSec: 0.025, from: 8, to: 0, ease: "ease-out" }),
      animator({ property: "color", offsetSec: 0, durationSec: 0.32, staggerSec: 0.025, from: 0, to: 1, fromColor: "#FF36C8", toColor: "#FFFFFF", ease: "ease-out" }),
    ],
  },
  {
    id: "cascade-up",
    name: "Cascade Up",
    description: "Units rise and fade in with stagger",
    split: "char",
    build: () => [
      animator({ property: "opacity", offsetSec: 0, durationSec: 0.35, staggerSec: 0.03, from: 0, to: 1, ease: "ease-out" }),
      animator({ property: "offsetY", offsetSec: 0, durationSec: 0.4, staggerSec: 0.03, from: 24, to: 0, ease: "ease-out" }),
    ],
  },
  {
    id: "word-pop",
    name: "Word Pop",
    description: "Words scale in with fade",
    split: "word",
    build: () => [
      animator({ property: "opacity", offsetSec: 0, durationSec: 0.3, staggerSec: 0.1, from: 0, to: 1, ease: "ease-out" }),
      animator({ property: "scale", offsetSec: 0, durationSec: 0.35, staggerSec: 0.1, from: 0.4, to: 1, ease: "ease-out" }),
    ],
  },
  {
    id: "line-fade",
    name: "Line Fade",
    description: "Lines fade in sequentially",
    split: "line",
    build: () => [
      animator({ property: "opacity", offsetSec: 0, durationSec: 0.45, staggerSec: 0.2, from: 0, to: 1, ease: "ease-out" }),
      animator({ property: "offsetY", offsetSec: 0, durationSec: 0.45, staggerSec: 0.2, from: 16, to: 0, ease: "ease-out" }),
    ],
  },
];
