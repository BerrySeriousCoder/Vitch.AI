import type { TextParams } from "@tempo/types";
import { applyTextAnimatorPreset } from "./text-animators";

export interface CaptionPreset {
  id: "broadcast" | "minimal" | "podcast" | "social-pop" | "karaoke";
  name: string;
  description: string;
  params: Partial<TextParams>;
  /** Defaults used while grouping timed transcript words into visual cues. */
  cue: { maxWords: number; maxCharsPerLine: number; maxLines: number; minDurationSec: number; maxDurationSec: number; gapSec: number };
}

const BASE_CUE = { maxWords: 8, maxCharsPerLine: 32, maxLines: 2, minDurationSec: 0.75, maxDurationSec: 4.5, gapSec: 0.65 };

export const CAPTION_PRESETS: readonly CaptionPreset[] = [
  {
    id: "broadcast", name: "Broadcast", description: "High-legibility lower-third captions for long-form edits.",
    params: { fontFamily: "Inter, sans-serif", fontSize: 38, fontWeight: "700", color: "#FFFFFF", textAlign: "center", lineHeight: 1.18, backgroundColor: "rgba(0,0,0,0.72)", backgroundPadding: 12, backgroundRadius: 10, maxWidth: 1420 }, cue: { ...BASE_CUE },
  },
  {
    id: "minimal", name: "Minimal", description: "Clean outlined subtitles with no backing box.",
    params: { fontFamily: "Inter, sans-serif", fontSize: 42, fontWeight: "600", color: "#FFFFFF", textAlign: "center", lineHeight: 1.2, stroke: "#000000", strokeWidth: 3, shadow: "0 2 8 rgba(0,0,0,0.7)", maxWidth: 1460 }, cue: { ...BASE_CUE, maxCharsPerLine: 36 },
  },
  {
    id: "podcast", name: "Podcast", description: "Warm, readable center captions for talking-head and interview cuts.",
    params: { fontFamily: "DM Sans, sans-serif", fontSize: 48, fontWeight: "700", color: "#FFFFFF", textAlign: "center", lineHeight: 1.14, backgroundColor: "rgba(8,12,20,0.78)", backgroundPadding: 16, backgroundRadius: 16, maxWidth: 1360 }, cue: { ...BASE_CUE, maxWords: 7, maxCharsPerLine: 29 },
  },
  {
    id: "social-pop", name: "Social Pop", description: "Word-by-word animated social captions, designed for frame export.",
    params: { fontFamily: "Montserrat, sans-serif", fontSize: 58, fontWeight: "800", color: "#FFFFFF", textAlign: "center", lineHeight: 1.08, stroke: "#111111", strokeWidth: 4, shadow: "0 4 12 rgba(0,0,0,0.65)", maxWidth: 1500 }, cue: { ...BASE_CUE, maxWords: 5, maxCharsPerLine: 24, maxLines: 2, maxDurationSec: 3.2 },
  },
  {
    id: "karaoke", name: "Karaoke", description: "Timed word highlighting for music, speeches, and emphasis-led captions.",
    params: { fontFamily: "Inter, sans-serif", fontSize: 52, fontWeight: "800", color: "#FFFFFF", textAlign: "center", lineHeight: 1.16, stroke: "#000000", strokeWidth: 3, karaokeActiveColor: "#FFE566", karaokeInactiveColor: "#FFFFFF", maxWidth: 1450 }, cue: { ...BASE_CUE, maxWords: 7, maxCharsPerLine: 28 },
  },
];

export function getCaptionPreset(id: unknown): CaptionPreset | undefined {
  return CAPTION_PRESETS.find((preset) => preset.id === id);
}

/** Applies a named caption look without touching transcript text or timing. */
export function applyCaptionPreset(params: TextParams, presetId: unknown, durationSec = 3): TextParams | null {
  const preset = getCaptionPreset(presetId);
  if (!preset) return null;
  let next: TextParams = { ...params, ...preset.params, captionPresetId: preset.id };
  if (preset.id === "social-pop") {
    const animated = applyTextAnimatorPreset(next, "word-slam", durationSec);
    next = { ...next, split: animated.split, animators: animated.animators };
  } else if (preset.id === "karaoke") {
    next = { ...next, split: "none", animators: [] };
  }
  return next;
}
