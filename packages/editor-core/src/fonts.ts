/** Builtin Google font families available in the editor (ids: google:<Family>). */

export type FontCategory = "sans" | "serif" | "display" | "mono" | "script";
export type FontRole = "title" | "body" | "caption";

export interface GoogleFontDef {
  family: string;
  category: FontCategory;
  role?: FontRole[];
  width?: "condensed" | "normal" | "wide";
}

/**
 * Short-form workhorses across display / sans / serif / mono / script.
 * Keep existing families; expand catalog for title/body variety.
 */
export const GOOGLE_FONT_CATALOG: readonly GoogleFontDef[] = [
  // Sans — body / UI
  { family: "Inter", category: "sans", role: ["body", "caption", "title"] },
  { family: "Roboto", category: "sans", role: ["body", "caption"] },
  { family: "Open Sans", category: "sans", role: ["body", "caption"] },
  { family: "Montserrat", category: "sans", role: ["title", "body"] },
  { family: "Poppins", category: "sans", role: ["title", "body"] },
  { family: "Lato", category: "sans", role: ["body", "caption"] },
  { family: "Oswald", category: "sans", role: ["title"], width: "condensed" },
  { family: "Raleway", category: "sans", role: ["title", "body"] },
  { family: "Nunito", category: "sans", role: ["body", "caption"] },
  { family: "Nunito Sans", category: "sans", role: ["body", "caption"] },
  { family: "Work Sans", category: "sans", role: ["body", "caption"] },
  { family: "DM Sans", category: "sans", role: ["body", "title"] },
  { family: "Figtree", category: "sans", role: ["body", "caption"] },
  { family: "Outfit", category: "sans", role: ["title", "body"] },
  { family: "Manrope", category: "sans", role: ["body", "title"] },
  { family: "Plus Jakarta Sans", category: "sans", role: ["body", "title"] },
  { family: "Space Grotesk", category: "sans", role: ["title", "body"] },
  { family: "Sora", category: "sans", role: ["title", "body"] },
  { family: "Urbanist", category: "sans", role: ["title", "body"] },
  { family: "Rubik", category: "sans", role: ["body", "caption"] },
  { family: "Mulish", category: "sans", role: ["body", "caption"] },
  { family: "Barlow", category: "sans", role: ["title", "body"] },
  { family: "Barlow Condensed", category: "sans", role: ["title"], width: "condensed" },
  { family: "Archivo", category: "sans", role: ["title", "body"] },
  { family: "Cabin", category: "sans", role: ["body", "caption"] },
  { family: "Karla", category: "sans", role: ["body", "caption"] },
  { family: "Source Sans 3", category: "sans", role: ["body", "caption"] },
  { family: "Noto Sans", category: "sans", role: ["body", "caption"] },
  { family: "IBM Plex Sans", category: "sans", role: ["body", "caption"] },
  { family: "Exo 2", category: "sans", role: ["title", "body"] },
  { family: "Titillium Web", category: "sans", role: ["title", "body"] },
  { family: "Rajdhani", category: "sans", role: ["title"], width: "condensed" },
  { family: "Kanit", category: "sans", role: ["title", "body"] },
  { family: "Lexend", category: "sans", role: ["body", "caption"] },
  { family: "Public Sans", category: "sans", role: ["body", "caption"] },

  // Serif
  { family: "Playfair Display", category: "serif", role: ["title"] },
  { family: "Merriweather", category: "serif", role: ["body", "title"] },
  { family: "Lora", category: "serif", role: ["body", "title"] },
  { family: "PT Serif", category: "serif", role: ["body"] },
  { family: "Libre Baskerville", category: "serif", role: ["body", "title"] },
  { family: "Cormorant Garamond", category: "serif", role: ["title"] },
  { family: "EB Garamond", category: "serif", role: ["body", "title"] },
  { family: "Crimson Text", category: "serif", role: ["body"] },
  { family: "Source Serif 4", category: "serif", role: ["body", "title"] },
  { family: "Noto Serif", category: "serif", role: ["body"] },
  { family: "IBM Plex Serif", category: "serif", role: ["body"] },
  { family: "Bitter", category: "serif", role: ["body", "title"] },
  { family: "Cardo", category: "serif", role: ["body"] },
  { family: "Spectral", category: "serif", role: ["body", "title"] },
  { family: "Fraunces", category: "serif", role: ["title"] },

  // Display
  { family: "Bebas Neue", category: "display", role: ["title"], width: "condensed" },
  { family: "Anton", category: "display", role: ["title"], width: "condensed" },
  { family: "Righteous", category: "display", role: ["title"] },
  { family: "Archivo Black", category: "display", role: ["title"], width: "wide" },
  { family: "Black Ops One", category: "display", role: ["title"] },
  { family: "Bungee", category: "display", role: ["title"], width: "wide" },
  { family: "Passion One", category: "display", role: ["title"], width: "condensed" },
  { family: "Teko", category: "display", role: ["title"], width: "condensed" },
  { family: "Russo One", category: "display", role: ["title"] },
  { family: "Alfa Slab One", category: "display", role: ["title"] },
  { family: "Fredoka", category: "display", role: ["title", "caption"] },
  { family: "Comfortaa", category: "display", role: ["title", "caption"] },
  { family: "Lilita One", category: "display", role: ["title"] },

  // Script / handwriting
  { family: "Permanent Marker", category: "script", role: ["title"] },
  { family: "Pacifico", category: "script", role: ["title"] },
  { family: "Satisfy", category: "script", role: ["title"] },
  { family: "Dancing Script", category: "script", role: ["title"] },
  { family: "Great Vibes", category: "script", role: ["title"] },
  { family: "Caveat", category: "script", role: ["title", "caption"] },
  { family: "Indie Flower", category: "script", role: ["caption", "title"] },
  { family: "Shadows Into Light", category: "script", role: ["title"] },
  { family: "Kalam", category: "script", role: ["caption", "title"] },
  { family: "Amatic SC", category: "script", role: ["title"] },

  // Mono
  { family: "JetBrains Mono", category: "mono", role: ["caption", "body"] },
  { family: "Source Code Pro", category: "mono", role: ["caption", "body"] },
  { family: "Fira Code", category: "mono", role: ["caption"] },
  { family: "Roboto Mono", category: "mono", role: ["caption", "body"] },
  { family: "IBM Plex Mono", category: "mono", role: ["caption"] },
  { family: "Space Mono", category: "mono", role: ["caption", "title"] },
  { family: "Inconsolata", category: "mono", role: ["caption"] },
  { family: "Courier Prime", category: "mono", role: ["caption", "body"] },
];

