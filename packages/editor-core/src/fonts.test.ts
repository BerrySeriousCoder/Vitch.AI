import { describe, it, expect } from "vitest";
import {
  listGoogleFonts,
  resolveTextFont,
  googleFontId,
  GOOGLE_FONT_FAMILIES,
  matchGoogleFontFamily,
} from "./fonts";

describe("editor-core fonts", () => {
  it("lists google fonts with google: ids", () => {
    const fonts = listGoogleFonts();
    expect(fonts[0]?.id).toBe(googleFontId(fonts[0]!.familyName));
    expect(fonts.some((f) => f.familyName === "Inter")).toBe(true);
  });

  it("expands catalog with category and role metadata", () => {
    const fonts = listGoogleFonts();
    expect(GOOGLE_FONT_FAMILIES.length).toBeGreaterThanOrEqual(60);
    expect(fonts.length).toBe(GOOGLE_FONT_FAMILIES.length);
    expect(fonts.every((f) => f.category)).toBe(true);
    const cats = new Set(fonts.map((f) => f.category));
    expect(cats.has("sans")).toBe(true);
    expect(cats.has("serif")).toBe(true);
    expect(cats.has("display")).toBe(true);
    expect(cats.has("mono")).toBe(true);
    expect(cats.has("script")).toBe(true);
    expect(fonts.find((f) => f.familyName === "Inter")?.role).toContain("body");
  });

  it("resolveTextFont maps google and uploads", () => {
    const g = resolveTextFont("google:Montserrat");
    expect(g?.familyName).toBe("Montserrat");
    const u = resolveTextFont("abc", new Map([["abc", "Brand"]]));
    expect(u?.fontFamily).toContain("Brand");
    expect(resolveTextFont("google:Nope")).toBeNull();
    expect(resolveTextFont("google:ABeeZee", {}, ["ABeeZee"])?.familyName).toBe("ABeeZee");
  });

  it("matches each analyzed typography hint independently", () => {
    expect(matchGoogleFontFamily({ hint: "Bebas Neue", category: "display" })).toBe("Bebas Neue");
    expect(matchGoogleFontFamily({ category: "display", width: "condensed" })).toBe("Bebas Neue");
    expect(matchGoogleFontFamily({ category: "handwritten" })).toBe("Permanent Marker");
  });
});
