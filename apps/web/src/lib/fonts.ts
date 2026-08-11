/**
 * Font loading — Google catalog (from editor-core) + user-uploaded FontAssets (fontId).
 */
import type { FontAsset } from "@tempo/types";
import {
  listGoogleFonts,
  fontFamilyCss,
  type FontCategory,
} from "@tempo/editor-core";
import { resolveMediaUrl } from "@/lib/media-url";

export interface FontEntry {
  family: string;
  label: string;
  weights: string[];
  category: "sans-serif" | "serif" | "monospace" | "display" | "handwriting";
}

export interface GoogleFontCatalogPayloadEntry {
  id: string;
  familyName: string;
  source: "google";
  category: FontCategory;
  variants?: string[];
}

const CATEGORY_TO_CSS: Record<
  FontCategory,
  FontEntry["category"]
> = {
  sans: "sans-serif",
  serif: "serif",
  display: "display",
  mono: "monospace",
  script: "handwriting",
};

/** Default wght axis for Google CSS2 URLs when family-specific weights unknown. */
const DEFAULT_WEIGHTS = ["300", "400", "500", "600", "700", "800", "900"];

const WEIGHT_OVERRIDES: Record<string, string[]> = {
  Inter: ["300", "400", "500", "600", "700", "800", "900"],
  Roboto: ["300", "400", "500", "700", "900"],
  "Open Sans": ["300", "400", "600", "700", "800"],
  Montserrat: ["300", "400", "500", "600", "700", "800", "900"],
  Poppins: ["300", "400", "500", "600", "700", "800", "900"],
  Lato: ["300", "400", "700", "900"],
  Oswald: ["300", "400", "500", "600", "700"],
  Raleway: ["300", "400", "500", "600", "700", "800", "900"],
  "Playfair Display": ["400", "500", "600", "700", "800", "900"],
  Merriweather: ["300", "400", "700", "900"],
  Lora: ["400", "500", "600", "700"],
  "PT Serif": ["400", "700"],
  "Bebas Neue": ["400"],
  Anton: ["400"],
  Righteous: ["400"],
  "Permanent Marker": ["400"],
  Pacifico: ["400"],
  Satisfy: ["400"],
  "JetBrains Mono": ["300", "400", "500", "600", "700", "800"],
  "Source Code Pro": ["300", "400", "500", "600", "700", "900"],
};

/** Builtin Google catalog synced from @tempo/editor-core. */
export const GOOGLE_FONTS: FontEntry[] = listGoogleFonts().map((f) => ({
  family: f.familyName,
  label: f.familyName,
  weights: WEIGHT_OVERRIDES[f.familyName] ?? DEFAULT_WEIGHTS,
  category: CATEGORY_TO_CSS[f.category ?? "sans"],
}));

let runtimeGoogleFonts: FontEntry[] = [...GOOGLE_FONTS];

