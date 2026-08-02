import { describe, expect, it } from "vitest";
import { applyCaptionPreset, getCaptionPreset } from "./caption-presets";

const params = {
  text: "A readable caption",
  fontFamily: "Inter, sans-serif",
  fontSize: 42,
  fontWeight: "600",
  color: "#FFFFFF",
  textAlign: "center" as const,
  lineHeight: 1.2,
};

describe("caption presets", () => {
  it("provides bounded cue defaults for each look", () => {
    const preset = getCaptionPreset("podcast");
    expect(preset?.cue).toMatchObject({ maxLines: 2, maxWords: 7 });
  });

  it("makes social captions word animated while retaining text", () => {
    const styled = applyCaptionPreset(params, "social-pop", 2);
    expect(styled).toMatchObject({ text: params.text, captionPresetId: "social-pop", split: "word" });
    expect(styled?.animators?.length).toBeGreaterThan(0);
  });
});
