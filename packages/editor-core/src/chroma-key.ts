import type { ChromaKey, Clip } from "@tempo/types";

export const DEFAULT_CHROMA_KEY: ChromaKey = {
  keyColor: "#00FF00",
  similarity: 0.4,
  smoothness: 0.1,
  spill: 0.4,
  screen: "green",
};

export const GREEN_SCREEN_PRESET: ChromaKey = {
  keyColor: "#00B140",
  similarity: 0.42,
  smoothness: 0.12,
  spill: 0.45,
  screen: "green",
};

export const BLUE_SCREEN_PRESET: ChromaKey = {
  keyColor: "#0047AB",
  similarity: 0.42,
  smoothness: 0.12,
  spill: 0.4,
  screen: "blue",
};

export type ChromaPresetId = "green-screen" | "blue-screen";

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Parse #RGB or #RRGGBB to 0..1 RGB. Returns null if invalid. */
export function parseKeyColorRgb(
  hex: string
): { r: number; g: number; b: number } | null {
  const raw = String(hex || "").trim();
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = parseInt(h, 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

function normalizeHex(hex: string, fallback: string): string {
  const rgb = parseKeyColorRgb(hex);
  if (!rgb) return fallback;
  const to = (v: number) =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(rgb.r)}${to(rgb.g)}${to(rgb.b)}`.toUpperCase();
}

export function normalizeChromaKey(
  input: Partial<ChromaKey> | null | undefined
): ChromaKey {
  const screen =
    input?.screen === "blue" || input?.screen === "custom"
      ? input.screen
      : input?.screen === "green"
        ? "green"
        : undefined;
  return {
    keyColor: normalizeHex(
      String(input?.keyColor ?? DEFAULT_CHROMA_KEY.keyColor),
      DEFAULT_CHROMA_KEY.keyColor
    ),
    similarity: clamp(
      finiteNumber(input?.similarity, DEFAULT_CHROMA_KEY.similarity),
      0,
      1
    ),
    smoothness: clamp(
      finiteNumber(input?.smoothness, DEFAULT_CHROMA_KEY.smoothness),
      0,
      1
    ),
    spill: clamp(
      finiteNumber(input?.spill, DEFAULT_CHROMA_KEY.spill),
      0,
      1
    ),
    screen: screen ?? inferScreen(String(input?.keyColor ?? "")),
  };
}

function inferScreen(keyColor: string): ChromaKey["screen"] {
  const rgb = parseKeyColorRgb(keyColor);
  if (!rgb) return "custom";
  if (rgb.g >= rgb.r && rgb.g >= rgb.b) return "green";
  if (rgb.b >= rgb.r && rgb.b >= rgb.g) return "blue";
  return "custom";
}

export function validateChromaKey(
  input: unknown
): { ok: true; value: ChromaKey } | { ok: false; message: string } {
  if (input == null || typeof input !== "object") {
    return { ok: false, message: "chromaKey must be an object" };
  }
  const raw = input as Record<string, unknown>;
  if (raw.keyColor !== undefined && parseKeyColorRgb(String(raw.keyColor)) == null) {
    return { ok: false, message: "keyColor must be #RGB or #RRGGBB" };
  }
  for (const key of ["similarity", "smoothness", "spill"] as const) {
    if (raw[key] !== undefined && !Number.isFinite(Number(raw[key]))) {
      return { ok: false, message: `${key} must be a finite number` };
    }
  }
  if (
    raw.screen !== undefined &&
    raw.screen !== "green" &&
    raw.screen !== "blue" &&
    raw.screen !== "custom"
  ) {
    return { ok: false, message: 'screen must be "green" | "blue" | "custom"' };
  }
  return { ok: true, value: normalizeChromaKey(raw as Partial<ChromaKey>) };
}

export function listChromaPresetIds(): ChromaPresetId[] {
  return ["green-screen", "blue-screen"];
}

export function applyChromaPreset(presetId: string): ChromaKey | null {
  switch (presetId) {
    case "green-screen":
      return { ...GREEN_SCREEN_PRESET };
    case "blue-screen":
      return { ...BLUE_SCREEN_PRESET };
    default:
      return null;
  }
}

export function clipHasChromaKey(
  chromaKey: ChromaKey | null | undefined
): boolean {
  return chromaKey != null && typeof chromaKey === "object" && !!chromaKey.keyColor;
}

export function clipHasChromaKeyOnClip(clip: Pick<Clip, "chromaKey">): boolean {
  return clipHasChromaKey(clip.chromaKey);
}

/** RGB (0..1) → CbCr (approx BT.601). */
export function rgbToCbCr(r: number, g: number, b: number): { cb: number; cr: number } {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return {
    cb: 0.564 * (b - y),
    cr: 0.713 * (r - y),
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Matte: 0 = fully keyed out (transparent), 1 = fully keep.
 * Distance in CbCr vs key; smoothstep from similarity → similarity+smoothness.
 */
export function computeChromaMatte(
  rgb: { r: number; g: number; b: number },
  key: { r: number; g: number; b: number },
  similarity: number,
  smoothness: number
): number {
  const p = rgbToCbCr(rgb.r, rgb.g, rgb.b);
  const k = rgbToCbCr(key.r, key.g, key.b);
  const d = Math.hypot(p.cb - k.cb, p.cr - k.cr);
  // Normalize roughly: max CbCr distance ~0.5–0.7; map similarity 0..1 to threshold
  const thresh = clamp(similarity, 0, 1) * 0.55;
  const soft = Math.max(1e-5, clamp(smoothness, 0, 1) * 0.35);
  return smoothstep(thresh, thresh + soft, d);
}

/**
 * Spill suppress on fringe: pull key-dominant channel toward luma.
 * Strength scaled by spill * (1 - matte).
 */
export function applySpillSuppress(
  rgb: { r: number; g: number; b: number },
  key: { r: number; g: number; b: number },
  matte: number,
  spill: number
): { r: number; g: number; b: number } {
  const amount = clamp(spill, 0, 1) * (1 - clamp(matte, 0, 1));
  if (amount <= 1e-6) return { ...rgb };
  const luma = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  const keyDom =
    key.g >= key.r && key.g >= key.b
      ? "g"
      : key.b >= key.r && key.b >= key.g
        ? "b"
        : "r";
  let { r, g, b } = rgb;
  if (keyDom === "g") {
    g = g + (luma - g) * amount;
  } else if (keyDom === "b") {
    b = b + (luma - b) * amount;
  } else {
    r = r + (luma - r) * amount;
  }
  return {
    r: clamp(r, 0, 1),
    g: clamp(g, 0, 1),
    b: clamp(b, 0, 1),
  };
}

/** Schema description for agent get_chroma_schema. */
export function getChromaSchema() {
  return {
    keyColor: { type: "string", format: "#RRGGBB", default: DEFAULT_CHROMA_KEY.keyColor },
    similarity: { type: "number", min: 0, max: 1, default: DEFAULT_CHROMA_KEY.similarity },
    smoothness: { type: "number", min: 0, max: 1, default: DEFAULT_CHROMA_KEY.smoothness },
    spill: { type: "number", min: 0, max: 1, default: DEFAULT_CHROMA_KEY.spill },
    screen: { type: "string", enum: ["green", "blue", "custom"] },
    presets: listChromaPresetIds(),
  };
}