function familyNameFromCss(value: string): string {
  return String(value || "")
    .split(",")[0]!
    .replace(/["']/g, "")
    .trim();
}

function weightsFromVariants(variants: readonly string[] | undefined): string[] {
  const values = new Set<string>();
  for (const variant of variants || []) {
    const match = String(variant).match(/^(\d{3})/);
    if (match) values.add(match[1]!);
    else if (variant === "regular" || variant === "italic") values.add("400");
  }
  return values.size ? [...values].sort((a, b) => Number(a) - Number(b)) : ["400"];
}

/** Replace the offline fallback with Google's current all-family catalog. */
export function registerGoogleFontCatalog(entries: readonly GoogleFontCatalogPayloadEntry[]): void {
  if (!entries.length) return;
  runtimeGoogleFonts = entries.map((entry) => ({
    family: entry.familyName,
    label: entry.familyName,
    weights: weightsFromVariants(entry.variants),
    category: CATEGORY_TO_CSS[entry.category] || "sans-serif",
  }));
}

const loadedFonts = new Set<string>();
const customFonts = new Map<string, FontAsset>();
const loadedFontIds = new Set<string>();

type FontReadyListener = () => void;
const readyListeners = new Set<FontReadyListener>();

export function onFontReady(listener: FontReadyListener): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

function notifyFontReady(): void {
  for (const l of readyListeners) l();
}

export function registerFontAsset(asset: FontAsset): void {
  customFonts.set(asset.id, asset);
}

export function unregisterFontAsset(id: string): void {
  customFonts.delete(id);
  loadedFontIds.delete(id);
}

export function clearRegisteredFontAssets(): void {
  customFonts.clear();
  loadedFontIds.clear();
}

export function getFontAsset(id: string): FontAsset | undefined {
  return customFonts.get(id);
}

export function listRegisteredFontAssets(): FontAsset[] {
  return Array.from(customFonts.values());
}

export function loadFont(family: string): void {
  if (typeof document === "undefined") return;
  family = familyNameFromCss(family);
  if (!family) return;
  if (loadedFonts.has(family)) return;

  const entry = runtimeGoogleFonts.find((f) => f.family === family);

  loadedFonts.add(family);

  const weights = (entry?.weights || ["400"]).join(";");
  const encodedFamily = family.replace(/\s+/g, "+");
  const href = `https://fonts.googleapis.com/css2?family=${encodedFamily}:wght@${weights}&display=swap`;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/** Ensure a catalog (Google) or already-registered family is usable for canvas text. */
export async function ensureFontReady(family: string): Promise<void> {
  family = familyNameFromCss(family);
  if (typeof document === "undefined" || !family) return;
  loadFont(family);
  try {
    await document.fonts.load(`16px "${family}"`);
  } catch {
    /* catalog may still resolve via CSS */
  }
  await document.fonts.ready;
}

/** Load a user-uploaded font by FontAsset id (FontFace API). */
export async function loadFontById(fontId: string): Promise<string | null> {
  if (typeof document === "undefined") return null;
  if (fontId.startsWith("google:")) {
    const family = familyNameFromCss(fontId.slice("google:".length));
    if (!family) return null;
    await ensureFontReady(family);
    return family;
  }
  const asset = customFonts.get(fontId);
  if (!asset) return null;
  if (loadedFontIds.has(fontId)) return asset.familyName;

  const resolved = resolveMediaUrl(asset.url);
  if (!resolved) return null;

  try {
    const face = new FontFace(asset.familyName, `url(${resolved})`, {
      style: "normal",
      weight: "100 900",
    });
    await face.load();
    document.fonts.add(face);
    loadedFontIds.add(fontId);
    loadedFonts.add(asset.familyName);
    notifyFontReady();
    return asset.familyName;
  } catch {
    return null;
  }
}

export function getFontCSS(family: string): string {
  family = familyNameFromCss(family);
  const entry = runtimeGoogleFonts.find((f) => f.family === family);
  if (!entry) return `"${family}", sans-serif`;
  return fontFamilyCss(family);
}

/** Builtin + custom fonts for agent/UI listing */
export function listAvailableFonts(): {
  id: string;
  familyName: string;
  source: "google" | "upload";
}[] {
  const google = runtimeGoogleFonts.map((f) => ({
    id: `google:${f.family}`,
    familyName: f.family,
    source: "google" as const,
  }));
  const uploads = listRegisteredFontAssets().map((f) => ({
    id: f.id,
    familyName: f.familyName,
    source: "upload" as const,
  }));
  return [...google, ...uploads];
}

export function resolveFontSelection(fontId: string): {
  fontId: string;
  fontFamily: string;
} | null {
  if (fontId.startsWith("google:")) {
    const family = fontId.slice("google:".length);
    const entry = runtimeGoogleFonts.find((f) => f.family === family);
    if (!entry) return null;
    return { fontId, fontFamily: getFontCSS(entry.family) };
  }
  const asset = customFonts.get(fontId);
  if (!asset) return null;
  return { fontId, fontFamily: getFontCSS(asset.familyName) };
}
