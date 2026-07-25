import type {
  TextAnimator,
  TextAnimatorEase,
  TextAnimatorProperty,
  TextParams,
  TextSplitMode,
} from "@tempo/types";
import { interpolateHexColor, normalizeHexColor } from "./text-animator-colors";
import {
  TEXT_ANIMATOR_PRESETS,
  type TextAnimatorPreset,
} from "./text-animator-presets";

export interface TextUnit {
  text: string;
  /** Absolute start index in original string (for debugging) */
  index: number;
  /** Line index when split is char/word within multiline */
  lineIndex: number;
}

export interface UnitMotion {
  opacity: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  rotation: number;
  tracking: number;
  blur: number;
  color?: string;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function easeFn(ease: TextAnimatorEase, t: number): number {
  const u = clamp(t, 0, 1);
  switch (ease) {
    case "hold":
      return u >= 1 ? 1 : 0;
    case "ease-in":
      return u * u;
    case "ease-out":
      return 1 - (1 - u) * (1 - u);
    case "ease-in-out":
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    default:
      return u;
  }
}

const PROPERTIES: TextAnimatorProperty[] = [
  "opacity",
  "offsetX",
  "offsetY",
  "scale",
  "rotation",
  "tracking",
  "blur",
  "color",
];

export function normalizeAnimator(raw: Partial<TextAnimator>): TextAnimator {
  const property = PROPERTIES.includes(raw.property as TextAnimatorProperty)
    ? (raw.property as TextAnimatorProperty)
    : "opacity";
  const ease: TextAnimatorEase =
    raw.ease === "hold" ||
    raw.ease === "ease-in" ||
    raw.ease === "ease-out" ||
    raw.ease === "ease-in-out" ||
    raw.ease === "linear"
      ? raw.ease
      : "ease-out";
  const anim: TextAnimator = {
    property,
    offsetSec: Math.max(0, Number.isFinite(Number(raw.offsetSec)) ? Number(raw.offsetSec) : 0),
    durationSec: Math.max(
      0.01,
      Number.isFinite(Number(raw.durationSec)) ? Number(raw.durationSec) : 0.35
    ),
    staggerSec: Math.max(
      0,
      Number.isFinite(Number(raw.staggerSec)) ? Number(raw.staggerSec) : 0.04
    ),
    from: Number.isFinite(Number(raw.from)) ? Number(raw.from) : property === "opacity" || property === "scale" ? 0 : 0,
    to: Number.isFinite(Number(raw.to))
      ? Number(raw.to)
      : property === "opacity" || property === "scale"
        ? 1
        : 0,
    ease,
  };
  if (
    Array.isArray(raw.range) &&
    raw.range.length === 2 &&
    Number.isFinite(raw.range[0]) &&
    Number.isFinite(raw.range[1])
  ) {
    anim.range = [Math.max(0, Math.floor(raw.range[0]!)), Math.max(0, Math.floor(raw.range[1]!))];
  }
  if (Array.isArray(raw.unitStartTimes)) {
    const unitStartTimes = raw.unitStartTimes.map(Number);
    if (unitStartTimes.every(Number.isFinite) && unitStartTimes.every((time) => time >= 0)) {
      anim.unitStartTimes = unitStartTimes;
    }
  }
  if (Array.isArray(raw.valueKeyframes)) {
    const valueKeyframes = raw.valueKeyframes
      .map((keyframe) => ({
        timeSec: Math.max(0, Number(keyframe.timeSec)),
        value: Number(keyframe.value),
        easing: keyframe.easing === "hold" || keyframe.easing === "linear" || keyframe.easing === "ease-in" || keyframe.easing === "ease-out" || keyframe.easing === "ease-in-out"
          ? keyframe.easing
          : "linear" as const,
      }))
      .filter((keyframe) => Number.isFinite(keyframe.timeSec) && Number.isFinite(keyframe.value))
      .sort((a, b) => a.timeSec - b.timeSec);
    if (valueKeyframes.length) anim.valueKeyframes = valueKeyframes;
  }
  if (property === "color") {
    anim.from = 0;
    anim.to = 1;
    anim.fromColor = normalizeHexColor(raw.fromColor) || "#FFFFFF";
    anim.toColor = normalizeHexColor(raw.toColor) || "#FFFFFF";
  }
  return anim;
}

export function validateAnimators(
  input: unknown
): { ok: true; value: TextAnimator[] } | { ok: false; message: string } {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) {
    return { ok: false, message: "animators must be an array" };
  }
  const value: TextAnimator[] = [];
  for (const item of input) {
    if (item == null || typeof item !== "object") {
      return { ok: false, message: "each animator must be an object" };
    }
    const raw = item as Partial<TextAnimator>;
    if (!PROPERTIES.includes(raw.property as TextAnimatorProperty)) {
      return {
        ok: false,
        message: `invalid property "${String(raw.property)}"`,
      };
    }
    for (const key of ["offsetSec", "durationSec", "staggerSec", "from", "to"] as const) {
      if (raw[key] !== undefined && !Number.isFinite(Number(raw[key]))) {
        return { ok: false, message: `animator ${key} must be finite` };
      }
    }
    if (raw.range !== undefined) {
      if (
        !Array.isArray(raw.range) ||
        raw.range.length !== 2 ||
        !Number.isInteger(raw.range[0]) ||
        !Number.isInteger(raw.range[1]) ||
        raw.range[0] < 0 ||
        raw.range[1] <= raw.range[0]
      ) {
        return {
          ok: false,
          message: "animator range must be [start, endExclusive] with non-negative increasing integers",
        };
      }
    }
    if (raw.unitStartTimes !== undefined) {
      if (
        !Array.isArray(raw.unitStartTimes) ||
        raw.unitStartTimes.length === 0 ||
        raw.unitStartTimes.length > 512 ||
        !raw.unitStartTimes.every((time) => Number.isFinite(Number(time)) && Number(time) >= 0)
      ) {
        return { ok: false, message: "animator unitStartTimes must contain 1..512 non-negative seconds" };
      }
    }
    if (raw.valueKeyframes !== undefined) {
      if (
        !Array.isArray(raw.valueKeyframes) ||
        raw.valueKeyframes.length < 2 ||
        raw.valueKeyframes.length > 64 ||
        !raw.valueKeyframes.every((keyframe) =>
          keyframe &&
          Number.isFinite(Number(keyframe.timeSec)) && Number(keyframe.timeSec) >= 0 &&
          Number.isFinite(Number(keyframe.value)) &&
          ["hold", "linear", "ease-in", "ease-out", "ease-in-out"].includes(String(keyframe.easing || "linear"))
        )
      ) {
        return { ok: false, message: "animator valueKeyframes require 2..64 finite {timeSec,value,easing} entries" };
      }
    }
    if (raw.property === "color") {
      if (!normalizeHexColor(raw.fromColor) || !normalizeHexColor(raw.toColor)) {
        return { ok: false, message: "color animators require fromColor and toColor as #RRGGBB" };
      }
    }
    value.push(normalizeAnimator(raw));
  }
  return { ok: true, value };
}

