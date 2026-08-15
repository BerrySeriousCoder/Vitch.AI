import type { Track, Clip, Effect, EffectParamValue, BlendMode, Transform, LutAsset } from "@tempo/types";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, lutAssets } from "@tempo/db";
import {
  getEffectPreset,
  listEffectPresetIds,
  listEffectDefinitions,
  getEffectSchema,
  defaultEffectInstance,
  validateEffectParams,
  listEffectTypes,
  BUILTIN_LUT_IDS,
  isBuiltinLutId,
  setEffectEnabled,
  reorderClipEffects,
  applyClipAttributes,
  type ClipAttributeScope,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";
import { syncCaptionsBoundToClip } from "./caption-binding-sync.js";

function findClip(state: ProjectState, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

const CLIP_TRANSFORM_PROPERTIES = new Set<keyof Transform>([
  "x",
  "y",
  "scaleX",
  "scaleY",
  "rotation",
  "anchorX",
  "anchorY",
]);

const BLEND_MODES = new Set<BlendMode>([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
]);

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Cross-field HSL qualifier validation after partial params are merged. */
function hslSecondaryRangeError(params: Record<string, EffectParamValue>): string | null {
  const saturationMin = Number(params.saturationMin);
  const saturationMax = Number(params.saturationMax);
  if (Number.isFinite(saturationMin) && Number.isFinite(saturationMax) && saturationMin > saturationMax) {
    return "HSL secondary saturationMin cannot exceed saturationMax";
  }
  const lightnessMin = Number(params.lightnessMin);
  const lightnessMax = Number(params.lightnessMax);
  if (Number.isFinite(lightnessMin) && Number.isFinite(lightnessMax) && lightnessMin > lightnessMax) {
    return "HSL secondary lightnessMin cannot exceed lightnessMax";
  }
  return null;
}

/** Cross-field Levels validation after partial params are merged. */
function levelsRangeError(params: Record<string, EffectParamValue>): string | null {
  const inputBlack = Number(params.inputBlack);
  const inputWhite = Number(params.inputWhite);
  if (Number.isFinite(inputBlack) && Number.isFinite(inputWhite) && inputBlack >= inputWhite) {
    return "Levels inputBlack must be below inputWhite";
  }
  const outputBlack = Number(params.outputBlack);
  const outputWhite = Number(params.outputWhite);
  if (Number.isFinite(outputBlack) && Number.isFinite(outputWhite) && outputBlack >= outputWhite) {
    return "Levels outputBlack must be below outputWhite";
  }
  return null;
}

async function assertValidLutId(
  state: ProjectState,
  lutId: string
): Promise<string | null> {
  if (!lutId) return "lutId is required";
  if (isBuiltinLutId(lutId)) return null;
  const { luts, error } = await loadProjectLuts(state);
  if (luts.some((l) => l.id === lutId)) return null;
  if (error) return error;
  return `Unknown lutId "${lutId}". Use list_luts for builtins and uploads.`;
}

function toLutAsset(row: typeof lutAssets.$inferSelect): LutAsset {
  return {
    id: row.id,
    name: row.name,
    fileName: row.fileName,
    url: row.url,
    format: "cube",
    size: row.size,
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadProjectLuts(
  state: ProjectState
): Promise<{ luts: LutAsset[]; error?: string }> {
  if (!state.projectId) {
    return { luts: state.lutAssets || [] };
  }
  try {
    const rows = await db.query.lutAssets.findMany({
      where: eq(lutAssets.projectId, state.projectId),
    });
    const assets = rows.map(toLutAsset);
    state.lutAssets = assets;
    return { luts: assets };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load project LUTs";
    return {
      luts: state.lutAssets || [],
      error: `Database error loading LUTs: ${message}`,
    };
  }
}

const EFFECT_TYPES = listEffectTypes();

export const effectsToolDefinitions = [
  {
    name: "list_effects",
    description:
      "List registered visual effect types with categories, exportBackend hints, and default params (WebGPU preview). Includes vignette, grain, glow, lut.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_effect_schema",
    description:
      "Get the full parameter schema for one effect type (ranges, defaults, keyframeable flags).",
    parameters: {
      type: "object" as const,
      properties: {
        effectType: {
          type: "string",
          description: `Effect type id (${EFFECT_TYPES.join(", ")})`,
        },
      },
      required: ["effectType"],
    },
  },
  {
    name: "list_luts",
    description:
      "List built-in LUTs (builtin:identity, builtin:cinematic) and project-uploaded .cube LUTs. Use lut ids with add_effect type=lut / set_effect_params.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "set_clip_input_color_space",
    description: "Set or clear an input transform before all grades on a clip. Use slog3 for Sony S-Log3 or hlg for Rec.2100 HLG footage; rec709 clears the transform. This is conversion, not a creative LUT.",
    parameters: {
      type: "object" as const,
      properties: { clipId: { type: "string" }, profile: { type: "string", enum: ["rec709", "slog3", "hlg"] }, exposureCompensation: { type: "number", description: "-4..4 EV compensation applied during log/HLG conversion" } },
      required: ["clipId", "profile"],
    },
  },
  {
    name: "add_effect",
    description:
      "Apply a registered visual effect to a clip or adjustment layer. Prefer list_effects / get_effect_schema. Use color-grade for primary correction, levels for black/white point control, lift-gamma-gain for tonal wheel balancing, hsl-secondary for a qualified color range, and color-curves for RGB/luma control-point curves; all render/export through the WebGPU frame path. Pass params object (or legacy value for single-value effects).",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip to apply the effect to" },
        effectType: {
          type: "string",
          description: `Effect type from list_effects (${EFFECT_TYPES.join(", ")})`,
        },
        params: {
          type: "object",
          description:
            "Partial params matching the effect schema (e.g. { exposure: 0.35, temperature: 18, highlights: -20, vibrance: 12 } for color-grade; { inputBlack: 0.04, inputWhite: 0.96, gamma: 1.08 } for levels; { liftBlue: 0.1, gainRed: 0.08 } for lift-gamma-gain; { hueCenter: 28, hueRange: 24, saturationShift: 10 } for hsl-secondary; color-curves uses arrays like { luma:[{x:0,y:0},{x:0.5,y:0.65},{x:1,y:1}] }; { amount: 0.5 } for vignette).",
        },
        value: {
          type: "number",
          description:
            "Legacy single-value shorthand for CSS-like effects that use params.value (brightness, blur, etc.).",
        },
      },
      required: ["clipId", "effectType"],
    },
  },
  {
    name: "set_effect_params",
    description:
      "Update params on an existing effect instance (schema-validated). Partial merge.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        effectId: { type: "string" },
        params: {
          type: "object",
          description: "Partial params to merge. For hsl-secondary keep each min qualifier at or below its max. For color-curves, each channel is 2–8 strictly increasing points that start at x=0 and end at x=1.",
        },
      },
      required: ["clipId", "effectId", "params"],
    },
  },
  {
    name: "remove_effect",
    description: "Remove an effect from a clip by its effect ID.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip" },
        effectId: { type: "string", description: "ID of the effect to remove" },
      },
      required: ["clipId", "effectId"],
    },
  },
  {
    name: "set_effect_enabled",
    description: "Enable or bypass an effect without deleting its params or keyframes.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        effectId: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["clipId", "effectId", "enabled"],
    },
  },
  {
    name: "reorder_effects",
    description: "Set the complete effect stack order for a clip. effectIds must list every current effect ID exactly once; order affects the final image.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        effectIds: { type: "array", items: { type: "string" } },
      },
      required: ["clipId", "effectIds"],
    },
  },
  {
    name: "copy_clip_attributes",
    description: "Copy non-destructive attribute groups from one timeline clip to target clips. scopes supports effects, color, motion, audio. Effects/color retain params and keyframes but receive new IDs on every target.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string" },
        targetClipIds: { type: "array", items: { type: "string" } },
        scopes: { type: "array", items: { type: "string" }, description: "One or more: effects, color, motion, audio" },
        replaceEffects: { type: "boolean", description: "Replace matching effects on targets; default true" },
      },
      required: ["sourceClipId", "targetClipIds", "scopes"],
    },
  },
  {
    name: "apply_effect_preset",
    description: `Apply a named look/preset to a clip (appends effects). Presets: ${listEffectPresetIds().join(", ")} (also accept names like "Cinematic", "Vintage").`,
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        presetId: {
          type: "string",
          description: `Preset id or name (${listEffectPresetIds().join(", ")})`,
        },
        replace: {
          type: "boolean",
          description: "If true, replace existing effects instead of appending (default false)",
        },
      },
      required: ["clipId", "presetId"],
    },
  },
  {
    name: "set_clip_property",
    description:
      "Set a property on a clip: opacity (0-1), blendMode, speed, volume (0-1), or transform properties (transform.x, transform.y, transform.scaleX, transform.scaleY, transform.rotation, transform.anchorX, transform.anchorY). Anchor values are composition pixels.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "ID of the clip" },
        property: {
          type: "string",
          description:
            "Property to set. One of: opacity, blendMode, speed, volume, muted, transform.x, transform.y, transform.scaleX, transform.scaleY, transform.rotation, transform.anchorX, transform.anchorY",
        },
        value: {
          description: "The value to set (number, string, or boolean depending on property)",
        },
      },
      required: ["clipId", "property", "value"],
    },
  },
];

