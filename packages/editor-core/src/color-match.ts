import type { Clip, ColorStatistics, PrimaryColorGrade, Track } from "@tempo/types";
import { DEFAULT_PRIMARY_COLOR_GRADE, normalizePrimaryColorGrade } from "./color-grade";

export interface ColorMatchProposal {
  grade: PrimaryColorGrade;
  confidence: number;
}

export interface ApplyColorMatchResult {
  tracks: Track[];
  effectId: string;
  created: boolean;
  proposal: ColorMatchProposal;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A conservative neutral profile for reference-only Style DNA application. */
export const NEUTRAL_COLOR_STATISTICS: ColorStatistics = {
  meanRed: 0.5,
  meanGreen: 0.5,
  meanBlue: 0.5,
  meanLuma: 0.5,
  lumaStdDev: 0.22,
  meanSaturation: 0.38,
  blackPoint: 0.04,
  whitePoint: 0.96,
  sampleCount: 0,
  sampledAt: "",
  source: "palette",
};

/** Turn a Gemini/vision palette into a conservative fallback profile. */
export function colorStatisticsFromPalette(colors: readonly string[] | null | undefined): ColorStatistics | null {
  const parsed = (colors || []).map((color) => {
    const match = String(color).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!match) return null;
    const hex = match[1]!;
    return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255] as const;
  }).filter((value): value is readonly [number, number, number] => value !== null);
  if (parsed.length === 0) return null;
  const meanRed = parsed.reduce((sum, color) => sum + color[0], 0) / parsed.length;
  const meanGreen = parsed.reduce((sum, color) => sum + color[1], 0) / parsed.length;
  const meanBlue = parsed.reduce((sum, color) => sum + color[2], 0) / parsed.length;
  const lumas = parsed.map((color) => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722);
  const meanLuma = lumas.reduce((sum, value) => sum + value, 0) / lumas.length;
  const meanSaturation = parsed.reduce((sum, color) => sum + (Math.max(...color) - Math.min(...color)), 0) / parsed.length;
  return {
    meanRed,
    meanGreen,
    meanBlue,
    meanLuma,
    lumaStdDev: Math.sqrt(lumas.reduce((sum, value) => sum + (value - meanLuma) ** 2, 0) / lumas.length),
    meanSaturation,
    blackPoint: clamp(Math.min(...lumas), 0, 1),
    whitePoint: clamp(Math.max(...lumas), 0, 1),
    sampleCount: parsed.length,
    sampledAt: new Date(0).toISOString(),
    source: "palette",
  };
}

/** Derive a restrained primary-grade correction that moves target statistics toward reference. */
export function deriveColorMatch(
  reference: ColorStatistics,
  target: ColorStatistics,
  strength = 0.45
): ColorMatchProposal {
  const amount = clamp(Number(strength) || 0, 0, 1);
  const warm = (stats: ColorStatistics) => stats.meanRed - stats.meanBlue;
  const tint = (stats: ColorStatistics) => stats.meanGreen - (stats.meanRed + stats.meanBlue) * 0.5;
  // Primary matching is intentionally bounded. Strong contrast/chroma moves
  // magnify macroblocking and banding in ordinary 8-bit phone footage and can
  // clip highlights before the delivery transform.
  const exposure = clamp(Math.log2((reference.meanLuma + 0.02) / (target.meanLuma + 0.02)), -0.75, 0.75) * amount;
  const contrast = clamp((reference.lumaStdDev - target.lumaStdDev) * 160, -18, 18) * amount;
  const saturation = clamp((reference.meanSaturation - target.meanSaturation) * 120, -18, 18) * amount;
  const temperature = clamp((warm(reference) - warm(target)) * 180, -24, 24) * amount;
  const grade = normalizePrimaryColorGrade({
    ...DEFAULT_PRIMARY_COLOR_GRADE,
    exposure,
    contrast,
    saturation,
    temperature,
    tint: clamp((tint(reference) - tint(target)) * 180, -18, 18) * amount,
  });
  const sourceQuality = Math.min(reference.sampleCount, target.sampleCount);
  return { grade, confidence: clamp(sourceQuality / 2048, 0.2, 1) };
}

/** Apply/merge the computed primary grade onto a target clip non-destructively. */
export function applyColorMatchToClip(
  tracks: readonly Track[],
  targetClipId: string,
  proposal: ColorMatchProposal,
  createEffectId: () => string
): ApplyColorMatchResult | { ok: false; message: string } {
  let effectId = "";
  let created = false;
  let found = false;
  const nextTracks = tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip: Clip) => {
      if (clip.id !== targetClipId) return clip;
      found = true;
      const existing = clip.effects.find((effect) => effect.type === "color-grade");
      if (existing) {
        effectId = existing.id;
        return {
          ...clip,
          effects: clip.effects.map((effect) => effect.id === existing.id
            ? { ...effect, params: { ...effect.params, ...proposal.grade } }
            : effect),
        };
      }
      effectId = createEffectId();
      created = true;
      return {
        ...clip,
        effects: [...clip.effects, {
          id: effectId,
          type: "color-grade",
          name: "Color Match",
          enabled: true,
          params: { ...proposal.grade },
          keyframes: [],
        }],
      };
    }),
  }));
  if (!found) return { ok: false, message: `Target clip ${targetClipId} not found` };
  return { tracks: nextTracks, effectId, created, proposal };
}
