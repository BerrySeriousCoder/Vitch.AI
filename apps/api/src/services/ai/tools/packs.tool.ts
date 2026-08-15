import {
  listPresets,
  listTempoPacks,
  applyPreset,
  getEffectPreset,
  defaultEffectInstance,
} from "@tempo/editor-core";
import { randomUUID } from "crypto";
import type { ProjectState } from "./project-state.js";
import { ensureProjectPacksLoaded } from "../../packs/load-project-packs.js";

function findClip(state: ProjectState, clipId: string) {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

export const packsToolDefinitions = [
  {
    name: "list_presets",
    description:
      "List presets from tempo packs (builtin:core includes animation, kinetic, effect presets). Optional packId filter.",
    parameters: {
      type: "object" as const,
      properties: {
        packId: { type: "string" },
      },
    },
  },
  {
    name: "apply_preset",
    description:
      "Apply a pack preset to a clip (kinetic/animation keyframes or effect preset). Use list_presets first.",
    parameters: {
      type: "object" as const,
      properties: {
        packId: { type: "string", description: "e.g. builtin:core" },
        presetId: { type: "string" },
        clipId: { type: "string" },
      },
      required: ["packId", "presetId", "clipId"],
    },
  },
];

export const packsToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) =>
    | { result: string; state: ProjectState }
    | Promise<{ result: string; state: ProjectState }>
> = {
  list_presets: async (args, state) => {
    const projectId = state.projectId;
    if (projectId) await ensureProjectPacksLoaded(projectId);
    const packs = listTempoPacks(projectId);
    const presets = listPresets(
      args.packId ? String(args.packId) : undefined,
      projectId
    );
    return {
      result: JSON.stringify({
        packs,
        presets: presets.slice(0, 80),
        total: presets.length,
      }),
      state,
    };
  },

  apply_preset: async (args, state) => {
    const clip = findClip(state, String(args.clipId));
    if (!clip) return { result: `Error: clip ${args.clipId} not found`, state };
    if (state.projectId) await ensureProjectPacksLoaded(state.projectId);
    const result = applyPreset(
      String(args.packId),
      String(args.presetId),
      {
        clipDuration: clip.duration,
        textParams: clip.textParams,
      },
      state.projectId
    );
    if (!result.ok) return { result: `Error: ${result.message}`, state };
    if (result.textParams) {
      clip.textParams = result.textParams;
      return { result: `Applied kinetic preset to ${clip.id}`, state };
    }
    if (result.keyframes) {
      clip.keyframes = result.keyframes;
      return { result: `Applied animation keyframes to ${clip.id}`, state };
    }
    if (result.effectPresetId) {
      const preset = getEffectPreset(result.effectPresetId);
      if (!preset) return { result: "Error: effect preset missing", state };
      const nextEffects = [...(clip.effects || [])];
      for (const fx of preset.effects) {
        const inst = defaultEffectInstance(fx.type, randomUUID());
        if (!inst) continue;
        nextEffects.push({
          ...inst,
          params: { ...inst.params, ...(fx.params || {}) },
        });
      }
      clip.effects = nextEffects;
      return {
        result: `Applied effect preset ${result.effectPresetId} to ${clip.id}`,
        state,
      };
    }
    return { result: "Error: nothing applied", state };
  },
};
