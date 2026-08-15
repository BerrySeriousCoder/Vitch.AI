import type { Clip, EditBlueprint, Effect, EasingType, Keyframe, Track } from "@tempo/types";
import { randomUUID } from "crypto";
import {
  applyAnimationPresetToKeyframes,
  applyEffectAnimationPresetToKeyframes,
  getEffectDefinition,
  listAnimationPresetIds,
  listEffectAnimationPresetIds,
} from "@tempo/editor-core";

interface ProjectState {
  tracks: Track[];
  editBlueprint?: EditBlueprint | null;
}

function findClip(state: ProjectState, clipId: string): Clip | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

function findEffect(clip: Clip, effectId: string): Effect | null {
  return clip.effects.find((e) => e.id === effectId) ?? null;
}

function isEffectParamKeyframeable(effectType: string, property: string): boolean {
  const def = getEffectDefinition(effectType);
  if (!def) return false;
  const param = def.params[property];
  if (!param) return false;
  return param.keyframeable !== false && param.type === "number";
}

const CLIP_ANIMATABLE =
  "opacity, transform.x, transform.y, transform.scaleX, transform.scaleY, transform.rotation, crop.x, crop.y, crop.width, crop.height, mediaLayout.viewport.x, mediaLayout.viewport.y, mediaLayout.viewport.width, mediaLayout.viewport.height";

const CLIP_ANIMATABLE_PROPERTIES = new Set(CLIP_ANIMATABLE.split(", "));
const EASINGS = new Set<EasingType>(["hold", "linear", "ease-in", "ease-out", "ease-in-out", "cubic-bezier"]);

function validateKeyframe(
  clip: Clip,
  property: string,
  time: unknown,
  value: unknown,
  easing: unknown,
  effect?: Effect,
  bezierHandles?: unknown
): string | null {
  const numericTime = Number(time);
  const numericValue = Number(value);
  if (!Number.isFinite(numericTime) || numericTime < 0 || numericTime > clip.duration) {
    return `time must be a finite number from 0 to clip duration (${clip.duration}s)`;
  }
  if (typeof value !== "number" || !Number.isFinite(numericValue)) {
    return "value must be a finite number";
  }
  if (!EASINGS.has(easing as EasingType)) {
    return `easing must be one of: ${[...EASINGS].join(", ")}`;
  }
  if (easing === "cubic-bezier") {
    if (!Array.isArray(bezierHandles) || bezierHandles.length !== 4 || !bezierHandles.every((handle) => Number.isFinite(Number(handle)))) {
      return "cubic-bezier easing requires four finite bezierHandles";
    }
    if (Number(bezierHandles[0]) < 0 || Number(bezierHandles[0]) > 1 || Number(bezierHandles[2]) < 0 || Number(bezierHandles[2]) > 1) {
      return "cubic-bezier x handles must be from 0 to 1";
    }
  }
  if (!effect) {
    if (!CLIP_ANIMATABLE_PROPERTIES.has(property)) return `Unsupported clip keyframe property "${property}"`;
    if (property === "opacity" && (numericValue < 0 || numericValue > 1)) return "opacity keyframes must be from 0 to 1";
    if ((property === "transform.scaleX" || property === "transform.scaleY") && numericValue < 0) return `${property} keyframes must be at least 0`;
    if (property.startsWith("crop.") && (numericValue < 0 || numericValue > 1)) return `${property} keyframes must be from 0 to 1`;
    if (property.startsWith("mediaLayout.viewport.") && (numericValue < 0 || numericValue > 1)) return `${property} keyframes must be from 0 to 1`;
    if ((property.endsWith(".width") || property.endsWith(".height")) && property.startsWith("mediaLayout.viewport.") && numericValue <= 0) {
      return `${property} keyframes must be greater than 0`;
    }
    return null;
  }
  if (!isEffectParamKeyframeable(effect.type, property)) return `Param "${property}" is not keyframeable on effect type "${effect.type}"`;
  const definition = getEffectDefinition(effect.type)!.params[property]!;
  if (definition.min !== undefined && numericValue < definition.min) return `${property} must be at least ${definition.min}`;
  if (definition.max !== undefined && numericValue > definition.max) return `${property} must be at most ${definition.max}`;
  return null;
}

