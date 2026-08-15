import {
  applyChromaPreset,
  getChromaSchema,
  listChromaPresetIds,
  normalizeChromaKey,
  validateChromaKey,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";

function findClip(state: ProjectState, clipId: string) {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export const chromaToolDefinitions = [
  {
    name: "list_chroma_presets",
    description:
      "List chroma-key (green/blue screen) presets. Use set_clip_chroma_key with presetId. Not an effect — keying is first-class on the clip.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_chroma_schema",
    description:
      "Return chroma key param schema (keyColor, similarity, smoothness, spill) and presets.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "set_clip_chroma_key",
    description:
      "Enable or update chroma key on a clip (green/blue screen). Pass presetId (green-screen|blue-screen) and/or keyColor (#RRGGBB), similarity, smoothness, spill. Put the keyed clip ABOVE the background plate. Chroma runs BEFORE clip effects — add LUT/glow after keying. Raise similarity if leftover screen; lower if subject holes; raise spill for green fringe on skin. Never use add_effect for keying. Export uses Chromium frame path.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        presetId: {
          type: "string",
          description: "green-screen | blue-screen",
        },
        keyColor: { type: "string", description: "#RRGGBB" },
        similarity: { type: "number", description: "0..1" },
        smoothness: { type: "number", description: "0..1" },
        spill: { type: "number", description: "0..1" },
        screen: {
          type: "string",
          description: "green | blue | custom",
        },
      },
      required: ["clipId"],
    },
  },
  {
    name: "clear_clip_chroma_key",
    description: "Remove chroma key from a clip.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
      },
      required: ["clipId"],
    },
  },
];

export const chromaToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) => { result: string; state: ProjectState }
> = {
  list_chroma_presets: (_args, state) => {
    const ids = listChromaPresetIds();
    return {
      result: `Chroma presets: ${ids
        .map((id) => {
          const p = applyChromaPreset(id)!;
          return `${id} (key=${p.keyColor}, similarity=${p.similarity}, spill=${p.spill})`;
        })
        .join("; ")}`,
      state,
    };
  },

  get_chroma_schema: (_args, state) => {
    return {
      result: `chroma schema: ${JSON.stringify(getChromaSchema())}`,
      state,
    };
  },

  set_clip_chroma_key: (args, state) => {
    const found = findClip(state, String(args.clipId));
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };

    let base = found.clip.chromaKey
      ? normalizeChromaKey(found.clip.chromaKey)
      : null;

    if (args.presetId) {
      const preset = applyChromaPreset(String(args.presetId));
      if (!preset) {
        return {
          result: `Error: Unknown preset "${args.presetId}". Valid: ${listChromaPresetIds().join(", ")}`,
          state,
        };
      }
      base = preset;
    } else if (!base) {
      base = normalizeChromaKey({});
    }

    const merged = {
      ...base,
      ...(args.keyColor !== undefined ? { keyColor: String(args.keyColor) } : {}),
      ...(args.similarity !== undefined
        ? { similarity: Number(args.similarity) }
        : {}),
      ...(args.smoothness !== undefined
        ? { smoothness: Number(args.smoothness) }
        : {}),
      ...(args.spill !== undefined ? { spill: Number(args.spill) } : {}),
      ...(args.screen !== undefined ? { screen: args.screen } : {}),
    };

    const validated = validateChromaKey(merged);
    if (!validated.ok) return { result: `Error: ${validated.message}`, state };
    const value = normalizeChromaKey(validated.value);
    found.clip.chromaKey = value;
    return {
      result: `Set chroma key on ${args.clipId} (key=${value.keyColor}, similarity=${value.similarity}, smoothness=${value.smoothness}, spill=${value.spill})`,
      state,
    };
  },

  clear_clip_chroma_key: (args, state) => {
    const found = findClip(state, String(args.clipId));
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    found.clip.chromaKey = null;
    return { result: `Cleared chroma key on ${args.clipId}`, state };
  },
};
