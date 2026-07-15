import { listGoogleFonts, type FontCategory, type FontRole } from "@tempo/editor-core";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface GoogleFontCatalogEntry {
  id: string;
  familyName: string;
  source: "google";
  category: FontCategory;
  role?: FontRole[];
  variants: string[];
}

let cache: { expiresAt: number; fonts: GoogleFontCatalogEntry[] } | null = null;

function category(value: string): FontCategory {
  const normalized = value.toLocaleLowerCase().replace(/[ _-]+/g, " ");
  if (normalized === "serif") return "serif";
  if (normalized === "display") return "display";
  if (normalized === "handwriting") return "script";
  if (normalized === "monospace" || normalized === "mono") return "mono";
  return "sans";
}

function offlineCatalog(): GoogleFontCatalogEntry[] {
  return listGoogleFonts().map((font) => ({
    ...font,
    source: "google" as const,
    category: font.category || "sans",
    variants: ["regular"],
  }));
}

/** Official all-family catalog with a durable offline fallback. */
export async function getGoogleFontCatalog(): Promise<GoogleFontCatalogEntry[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.fonts;
  if (env.NODE_ENV === "test") return offlineCatalog();
  const key = env.GOOGLE_FONTS_API_KEY || env.GEMINI_API_KEY;
  if (key) {
    try {
      const url = new URL("https://www.googleapis.com/webfonts/v1/webfonts");
      url.searchParams.set("key", key);
      url.searchParams.set("sort", "popularity");
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Google Web Fonts API returned ${response.status}`);
      const payload = await response.json() as {
        items?: Array<{ family?: string; category?: string; variants?: string[] }>;
      };
      const fonts = (payload.items || [])
        .filter((item): item is { family: string; category?: string; variants?: string[] } => Boolean(item.family))
        .map((item) => ({
          id: `google:${item.family}`,
          familyName: item.family,
          source: "google" as const,
          category: category(item.category || "sans-serif"),
          variants: Array.isArray(item.variants) ? item.variants : ["regular"],
        }));
      if (fonts.length < 100) throw new Error("Google Web Fonts API returned an incomplete catalog");
      cache = { fonts, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
      return fonts;
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Keyed Google Web Fonts catalog unavailable; trying public metadata");
    }
  }

  try {
    const response = await fetch("https://fonts.google.com/metadata/fonts", {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Google Fonts metadata returned ${response.status}`);
    const payload = await response.json() as {
      familyMetadataList?: Array<{
        family?: string;
        category?: string;
        popularity?: number;
        fonts?: Record<string, unknown>;
      }>;
    };
    const fonts = (payload.familyMetadataList || [])
      .filter((item): item is { family: string; category?: string; popularity?: number; fonts?: Record<string, unknown> } => Boolean(item.family))
      .sort((a, b) => (a.popularity || Number.MAX_SAFE_INTEGER) - (b.popularity || Number.MAX_SAFE_INTEGER))
      .map((item) => ({
        id: `google:${item.family}`,
        familyName: item.family,
        source: "google" as const,
        category: category(item.category || "Sans Serif"),
        variants: Object.keys(item.fonts || { regular: true }),
      }));
    if (fonts.length < 100) throw new Error("Google Fonts public metadata returned an incomplete catalog");
    cache = { fonts, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
    return fonts;
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Using offline Google font catalog fallback");
    return offlineCatalog();
  }
}
