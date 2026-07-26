import type { TextParams } from "@tempo/types";
import { fontFamilyCss, googleFontId } from "./fonts";

export type TitleTemplateRole = "title" | "lower-third" | "end-card" | "kinetic";

export interface TitleTemplate {
  id: string;
  name: string;
  role: TitleTemplateRole;
  /** Defaults merged onto existing textParams (does not clear unspecified keys). */
  textParams: Partial<TextParams>;
  suggestedDuration: number;
  /** Optional kinetic animator preset id (e.g. cascade-up). */
  kineticPresetId?: string;
}

const TITLE_TEMPLATES: TitleTemplate[] = [
  {
    id: "hook-title",
    name: "Hook Title",
    role: "title",
    suggestedDuration: 2.5,
    textParams: {
      fontId: googleFontId("Bebas Neue"),
      fontFamily: fontFamilyCss("Bebas Neue"),
      fontSize: 96,
      fontWeight: "400",
      color: "#ffffff",
      textAlign: "center",
      lineHeight: 1.05,
      letterSpacing: 2,
      shadow: "0 4px 24px rgba(0,0,0,0.65)",
    },
  },
  {
    id: "lower-third",
    name: "Lower Third",
    role: "lower-third",
    suggestedDuration: 4,
    textParams: {
      fontId: googleFontId("Montserrat"),
      fontFamily: fontFamilyCss("Montserrat"),
      fontSize: 36,
      fontWeight: "600",
      color: "#ffffff",
      textAlign: "left",
      lineHeight: 1.25,
      letterSpacing: 0.5,
      backgroundColor: "rgba(0,0,0,0.72)",
      shadow: "0 1px 4px rgba(0,0,0,0.4)",
    },
  },
  {
    id: "end-card",
    name: "End Card",
    role: "end-card",
    suggestedDuration: 3.5,
    textParams: {
      fontId: googleFontId("Poppins"),
      fontFamily: fontFamilyCss("Poppins"),
      fontSize: 56,
      fontWeight: "700",
      color: "#ffffff",
      textAlign: "center",
      lineHeight: 1.2,
      letterSpacing: 0,
      shadow: "0 2px 12px rgba(0,0,0,0.5)",
    },
  },
  {
    id: "kinetic-hook",
    name: "Kinetic Hook",
    role: "kinetic",
    suggestedDuration: 3,
    kineticPresetId: "cascade-up",
    textParams: {
      fontId: googleFontId("Anton"),
      fontFamily: fontFamilyCss("Anton"),
      fontSize: 84,
      fontWeight: "400",
      color: "#ffffff",
      textAlign: "center",
      lineHeight: 1.1,
      letterSpacing: 1,
      shadow: "0 3px 18px rgba(0,0,0,0.55)",
    },
  },
  {
    id: "caption-bar",
    name: "Caption Bar",
    role: "lower-third",
    suggestedDuration: 3,
    textParams: {
      fontId: googleFontId("Inter"),
      fontFamily: fontFamilyCss("Inter"),
      fontSize: 28,
      fontWeight: "500",
      color: "#ffffff",
      textAlign: "center",
      lineHeight: 1.35,
      letterSpacing: 0,
      backgroundColor: "rgba(0,0,0,0.55)",
    },
  },
];

export function listTitleTemplates(): TitleTemplate[] {
  return TITLE_TEMPLATES.map((t) => ({
    ...t,
    textParams: { ...t.textParams },
  }));
}

export function getTitleTemplate(id: string): TitleTemplate | undefined {
  const t = TITLE_TEMPLATES.find((x) => x.id === id);
  if (!t) return undefined;
  return { ...t, textParams: { ...t.textParams } };
}

/**
 * Merge template defaults into existing textParams.
 * `slotText` overrides the text content when provided.
 */
export function applyTitleTemplateToTextParams(
  params: TextParams,
  templateId: string,
  slotText?: string
): TextParams | null {
  const template = getTitleTemplate(templateId);
  if (!template) return null;
  return {
    ...params,
    ...template.textParams,
    text:
      slotText !== undefined
        ? slotText
        : template.textParams.text !== undefined
          ? template.textParams.text
          : params.text,
  };
}