export function normalizeSplit(split?: TextSplitMode | null): TextSplitMode {
  if (split === "char" || split === "word" || split === "line") return split;
  return "none";
}

export function textHasKineticAnimators(params?: TextParams | null): boolean {
  if (!params) return false;
  const split = normalizeSplit(params.split);
  if (split === "none") return false;
  return Array.isArray(params.animators) && params.animators.length > 0;
}

/** Split text into units for kinetic drawing. */
export function splitTextUnits(text: string, split: TextSplitMode): TextUnit[] {
  const mode = normalizeSplit(split);
  if (mode === "none") {
    return [{ text, index: 0, lineIndex: 0 }];
  }
  const lines = text.split("\n");
  const units: TextUnit[] = [];
  let globalIndex = 0;
  let cursor = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (mode === "line") {
      units.push({ text: line, index: globalIndex++, lineIndex: li });
    } else if (mode === "word") {
      const parts = line.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          // keep whitespace attached to previous unit when possible
          const last = units[units.length - 1];
          if (last && last.lineIndex === li) last.text += part;
          else units.push({ text: part, index: globalIndex++, lineIndex: li });
        } else {
          units.push({ text: part, index: globalIndex++, lineIndex: li });
        }
      }
      if (parts.length === 0) {
        units.push({ text: "", index: globalIndex++, lineIndex: li });
      }
    } else {
      // char
      for (const ch of line) {
        units.push({ text: ch, index: globalIndex++, lineIndex: li });
      }
      if (line.length === 0) {
        units.push({ text: "", index: globalIndex++, lineIndex: li });
      }
    }
    cursor += line.length + (li < lines.length - 1 ? 1 : 0);
    void cursor;
  }
  return units;
}