export const keyframeToolDefinitions = [
  {
    name: "add_keyframe",
    description: `Add or update a keyframe. Without effectId: clip properties (${CLIP_ANIMATABLE}). With effectId: animate a keyframeable effect param (property = param id, e.g. value/amount/intensity). Time is clip-local (0 = clip start). Never write effect animations onto clip.keyframes.`,
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Clip ID" },
        effectId: {
          type: "string",
          description: "Optional effect ID — when set, keyframes go on that effect",
        },
        property: {
          type: "string",
          description: `Clip property (${CLIP_ANIMATABLE}) or effect param id when effectId is set`,
        },
        time: {
          type: "number",
          description: "Time within the clip in seconds (0 = clip start)",
        },
        value: {
          type: "number",
          description: "Keyframe value",
        },
        easing: {
          type: "string",
          enum: ["hold", "linear", "ease-in", "ease-out", "ease-in-out", "cubic-bezier"],
          description: "Easing (default linear)",
        },
        bezierHandles: { type: "array", items: { type: "number" }, description: "Four [x1,y1,x2,y2] values when easing is cubic-bezier" },
      },
      required: ["clipId", "property", "time", "value"],
    },
  },
  {
    name: "remove_keyframe",
    description: "Remove a keyframe by ID from a clip (or from an effect when effectId is set).",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        effectId: { type: "string", description: "Optional — remove from this effect" },
        keyframeId: { type: "string" },
      },
      required: ["clipId", "keyframeId"],
    },
  },
  {
    name: "set_keyframe_curve",
    description: `Atomically replace or merge one measured motion curve on a clip or effect. Each key may use clip-local time or a saved reference syncEventId; event anchors are resolved exactly from the retained reference analysis. Use hold for cuts, hits, stepped scale changes, visibility phases, and other non-smooth motion. This is the general tool for custom motion that does not match a preset.`,
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        effectId: { type: "string", description: "Optional effect whose numeric param is animated" },
        property: { type: "string", description: `Clip property (${CLIP_ANIMATABLE}) or effect param id` },
        replaceExisting: { type: "boolean", description: "Replace this property's curve (default true)" },
        keyframes: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: {
            type: "object",
            properties: {
              time: { type: "number", description: "Clip-local seconds; omit when syncEventId is used" },
              syncEventId: { type: "string", description: "Saved reference impact id; takes precedence over time" },
              value: { type: "number" },
              easing: { type: "string", enum: ["hold", "linear", "ease-in", "ease-out", "ease-in-out", "cubic-bezier"] },
              bezierHandles: { type: "array", items: { type: "number" } },
            },
            required: ["value"],
          },
        },
      },
      required: ["clipId", "property", "keyframes"],
    },
  },
  {
    name: "update_keyframe",
    description: "Update an existing keyframe's time, value, or easing (pass effectId for effect keyframes).",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        effectId: { type: "string" },
        keyframeId: { type: "string" },
        time: { type: "number" },
        value: { type: "number", description: "New value" },
        easing: {
          type: "string",
          enum: ["hold", "linear", "ease-in", "ease-out", "ease-in-out", "cubic-bezier"],
        },
        bezierHandles: { type: "array", items: { type: "number" }, description: "Four [x1,y1,x2,y2] values when easing is cubic-bezier" },
      },
      required: ["clipId", "keyframeId"],
    },
  },
  {
    name: "apply_animation_preset",
    description: `Apply a named animation preset to a clip (replaces existing clip keyframes). Text presets: ${listAnimationPresetIds("text").join(", ")}. Shape presets: ${listAnimationPresetIds("shape").join(", ")}. Prefer this when the user says "animate the text/shape".`,
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Clip to animate" },
        presetId: {
          type: "string",
          description: "Preset id (e.g. fade-in, slide-in-up, bounce, grow, spin-in)",
        },
      },
      required: ["clipId", "presetId"],
    },
  },
  {
    name: "apply_effect_animation_preset",
    description: `Apply a named effect-param animation preset onto an effect's keyframes (replaces that effect's keyframes). Presets: ${listEffectAnimationPresetIds().join(", ")}. Prefer when the user wants animated blur/glow/vignette/grain.`,
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        effectId: { type: "string", description: "Target effect (must match preset effectType)" },
        presetId: {
          type: "string",
          description: "Effect animation preset id",
        },
      },
      required: ["clipId", "effectId", "presetId"],
    },
  },
  {
    name: "clear_keyframes",
    description: "Remove all keyframes from a clip, or from one effect when effectId is set.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        effectId: { type: "string", description: "Optional — clear only this effect's keyframes" },
      },
      required: ["clipId"],
    },
  },
];

function upsertKeyframe(
  list: Keyframe[],
  property: string,
  time: number,
  value: number | string | boolean,
  easing: EasingType,
  bezierHandles?: Keyframe["bezierHandles"]
): { list: Keyframe[]; result: string } {
  const existing = list.findIndex(
    (k) => k.property === property && Math.abs(k.time - time) < 0.001
  );
  if (existing >= 0) {
    const kf = { ...list[existing]!, value, easing, bezierHandles: easing === "cubic-bezier" ? bezierHandles : undefined };
    const next = [...list];
    next[existing] = kf;
    return {
      list: next,
      result: `Updated keyframe ${kf.id} on ${property} @ ${time}s = ${JSON.stringify(value)}`,
    };
  }
  const id = randomUUID();
  const kf: Keyframe = { id, property, time, value, easing, ...(bezierHandles ? { bezierHandles } : {}) };
  return {
    list: [...list, kf],
    result: `Added keyframe ${id} on ${property} @ ${time}s = ${JSON.stringify(value)} (easing: ${easing})`,
  };
}