export const effectsToolExecutors: Record<
  string,
  (
    args: any,
    state: ProjectState
  ) =>
    | { result: string; state: ProjectState }
    | Promise<{ result: string; state: ProjectState }>
> = {
  set_clip_input_color_space: async (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    const profile = args.profile === "slog3" || args.profile === "hlg" ? args.profile : "rec709";
    const existingIndex = found.clip.effects.findIndex((effect) => effect.type === "input-color-transform");
    if (profile === "rec709") {
      if (existingIndex >= 0) found.clip.effects.splice(existingIndex, 1);
      return { result: JSON.stringify({ ok: true, clipId: found.clip.id, profile, cleared: existingIndex >= 0 }), state };
    }
    const exposureCompensation = Math.max(-4, Math.min(4, Number(args.exposureCompensation) || 0));
    const params = { profile, exposureCompensation };
    if (existingIndex >= 0) {
      found.clip.effects[existingIndex] = { ...found.clip.effects[existingIndex]!, enabled: true, params: { ...found.clip.effects[existingIndex]!.params, ...params } };
    } else {
      const base = defaultEffectInstance("input-color-transform", randomUUID())!;
      found.clip.effects.unshift({ id: base.id, type: base.type, name: base.name, enabled: true, params, keyframes: [] });
    }
    return { result: JSON.stringify({ ok: true, clipId: found.clip.id, profile, exposureCompensation, note: "Input conversion runs before primary/secondary grade and uses frame export." }), state };
  },

  list_effects: (_args, state) => {
    const list = listEffectDefinitions().map((d) => ({
      type: d.type,
      name: d.name,
      category: d.category,
      previewBackend: d.previewBackend,
      exportBackend: d.exportBackend ?? "ffmpeg",
      defaults: Object.fromEntries(
        Object.entries(d.params).map(([k, p]) => [k, p.defaultValue])
      ),
    }));
    return { result: JSON.stringify(list, null, 2), state };
  },

  get_effect_schema: (args, state) => {
    const schema = getEffectSchema(String(args.effectType));
    if (!schema) {
      return {
        result: `Error: Unknown effect "${args.effectType}". Use list_effects.`,
        state,
      };
    }
    return { result: JSON.stringify(schema, null, 2), state };
  },

  list_luts: async (_args, state) => {
    const { luts, error } = await loadProjectLuts(state);
    const builtins = BUILTIN_LUT_IDS.map((id) => ({
      id,
      name: id === "builtin:identity" ? "Identity" : "Cinematic",
      source: "builtin",
    }));
    const uploaded = luts.map((l) => ({
      id: l.id,
      name: l.name,
      source: "upload",
      size: l.size,
    }));
    const payload = { builtins, uploaded, ...(error ? { warning: error } : {}) };
    return { result: JSON.stringify(payload, null, 2), state };
  },

  add_effect: async (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };

    const effectType = String(args.effectType);
    const base = defaultEffectInstance(effectType, randomUUID());
    if (!base) {
      return {
        result: `Error: Unknown effect type "${effectType}". Use list_effects.`,
        state,
      };
    }

    let partial: Record<string, EffectParamValue> = {};
    if (args.params && typeof args.params === "object") {
      partial = { ...args.params };
    } else if (args.value != null && "value" in base.params) {
      partial = { value: Number(args.value) };
    }

    if (Object.keys(partial).length > 0) {
      const validated = validateEffectParams(effectType, partial);
      if (!validated.ok) {
        return { result: `Error: ${validated.message}`, state };
      }
      Object.assign(base.params, validated.params);
    }

    if (effectType === "hsl-secondary") {
      const rangeError = hslSecondaryRangeError(base.params);
      if (rangeError) return { result: `Error: ${rangeError}`, state };
    }
    if (effectType === "levels") {
      const rangeError = levelsRangeError(base.params);
      if (rangeError) return { result: `Error: ${rangeError}`, state };
    }

    if (effectType === "lut") {
      const lutId = String(base.params.lutId ?? "");
      const lutErr = await assertValidLutId(state, lutId);
      if (lutErr) return { result: `Error: ${lutErr}`, state };
    }

    const effect: Effect = {
      id: base.id,
      type: base.type,
      name: base.name,
      enabled: true,
      params: base.params,
      keyframes: [],
    };
    found.clip.effects.push(effect);
    return {
      result: `Added ${effect.name} effect (id: ${effect.id}, params: ${JSON.stringify(effect.params)}) to clip`,
      state,
    };
  },

  set_effect_params: async (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };

    const effect = found.clip.effects.find((e) => e.id === args.effectId);
    if (!effect) {
      return { result: `Error: Effect ${args.effectId} not found on clip`, state };
    }

    const partial =
      args.params && typeof args.params === "object"
        ? (args.params as Record<string, EffectParamValue>)
        : {};
    if (Object.keys(partial).length === 0) {
      return { result: "Error: params object required", state };
    }

    const validated = validateEffectParams(effect.type, partial);
    if (!validated.ok) {
      return { result: `Error: ${validated.message}`, state };
    }

    if (
      effect.type === "lut" &&
      validated.params.lutId != null
    ) {
      const lutErr = await assertValidLutId(state, String(validated.params.lutId));
      if (lutErr) return { result: `Error: ${lutErr}`, state };
    }

    const nextParams = { ...effect.params, ...validated.params };
    if (effect.type === "hsl-secondary") {
      const rangeError = hslSecondaryRangeError(nextParams);
      if (rangeError) return { result: `Error: ${rangeError}`, state };
    }
    if (effect.type === "levels") {
      const rangeError = levelsRangeError(nextParams);
      if (rangeError) return { result: `Error: ${rangeError}`, state };
    }

    effect.params = nextParams;
    return {
      result: `Updated effect ${effect.id} params: ${JSON.stringify(effect.params)}`,
      state,
    };
  },

  remove_effect: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };

    const before = found.clip.effects.length;
    found.clip.effects = found.clip.effects.filter((e) => e.id !== args.effectId);
    if (found.clip.effects.length === before) {
      return { result: `Error: Effect ${args.effectId} not found on clip`, state };
    }
    return { result: `Removed effect ${args.effectId}`, state };
  },

  set_effect_enabled: (args, state) => {
    if (typeof args.enabled !== "boolean") return { result: "Error: enabled must be a boolean", state };
    const result = setEffectEnabled(state.tracks, String(args.clipId), String(args.effectId), args.enabled);
    if ("ok" in result) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    return { result: JSON.stringify({ ok: true, clipId: String(args.clipId), effectId: String(args.effectId), enabled: args.enabled }), state };
  },

  reorder_effects: (args, state) => {
    const effectIds = Array.isArray(args.effectIds) ? args.effectIds.map(String) : [];
    const result = reorderClipEffects(state.tracks, String(args.clipId), effectIds);
    if ("ok" in result) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    return { result: JSON.stringify({ ok: true, clipId: String(args.clipId), effectIds }), state };
  },

  copy_clip_attributes: (args, state) => {
    if (args.replaceEffects !== undefined && typeof args.replaceEffects !== "boolean") {
      return { result: "Error: replaceEffects must be a boolean", state };
    }
    const allowedScopes = new Set<ClipAttributeScope>(["effects", "color", "motion", "audio"]);
    const scopes = Array.isArray(args.scopes)
      ? args.scopes.map(String).filter((scope: string): scope is ClipAttributeScope => allowedScopes.has(scope as ClipAttributeScope))
      : [];
    if (scopes.length === 0) return { result: "Error: scopes must contain effects, color, motion, and/or audio", state };
    const targetClipIds = Array.isArray(args.targetClipIds) ? args.targetClipIds.map(String) : [];
    const result = applyClipAttributes(state.tracks, {
      sourceClipId: String(args.sourceClipId),
      targetClipIds,
      scopes,
      replaceEffects: args.replaceEffects ?? true,
    }, randomUUID);
    if ("ok" in result) return { result: `Error: ${result.message}`, state };
    state.tracks = result.tracks;
    return { result: JSON.stringify({ ok: true, sourceClipId: String(args.sourceClipId), targetClipIds: result.affectedClipIds, scopes }), state };
  },

  apply_effect_preset: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    if (args.replace !== undefined && typeof args.replace !== "boolean") {
      return { result: "Error: replace must be a boolean", state };
    }

    const preset = getEffectPreset(String(args.presetId));
    if (!preset) {
      return {
        result: `Error: Unknown effect preset "${args.presetId}". Valid: ${listEffectPresetIds().join(", ")}`,
        state,
      };
    }

    if (args.replace) {
      found.clip.effects = [];
    }

    const ids: string[] = [];
    for (const fx of preset.effects) {
      const id = randomUUID();
      found.clip.effects.push({
        ...fx,
        id,
        params: { ...fx.params },
        keyframes: [],
      });
      ids.push(id);
    }

    return {
      result: `Applied effect preset "${preset.name}" (${preset.id}) to clip — effects: ${ids.join(", ")}`,
      state,
    };
  },

  set_clip_property: (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };

    const { clip } = found;
    const prop: string = args.property;
    const value = args.value;

    if (prop.startsWith("transform.")) {
      const key = prop.replace("transform.", "") as keyof Transform;
      const numericValue = finiteNumber(value);
      if (!CLIP_TRANSFORM_PROPERTIES.has(key) || numericValue === null) {
        return { result: `Error: Invalid value for ${prop}`, state };
      }
      if ((key === "scaleX" || key === "scaleY") && numericValue < 0) {
        return { result: `Error: ${prop} must be at least 0`, state };
      }
      clip.transform[key] = numericValue;
    } else if (prop === "opacity") {
      const numericValue = finiteNumber(value);
      if (numericValue === null || numericValue < 0 || numericValue > 1) {
        return { result: "Error: opacity must be a finite number from 0 to 1", state };
      }
      clip.opacity = numericValue;
    } else if (prop === "blendMode") {
      if (typeof value !== "string" || !BLEND_MODES.has(value as BlendMode)) {
        return { result: `Error: Unknown blend mode ${JSON.stringify(value)}`, state };
      }
      clip.blendMode = value as BlendMode;
    } else if (prop === "speed") {
      const speed = finiteNumber(value);
      if (speed === null || speed === 0) {
        return { result: "Error: speed must be a non-zero finite number", state };
      }
      if (speed < 0) {
        clip.speed = Math.abs(speed);
        clip.reversed = true;
      } else {
        clip.speed = speed;
        clip.reversed = false;
      }
      clip.speedRamp = null;
      if (clip.sourceMediaId) syncCaptionsBoundToClip(state, clip);
    } else if (prop === "volume") {
      const numericValue = finiteNumber(value);
      if (numericValue === null || numericValue < 0 || numericValue > 1) {
        return { result: "Error: volume must be a finite number from 0 to 1", state };
      }
      clip.volume = numericValue;
    } else if (prop === "muted") {
      if (typeof value !== "boolean") {
        return { result: "Error: muted must be a boolean", state };
      }
      clip.muted = value;
    } else {
      return { result: `Error: Unknown property "${prop}"`, state };
    }

    return { result: `Set ${prop} = ${JSON.stringify(value)} on clip`, state };
  },
};
