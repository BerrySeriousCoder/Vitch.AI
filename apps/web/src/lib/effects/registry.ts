/**
 * Web UI effect registry — backed by @tempo/editor-core (WebGPU preview).
 * Kept for stable import paths used by Effects UI.
 */
import {
  listEffectDefinitions,
  getEffectDefinition,
  type EffectDefinition,
  type EffectParamDefinition,
} from "@tempo/editor-core";
import type { EffectParamValue } from "@tempo/types";

export type { EffectDefinition, EffectParamDefinition };

export interface ParamDefinition {
  type: "number" | "string" | "boolean" | "color";
  label: string;
  defaultValue: EffectParamValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export function getAllEffects(): EffectDefinition[] {
  return listEffectDefinitions();
}

export function getEffectsByCategory(category: string): EffectDefinition[] {
  return getAllEffects().filter((e) => e.category === category);
}

export function getCategories(): string[] {
  return Array.from(new Set(getAllEffects().map((e) => e.category)));
}

export { getEffectDefinition };