export const keyframeToolExecutors: Record<
  string,
  (args: any, state: ProjectState) => { result: string; state: ProjectState }
> = {
  add_keyframe: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };

    const property = String(args.property);
    const time = Number(args.time);
    const value = args.value;
    const easing = (args.easing as EasingType) || "linear";
    const bezierHandles = Array.isArray(args.bezierHandles) ? args.bezierHandles.map(Number) as Keyframe["bezierHandles"] : undefined;
    const effectId = args.effectId ? String(args.effectId) : null;

    if (effectId) {
      const effect = findEffect(clip, effectId);
      if (!effect) return { result: `Error: Effect ${effectId} not found on clip`, state };
      const error = validateKeyframe(clip, property, time, value, easing, effect, bezierHandles);
      if (error) return { result: `Error: ${error}`, state };
      const { list, result } = upsertKeyframe(
        effect.keyframes || [],
        property,
        time,
        value,
        easing,
        bezierHandles
      );
      effect.keyframes = list;
      return { result: `${result} [effect ${effectId}]`, state };
    }

    const error = validateKeyframe(clip, property, time, value, easing, undefined, bezierHandles);
    if (error) return { result: `Error: ${error}`, state };
    const { list, result } = upsertKeyframe(clip.keyframes, property, time, value, easing, bezierHandles);
    clip.keyframes = list;
    return { result, state };
  },

  set_keyframe_curve: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const property = String(args.property);
    const effectId = args.effectId ? String(args.effectId) : null;
    const effect = effectId ? findEffect(clip, effectId) || undefined : undefined;
    if (effectId && !effect) return { result: `Error: Effect ${effectId} not found on clip`, state };
    if (!Array.isArray(args.keyframes) || args.keyframes.length < 1 || args.keyframes.length > 256) {
      return { result: "Error: keyframes must contain 1..256 entries", state };
    }
    const impacts = state.editBlueprint?.audioAnalysis?.impacts || [];
    const resolved: Array<{ time: number; value: number; easing: EasingType; bezierHandles?: Keyframe["bezierHandles"] }> = [];
    for (let index = 0; index < args.keyframes.length; index++) {
      const input = args.keyframes[index];
      if (!input || typeof input !== "object") return { result: `Error: keyframes[${index}] must be an object`, state };
      let time: number;
      if (input.syncEventId) {
        const event = impacts.find((impact) => impact.id === String(input.syncEventId));
        if (!event) return { result: `Error: Unknown reference syncEventId "${String(input.syncEventId)}"`, state };
        time = event.time - clip.startTime;
      } else {
        time = Number(input.time);
      }
      const easing = (input.easing || "linear") as EasingType;
      const bezierHandles = Array.isArray(input.bezierHandles)
        ? input.bezierHandles.map(Number) as Keyframe["bezierHandles"]
        : undefined;
      const error = validateKeyframe(clip, property, time, input.value, easing, effect, bezierHandles);
      if (error) return { result: `Error: keyframes[${index}] ${error}`, state };
      resolved.push({ time, value: Number(input.value), easing, ...(bezierHandles ? { bezierHandles } : {}) });
    }
    resolved.sort((a, b) => a.time - b.time);
    let next = args.replaceExisting === false
      ? [...(effect ? effect.keyframes || [] : clip.keyframes)]
      : (effect ? effect.keyframes || [] : clip.keyframes).filter((keyframe) => keyframe.property !== property);
    for (const keyframe of resolved) {
      next = upsertKeyframe(next, property, keyframe.time, keyframe.value, keyframe.easing, keyframe.bezierHandles).list;
    }
    if (effect) effect.keyframes = next;
    else clip.keyframes = next;
    return {
      result: JSON.stringify({ ok: true, clipId: clip.id, ...(effectId ? { effectId } : {}), property, keyframes: resolved.length, replaced: args.replaceExisting !== false }),
      state,
    };
  },

  remove_keyframe: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const effectId = args.effectId ? String(args.effectId) : null;
    if (effectId) {
      const effect = findEffect(clip, effectId);
      if (!effect) return { result: `Error: Effect ${effectId} not found on clip`, state };
      const before = (effect.keyframes || []).length;
      effect.keyframes = (effect.keyframes || []).filter(
        (k) => k.id !== args.keyframeId
      );
      if (effect.keyframes.length === before) {
        return { result: `Error: Keyframe ${args.keyframeId} not found on effect`, state };
      }
      return { result: `Removed keyframe ${args.keyframeId} from effect ${effectId}`, state };
    }
    const before = clip.keyframes.length;
    clip.keyframes = clip.keyframes.filter((k) => k.id !== args.keyframeId);
    if (clip.keyframes.length === before) {
      return { result: `Error: Keyframe ${args.keyframeId} not found`, state };
    }
    return { result: `Removed keyframe ${args.keyframeId}`, state };
  },

  update_keyframe: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const effectId = args.effectId ? String(args.effectId) : null;
    if (effectId) {
      const effect = findEffect(clip, effectId);
      if (!effect) {
        return { result: `Error: Effect ${effectId} not found on clip`, state };
      }
      if (!effect.keyframes) effect.keyframes = [];
      const kf = effect.keyframes.find((k) => k.id === args.keyframeId);
      if (!kf) return { result: `Error: Keyframe ${args.keyframeId} not found`, state };
      const time = args.time !== undefined ? Number(args.time) : kf.time;
      const value = args.value !== undefined ? args.value : kf.value;
      const easing = args.easing !== undefined ? args.easing as EasingType : kf.easing;
      const bezierHandles = args.bezierHandles !== undefined ? args.bezierHandles : kf.bezierHandles;
      const error = validateKeyframe(clip, kf.property, time, value, easing, effect, bezierHandles);
      if (error) return { result: `Error: ${error}`, state };
      kf.time = time;
      kf.value = value;
      kf.easing = easing;
      kf.bezierHandles = easing === "cubic-bezier" ? bezierHandles as Keyframe["bezierHandles"] : undefined;
      return {
        result: `Updated keyframe ${kf.id} (${kf.property} @ ${kf.time}s) [effect ${effectId}]`,
        state,
      };
    }
    const kf = clip.keyframes.find((k) => k.id === args.keyframeId);
    if (!kf) return { result: `Error: Keyframe ${args.keyframeId} not found`, state };
    const time = args.time !== undefined ? Number(args.time) : kf.time;
    const value = args.value !== undefined ? args.value : kf.value;
    const easing = args.easing !== undefined ? args.easing as EasingType : kf.easing;
    const bezierHandles = args.bezierHandles !== undefined ? args.bezierHandles : kf.bezierHandles;
    const error = validateKeyframe(clip, kf.property, time, value, easing, undefined, bezierHandles);
    if (error) return { result: `Error: ${error}`, state };
    kf.time = time;
    kf.value = value;
    kf.easing = easing;
    kf.bezierHandles = easing === "cubic-bezier" ? bezierHandles as Keyframe["bezierHandles"] : undefined;
    return {
      result: `Updated keyframe ${kf.id} (${kf.property} @ ${kf.time}s)`,
      state,
    };
  },

  apply_animation_preset: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const frames = applyAnimationPresetToKeyframes(
      String(args.presetId),
      clip.duration
    );
    if (!frames) {
      return {
        result: `Error: Unknown preset "${args.presetId}". Valid: ${listAnimationPresetIds().join(", ")}`,
        state,
      };
    }
    clip.keyframes = frames;
    return {
      result: `Applied animation preset "${args.presetId}" to clip ${clip.id} (${frames.length} keyframes)`,
      state,
    };
  },

  apply_effect_animation_preset: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const effect = findEffect(clip, String(args.effectId));
    if (!effect) {
      return { result: `Error: Effect ${args.effectId} not found on clip`, state };
    }
    const applied = applyEffectAnimationPresetToKeyframes(
      String(args.presetId),
      clip.duration
    );
    if (!applied) {
      return {
        result: `Error: Unknown effect preset "${args.presetId}". Valid: ${listEffectAnimationPresetIds().join(", ")}`,
        state,
      };
    }
    if (applied.effectType !== effect.type) {
      return {
        result: `Error: Preset "${args.presetId}" targets ${applied.effectType}, but effect is ${effect.type}`,
        state,
      };
    }
    effect.keyframes = applied.keyframes;
    return {
      result: `Applied effect animation preset "${args.presetId}" to effect ${effect.id} (${applied.keyframes.length} keyframes)`,
      state,
    };
  },

  clear_keyframes: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const effectId = args.effectId ? String(args.effectId) : null;
    if (effectId) {
      const effect = findEffect(clip, effectId);
      if (!effect) return { result: `Error: Effect ${effectId} not found on clip`, state };
      const n = (effect.keyframes || []).length;
      effect.keyframes = [];
      return { result: `Cleared ${n} keyframes from effect ${effectId}`, state };
    }
    const n = clip.keyframes.length;
    clip.keyframes = [];
    return { result: `Cleared ${n} keyframes from clip ${clip.id}`, state };
  },
};
