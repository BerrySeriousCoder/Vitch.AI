/** Re-export shared effect presets (stable UI import path). */
import { EFFECT_PRESETS, type EffectPreset } from "@tempo/editor-core";

export type { EffectPreset };

/** Legacy shape used by Effects UI (name-keyed list). */
export const effectPresets = EFFECT_PRESETS.map(({ name, description, effects }) => ({
  name,
  description,
  effects,
}));