function sampleAnimator(
  anim: TextAnimator,
  unitIndex: number,
  timeInClip: number
): number | null {
  if (anim.range) {
    const [a, b] = anim.range;
    if (unitIndex < a || unitIndex >= b) return null;
  }
  const rangeStart = anim.range?.[0] || 0;
  const explicitIndex = Math.max(0, unitIndex - rangeStart);
  const explicitStart = anim.unitStartTimes?.[explicitIndex];
  const start = explicitStart ?? anim.offsetSec + unitIndex * anim.staggerSec;
  if (anim.valueKeyframes && anim.valueKeyframes.length >= 2) {
    const localTime = timeInClip - start;
    const keys = anim.valueKeyframes;
    if (localTime <= keys[0]!.timeSec) return keys[0]!.value;
    if (localTime >= keys[keys.length - 1]!.timeSec) return keys[keys.length - 1]!.value;
    for (let index = 0; index < keys.length - 1; index++) {
      const previous = keys[index]!;
      const next = keys[index + 1]!;
      if (localTime < previous.timeSec || localTime >= next.timeSec) continue;
      const progress = (localTime - previous.timeSec) / Math.max(0.000001, next.timeSec - previous.timeSec);
      const eased = easeFn(next.easing, progress);
      return previous.value + (next.value - previous.value) * eased;
    }
  }
  const end = start + anim.durationSec;
  if (timeInClip < start) return anim.from;
  if (timeInClip >= end) return anim.to;
  const t = (timeInClip - start) / Math.max(1e-6, anim.durationSec);
  const e = easeFn(anim.ease, t);
  return anim.from + (anim.to - anim.from) * e;
}

export function resolveUnitMotion(
  unitIndex: number,
  timeInClip: number,
  animators: readonly TextAnimator[] | null | undefined
): UnitMotion {
  const motion: UnitMotion = {
    opacity: 1,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    rotation: 0,
    tracking: 0,
    blur: 0,
  };
  if (!animators?.length) return motion;
  for (const raw of animators) {
    const anim = normalizeAnimator(raw);
    const v = sampleAnimator(anim, unitIndex, timeInClip);
    if (v == null) continue;
    switch (anim.property) {
      case "opacity":
        motion.opacity = clamp(v, 0, 1);
        break;
      case "offsetX":
        motion.offsetX = v;
        break;
      case "offsetY":
        motion.offsetY = v;
        break;
      case "scale":
        motion.scale = Math.max(0, v);
        break;
      case "rotation":
        motion.rotation = v;
        break;
      case "tracking":
        motion.tracking = v;
        break;
      case "blur":
        motion.blur = Math.max(0, v);
        break;
      case "color":
        motion.color = interpolateHexColor(anim.fromColor || "#FFFFFF", anim.toColor || "#FFFFFF", v);
        break;
    }
  }
  return motion;
}

export function getTextAnimatorPreset(id: string): TextAnimatorPreset | undefined {
  return TEXT_ANIMATOR_PRESETS.find((p) => p.id === id);
}

export function listTextAnimatorPresetIds(): string[] {
  return TEXT_ANIMATOR_PRESETS.map((p) => p.id);
}

export function applyTextAnimatorPreset(
  params: TextParams,
  presetId: string,
  clipDuration: number
): TextParams {
  const preset = getTextAnimatorPreset(presetId);
  if (!preset) return params;
  return {
    ...params,
    split: preset.split,
    animators: preset.build(Math.max(0.1, clipDuration)),
  };
}

export {
  TEXT_ANIMATOR_PRESETS,
  type TextAnimatorPreset,
  normalizeHexColor,
  interpolateHexColor,
};
