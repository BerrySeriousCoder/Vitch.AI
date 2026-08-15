import { describe, it, expect, beforeEach } from "vitest";
import type { FontAsset } from "@tempo/types";
import {
  registerFontAsset,
  clearRegisteredFontAssets,
  listAvailableFonts,
  resolveFontSelection,
  getFontAsset,
} from "./fonts";

const upload: FontAsset = {
  id: "upload-abc",
  familyName: "CustomSans",
  fileName: "CustomSans.ttf",
  url: "/uploads/fonts/CustomSans.ttf",
  format: "truetype",
  projectId: "p1",
  createdAt: new Date().toISOString(),
};

describe("fonts registry", () => {
  beforeEach(() => {
    clearRegisteredFontAssets();
  });

  it("registerFontAsset makes uploads available in listAvailableFonts", () => {
    registerFontAsset(upload);
    const list = listAvailableFonts();
    expect(list.some((f) => f.id === "google:Inter")).toBe(true);
    expect(list.some((f) => f.id === "upload-abc" && f.source === "upload")).toBe(
      true
    );
    expect(getFontAsset("upload-abc")?.familyName).toBe("CustomSans");
  });

  it("resolveFontSelection handles google and upload ids", () => {
    registerFontAsset(upload);
    expect(resolveFontSelection("google:Inter")?.fontFamily).toContain("Inter");
    expect(resolveFontSelection("upload-abc")?.fontFamily).toContain("CustomSans");
    expect(resolveFontSelection("missing")).toBeNull();
  });
});
