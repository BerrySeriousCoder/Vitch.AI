import { normalizeMask, validateMask } from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";

function findClip(state: ProjectState, clipId: string) {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export const masksToolDefinitions = [
  {
    name: "set_clip_mask",
    description:
      "Set a rect or ellipse mask on a clip (normalized 0..1 bounds, feather, invert, opacity). Export uses Chromium frame path when masks are present.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        shape: { type: "string", description: "rect | ellipse" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        feather: { type: "number", description: "0..0.5 soft edge" },
        inverted: { type: "boolean" },
        opacity: { type: "number" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "clear_clip_mask",
    description: "Remove the mask from a clip.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
      },
      required: ["clipId"],
    },
  },
];

export const masksToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) => { result: string; state: ProjectState }
> = {
  set_clip_mask: (args, state) => {
    const found = findClip(state, String(args.clipId));
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    const validated = validateMask({
      shape: args.shape ?? found.clip.mask?.shape ?? "ellipse",
      x: args.x ?? found.clip.mask?.x,
      y: args.y ?? found.clip.mask?.y,
      width: args.width ?? found.clip.mask?.width,
      height: args.height ?? found.clip.mask?.height,
      feather: args.feather ?? found.clip.mask?.feather,
      inverted: args.inverted ?? found.clip.mask?.inverted,
      opacity: args.opacity ?? found.clip.mask?.opacity,
    });
    if (!validated.ok) return { result: `Error: ${validated.message}`, state };
    const mask = normalizeMask(validated.value);
    found.clip.mask = mask;
    return {
      result: `Set ${mask.shape} mask on ${args.clipId} (feather=${mask.feather})`,
      state,
    };
  },

  clear_clip_mask: (args, state) => {
    const found = findClip(state, String(args.clipId));
    if (!found) return { result: `Error: Clip ${args.clipId} not found`, state };
    found.clip.mask = null;
    return { result: `Cleared mask on ${args.clipId}`, state };
  },
};
