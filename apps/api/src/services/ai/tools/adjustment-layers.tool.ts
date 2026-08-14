import { randomUUID } from "crypto";
import { createAdjustmentLayer, toolErr, toolOk } from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";

export const adjustmentLayerToolDefinitions = [
  {
    name: "add_adjustment_layer",
    description:
      "Create a real, time-bounded adjustment layer above the current stack. Effects added to the returned clipId grade/composite every visible track below it during that time range; tracks above remain untouched. This uses the shared frame-export path for parity. Reorder the track to control its scope.",
    parameters: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Optional layer name, e.g. Global Grade" },
        startTime: { type: "number", description: "Timeline start in seconds (default 0)" },
        duration: { type: "number", description: "Positive layer duration in seconds" },
      },
      required: ["duration"],
    },
  },
];

export const adjustmentLayerToolExecutors: Record<
  string,
  (args: Record<string, any>, state: ProjectState) => { result: string; state: ProjectState }
> = {
  add_adjustment_layer: (args, state) => {
    const result = createAdjustmentLayer({
      tracks: state.tracks,
      trackId: randomUUID(),
      clipId: randomUUID(),
      name: typeof args.name === "string" ? args.name : undefined,
      startTime: args.startTime === undefined ? 0 : Number(args.startTime),
      duration: Number(args.duration),
    });
    if (!result.ok) {
      return { result: toolErr(result.message, { code: "INVALID_ADJUSTMENT_LAYER" }), state };
    }
    state.tracks = result.tracks;
    return {
      result: toolOk(
        `Created adjustment layer. Add effects to clip ${result.clipId}; it affects only tracks below this layer.`,
        { trackId: result.trackId, clipId: result.clipId }
      ),
      state,
    };
  },
};