/** Flat family-name list (unique; catalog may list a family once). */
export const GOOGLE_FONT_FAMILIES: readonly string[] = [
  ...new Set(GOOGLE_FONT_CATALOG.map((e) => e.family)),
];

export type GoogleFontFamily = (typeof GOOGLE_FONT_CATALOG)[number]["family"];

export function googleFontId(family: string): string {
  return `google:${family}`;
}

export function parseGoogleFontId(fontId: string): string | null {
  if (!fontId.startsWith("google:")) return null;
  const family = fontId.slice("google:".length).trim();
  return family || null;
}

export function isKnownGoogleFont(family: string): boolean {
  return GOOGLE_FONT_FAMILIES.includes(family);
}

/** Safe family syntax for runtime catalog entries returned by Google Fonts. */
export function isSafeGoogleFontFamily(family: string): boolean {
  return /^[\p{L}\p{N} .&'()+-]{1,100}$/u.test(family.trim());
}

function normalizedFamily(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface GoogleFontMatchInput {
  hint?: string | null;
  category?: "sans" | "serif" | "display" | "monospace" | "handwritten" | null;
  width?: "condensed" | "normal" | "wide" | null;
  role?: FontRole;
}

/** Resolve each analyzed overlay independently to the closest catalog family. */
export function matchGoogleFontFamily(input: GoogleFontMatchInput): string {
  const hint = normalizedFamily(String(input.hint || ""));
  if (hint) {
    const exact = GOOGLE_FONT_CATALOG.find((font) => normalizedFamily(font.family) === hint);
    if (exact) return exact.family;
    const partial = GOOGLE_FONT_CATALOG.find((font) => {
      const candidate = normalizedFamily(font.family);
      return candidate.includes(hint) || hint.includes(candidate);
    });
    if (partial) return partial.family;
  }

  const category: FontCategory = input.category === "monospace"
    ? "mono"
    : input.category === "handwritten"
      ? "script"
      : input.category || "sans";
  const role = input.role || "title";
  let best = GOOGLE_FONT_CATALOG[0]!;
  let bestScore = -Infinity;
  for (const font of GOOGLE_FONT_CATALOG) {
    let score = font.category === category ? 8 : 0;
    if (font.role?.includes(role)) score += 3;
    if (input.width) score += (font.width || "normal") === input.width ? 4 : -1;
    if (font.family === "Inter") score += category === "sans" ? 0.5 : 0;
    if (score > bestScore) {
      best = font;
      bestScore = score;
    }
  }
  return best.family;
}

/** CSS font-family string for a known Google family, or quoted custom name. */
export function fontFamilyCss(family: string): string {
  const cat = GOOGLE_FONT_CATALOG.find((e) => e.family === family)?.category;
  const fallback =
    cat === "serif"
      ? "serif"
      : cat === "mono"
        ? "monospace"
        : cat === "script"
          ? "cursive"
          : "sans-serif";
  return `"${family}", ${fallback}`;
}

export interface FontListEntry {
  id: string;
  familyName: string;
  source: "google" | "upload";
  category?: FontCategory;
  role?: FontRole[];
}

export function listGoogleFonts(): FontListEntry[] {
  const seen = new Set<string>();
  const out: FontListEntry[] = [];
  for (const entry of GOOGLE_FONT_CATALOG) {
    if (seen.has(entry.family)) continue;
    seen.add(entry.family);
    out.push({
      id: googleFontId(entry.family),
      familyName: entry.family,
      source: "google",
      category: entry.category,
      ...(entry.role ? { role: [...entry.role] } : {}),
    });
  }
  return out;
}

/**
 * Resolve fontId (google:Family or upload uuid) to textParams fields.
 * `uploads` maps upload font ids → family names.
 */
export function resolveTextFont(
  fontId: string,
  uploads: Map<string, string> | Record<string, string> = {},
  googleFamilies: readonly string[] = GOOGLE_FONT_FAMILIES
): { fontId: string; fontFamily: string; familyName: string } | null {
  const googleFamily = parseGoogleFontId(fontId);
  if (googleFamily) {
    if (!isSafeGoogleFontFamily(googleFamily) || !googleFamilies.includes(googleFamily)) return null;
    return {
      fontId,
      fontFamily: fontFamilyCss(googleFamily),
      familyName: googleFamily,
    };
  }

  const map =
    uploads instanceof Map
      ? uploads
      : new Map(Object.entries(uploads));
  const familyName = map.get(fontId);
  if (!familyName) return null;
  return {
    fontId,
    fontFamily: fontFamilyCss(familyName),
    familyName,
  };
}
