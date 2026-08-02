import { describe, it, expect } from "vitest";
import {
  listTitleTemplates,
  getTitleTemplate,
  applyTitleTemplateToTextParams,
} from "./title-templates";
import type { TextParams } from "@tempo/types";

const baseParams: TextParams = {
  text: "Hello",
  fontFamily: "Inter, sans-serif",
  fontId: "google:Inter",
  fontSize: 48,
  fontWeight: "600",
  color: "#ffffff",
  textAlign: "center",
  lineHeight: 1.3,
};

describe("title-templates", () => {
  it("lists 3+ presets including hook-title and lower-third", () => {
    const list = listTitleTemplates();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some((t) => t.id === "hook-title")).toBe(true);
    expect(list.some((t) => t.id === "lower-third")).toBe(true);
    expect(list.some((t) => t.id === "end-card")).toBe(true);
  });

  it("getTitleTemplate returns defaults and kinetic optional", () => {
    const hook = getTitleTemplate("hook-title");
    expect(hook?.textParams.fontSize).toBeGreaterThan(48);
    expect(hook?.textParams.shadow).toBeTruthy();
    expect(hook?.suggestedDuration).toBeGreaterThan(0);

    const kinetic = getTitleTemplate("kinetic-hook");
    expect(kinetic?.kineticPresetId).toBe("cascade-up");
  });

  it("applyTitleTemplateToTextParams merges and slotText", () => {
    const next = applyTitleTemplateToTextParams(baseParams, "lower-third", "Name");
    expect(next).not.toBeNull();
    expect(next!.text).toBe("Name");
    expect(next!.backgroundColor).toBeTruthy();
    expect(next!.textAlign).toBe("left");
    expect(next!.fontSize).toBe(36);

    expect(applyTitleTemplateToTextParams(baseParams, "nope")).toBeNull();
  });
});
