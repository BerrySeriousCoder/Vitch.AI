import type { Track, Clip, SpeedRampPoint } from "@tempo/types";
import {
  applySpeedPreset,
  listSpeedPresetIds,
  normalizeRetimeSettings,
  validateSpeedRamp,
} from "@tempo/editor-core";
import { syncCaptionsBoundToClip } from "./caption-binding-sync.js";

interface ProjectState {
  tracks: Track[];
}

function findClip(state: ProjectState, clipId: string): Clip | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

export const speedToolDefinitions = [
  {
    name: "set_clip_speed",
    description:
      "Set constant clip speed. Positive = forward (1=normal, 0.5=half, 2=2x). Negative = reverse at that magnitude (e.g. -1). Clears any speed ramp. Prefer apply_speed_preset for slow-mo-middle / ramp-in / reverse.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        speed: {
          type: "number",
          description: "Non-zero speed. Negative means reverse.",
        },
      },
      required: ["clipId", "speed"],
    },
  },
  {
    name: "set_speed_ramp",
    description:
      "Replace the clip speed ramp (rate envelope over clip-local time). Rates must be ≥ 0; use set_clip_speed negative or apply_speed_preset reverse for direction. Timeline duration stays fixed. Min 2 points: [{time, rate}, …].",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              time: { type: "number" },
              rate: { type: "number" },
              interpolation: { type: "string", enum: ["linear", "smooth", "hold"], description: "Outgoing velocity curve to the next point; smooth is best for cinematic ramps" },
            },
            required: ["time", "rate"],
          },
        },
        reversed: {
          type: "boolean",
          description: "Play the consumed source window backwards (default false)",
        },
      },
      required: ["clipId", "points"],
    },
  },
  {
    name: "set_retime_quality",
    description: "Set variable-speed image quality. nearest is crisp/default; frame-blend cross-dissolves adjacent decoded frames for smoother slow motion and ramps, with possible ghosting on fast motion. Both preview and export use the same setting.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        interpolation: { type: "string", enum: ["nearest", "frame-blend"] },
        frameRate: { type: "number", description: "12..60 source sampling cadence for frame-blend; default 30" },
      },
      required: ["clipId", "interpolation"],
    },
  },
  {
    name: "clear_speed_ramp",
    description: "Remove speed ramp; clip returns to constant speed (keeps current speed magnitude).",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "apply_speed_preset",
    description: `Apply a named speed preset. Presets: ${listSpeedPresetIds().join(", ")}.`,
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        presetId: {
          type: "string",
          description: "slow-mo-middle | ramp-in | ramp-out | speed-up-middle | reverse",
        },
      },
      required: ["clipId", "presetId"],
    },
  },
];

export const speedToolExecutors: Record<
  string,
  (args: any, state: ProjectState) => { result: string; state: ProjectState }
> = {
  set_clip_speed: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const speed = args.speed;
    if (typeof speed !== "number" || !Number.isFinite(speed) || speed === 0) {
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
    if (clip.sourceMediaId) syncCaptionsBoundToClip(state as any, clip);
    return {
      result: `Set speed=${clip.speed}${clip.reversed ? " (reversed)" : ""} on ${clip.id}; ramp cleared`,
      state,
    };
  },

  set_speed_ramp: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const validated = validateSpeedRamp(args.points, clip.duration);
    if (!validated.ok) return { result: `Error: ${validated.message}`, state };
    if (!validated.value) {
      return { result: "Error: speedRamp requires at least 2 points", state };
    }
    if (args.reversed !== undefined && typeof args.reversed !== "boolean") {
      return { result: "Error: reversed must be a boolean", state };
    }
    clip.speedRamp = validated.value as SpeedRampPoint[];
    clip.reversed = args.reversed ?? false;
    if (clip.speed < 0) clip.speed = Math.abs(clip.speed);
    if (clip.sourceMediaId) syncCaptionsBoundToClip(state as any, clip);
    return {
      result: `Set speed ramp (${clip.speedRamp.length} points)${clip.reversed ? " reversed" : ""} on ${clip.id}`,
      state,
    };
  },

  clear_speed_ramp: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    clip.speedRamp = null;
    return { result: `Cleared speed ramp on ${clip.id}`, state };
  },

  set_retime_quality: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    if (args.interpolation !== "nearest" && args.interpolation !== "frame-blend") return { result: "Error: interpolation must be nearest or frame-blend", state };
    if (args.frameRate !== undefined && (typeof args.frameRate !== "number" || !Number.isFinite(args.frameRate))) {
      return { result: "Error: frameRate must be a finite number", state };
    }
    clip.retime = normalizeRetimeSettings({ interpolation: args.interpolation, frameRate: args.frameRate });
    return { result: `Set retime quality ${clip.retime.interpolation} (${clip.retime.frameRate}fps sampling) on ${clip.id}`, state };
  },

  apply_speed_preset: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const applied = applySpeedPreset(String(args.presetId), clip.duration);
    if (!applied) {
      return {
        result: `Error: Unknown preset "${args.presetId}". Valid: ${listSpeedPresetIds().join(", ")}`,
        state,
      };
    }
    clip.speed = applied.speed;
    clip.reversed = applied.reversed;
    clip.speedRamp = applied.speedRamp;
    if (clip.sourceMediaId) syncCaptionsBoundToClip(state as any, clip);
    return {
      result: `Applied speed preset "${args.presetId}" to ${clip.id}`,
      state,
    };
  },
};
