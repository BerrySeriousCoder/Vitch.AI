import { randomUUID } from "crypto";
import {
  applyKenBurns,
  listKenBurnsPresetIds,
  normalizeCrop,
  validateMediaViewport,
  toolErr,
  toolOk,
  validateCrop,
  type KenBurnsPresetId,
} from "@tempo/editor-core";
import type { Clip } from "@tempo/types";
import type { ProjectState } from "./project-state.js";

function findVisualClip(
  state: ProjectState,
  clipId: string
): { ok: true; clip: Clip } | { ok: false; error: string } {
  for (const track of state.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (!clip) continue;
    if (track.type === "audio") return { ok: false, error: "Audio clips cannot be cropped" };
    return { ok: true, clip };
  }
  return { ok: false, error: `Clip ${clipId} not found` };
}

export const cropToolDefinitions = [
  {
    name: "set_media_fit",
    description:
      "Set non-distorting base placement for a video/image clip. Use cover for full-frame social video, contain to show the whole source, none for intrinsic size, and fill only when the user explicitly requests distortion. Optional focalX/focalY keep a subject inside a cover crop.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        fit: { type: "string", enum: ["cover", "contain", "fill", "none"] },
        focalX: { type: "number", description: "Normalized source focal X, 0..1" },
        focalY: { type: "number", description: "Normalized source focal Y, 0..1" },
      },
      required: ["clipId", "fit"],
    },
  },
  {
    name: "set_clip_crop",
    description:
      "Set or update a non-destructive source crop on a visual clip. Bounds are normalized 0..1 and must stay inside the source. Crop uses the shared WebGPU frame export path for parity.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        x: { type: "number", description: "Left source UV (0..1)" },
        y: { type: "number", description: "Top source UV (0..1)" },
        width: { type: "number", description: "Crop width (0..1)" },
        height: { type: "number", description: "Crop height (0..1)" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "set_media_viewport",
    description:
      "Place a video/image inside an exact normalized composition cell without stretching it. x/y/width/height are 0..1 composition fractions. Combine with cover/contain and keyframe mediaLayout.viewport.* for grids, split screens, collages, and animated panel reveals.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        fit: { type: "string", enum: ["cover", "contain"] },
        focalX: { type: "number" },
        focalY: { type: "number" },
      },
      required: ["clipId", "x", "y", "width", "height"],
    },
  },
  {
    name: "clear_media_viewport",
    description: "Return a video/image to the full composition and remove only viewport keyframes.",
    parameters: {
      type: "object" as const,
      properties: { clipId: { type: "string" } },
      required: ["clipId"],
    },
  },
  {
    name: "clear_clip_crop",
    description: "Reset a clip to its uncropped source and remove any crop keyframes.",
    parameters: {
      type: "object" as const,
      properties: { clipId: { type: "string" } },
      required: ["clipId"],
    },
  },
  {
    name: "list_ken_burns_presets",
    description: "List built-in reframing presets for apply_ken_burns.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    name: "apply_ken_burns",
    description:
      "Animate a visual clip's non-destructive crop for a cinematic zoom or pan. Use a preset (zoom-in, zoom-out, pan-left, pan-right), or provide both custom from and to crop rectangles. Replaces only crop keyframes and preserves all other animation.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        presetId: { type: "string", description: `One of: ${listKenBurnsPresetIds().join(", ")}` },
        from: {
          type: "object",
          description: "Optional {x,y,width,height} start crop; required with to when no preset",
          properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        },
        to: {
          type: "object",
          description: "Optional {x,y,width,height} end crop; required with from when no preset",
          properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        },
      },
      required: ["clipId"],
    },
  },
];

export const cropToolExecutors: Record<
  string,
  (args: Record<string, any>, state: ProjectState) => { result: string; state: ProjectState }
> = {
  set_media_fit: (args, state) => {
    const found = findVisualClip(state, String(args.clipId));
    if (!found.ok) return { result: toolErr(found.error, { code: "MEDIA_FIT_CLIP_INVALID" }), state };
    const fit = String(args.fit);
    if (!["cover", "contain", "fill", "none"].includes(fit)) {
      return { result: toolErr("fit must be cover, contain, fill, or none", { code: "MEDIA_FIT_INVALID" }), state };
    }
    const focalX = Number(args.focalX ?? found.clip.mediaLayout?.focalPoint?.x ?? 0.5);
    const focalY = Number(args.focalY ?? found.clip.mediaLayout?.focalPoint?.y ?? 0.5);
    if (![focalX, focalY].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      return { result: toolErr("focalX and focalY must be between 0 and 1", { code: "MEDIA_FOCAL_INVALID" }), state };
    }
    found.clip.mediaLayout = {
      ...found.clip.mediaLayout,
      schemaVersion: 1,
      fit: fit as "cover" | "contain" | "fill" | "none",
      focalPoint: { x: focalX, y: focalY },
    };
    return {
      result: toolOk(`Set ${fit} fit on clip ${found.clip.id}`, {
        clipId: found.clip.id,
        fit,
        focalPoint: found.clip.mediaLayout.focalPoint,
        warning: fit === "fill" ? "Fill intentionally permits aspect distortion" : undefined,
      }),
      state,
    };
  },

  set_media_viewport: (args, state) => {
    const found = findVisualClip(state, String(args.clipId));
    if (!found.ok) return { result: toolErr(found.error, { code: "MEDIA_VIEWPORT_CLIP_INVALID" }), state };
    const validated = validateMediaViewport({
      x: args.x,
      y: args.y,
      width: args.width,
      height: args.height,
    });
    if (!validated.ok) return { result: toolErr(validated.message, { code: "MEDIA_VIEWPORT_INVALID" }), state };
    const fit = args.fit === "contain" ? "contain" : "cover";
    const focalX = Number(args.focalX ?? found.clip.mediaLayout?.focalPoint?.x ?? 0.5);
    const focalY = Number(args.focalY ?? found.clip.mediaLayout?.focalPoint?.y ?? 0.5);
    if (![focalX, focalY].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      return { result: toolErr("focalX and focalY must be between 0 and 1", { code: "MEDIA_FOCAL_INVALID" }), state };
    }
    found.clip.mediaLayout = {
      schemaVersion: 1,
      fit,
      focalPoint: { x: focalX, y: focalY },
      viewport: validated.value,
    };
    return {
      result: toolOk(`Placed clip ${found.clip.id} in a normalized viewport`, {
        clipId: found.clip.id,
        viewport: validated.value,
        fit,
      }),
      state,
    };
  },

  clear_media_viewport: (args, state) => {
    const found = findVisualClip(state, String(args.clipId));
    if (!found.ok) return { result: toolErr(found.error, { code: "MEDIA_VIEWPORT_CLIP_INVALID" }), state };
    if (found.clip.mediaLayout) {
      const { viewport: _viewport, ...layout } = found.clip.mediaLayout;
      found.clip.mediaLayout = layout;
    }
    found.clip.keyframes = found.clip.keyframes.filter(
      (keyframe) => !keyframe.property.startsWith("mediaLayout.viewport.")
    );
    return { result: toolOk(`Cleared media viewport on clip ${found.clip.id}`, { clipId: found.clip.id }), state };
  },

  set_clip_crop: (args, state) => {
    const found = findVisualClip(state, String(args.clipId));
    if (!found.ok) return { result: toolErr(found.error, { code: "CROP_CLIP_INVALID" }), state };
    const existing = found.clip.crop;
    const validated = validateCrop({
      x: args.x ?? existing?.x ?? 0,
      y: args.y ?? existing?.y ?? 0,
      width: args.width ?? existing?.width ?? 1,
      height: args.height ?? existing?.height ?? 1,
    });
    if (!validated.ok) return { result: toolErr(validated.message, { code: "CROP_INVALID" }), state };
    found.clip.crop = normalizeCrop(validated.value);
    return { result: toolOk(`Set crop on clip ${found.clip.id}`, { clipId: found.clip.id }), state };
  },

  clear_clip_crop: (args, state) => {
    const found = findVisualClip(state, String(args.clipId));
    if (!found.ok) return { result: toolErr(found.error, { code: "CROP_CLIP_INVALID" }), state };
    found.clip.crop = null;
    found.clip.keyframes = found.clip.keyframes.filter((keyframe) => !keyframe.property.startsWith("crop."));
    return { result: toolOk(`Cleared crop and crop keyframes on clip ${found.clip.id}`, { clipId: found.clip.id }), state };
  },

  list_ken_burns_presets: (_args, state) => ({
    result: JSON.stringify(listKenBurnsPresetIds()),
    state,
  }),

  apply_ken_burns: (args, state) => {
    const found = findVisualClip(state, String(args.clipId));
    if (!found.ok) return { result: toolErr(found.error, { code: "CROP_CLIP_INVALID" }), state };
    const hasCustom = args.from !== undefined || args.to !== undefined;
    if (hasCustom && (!args.from || !args.to)) {
      return { result: toolErr("Custom Ken Burns requires both from and to crop rectangles", { code: "KEN_BURNS_RANGE_REQUIRED" }), state };
    }
    const applied = applyKenBurns({
      presetId: args.presetId ? String(args.presetId) as KenBurnsPresetId : undefined,
      from: args.from,
      to: args.to,
      duration: found.clip.duration,
      keyframes: found.clip.keyframes,
      createKeyframeId: randomUUID,
    });
    if (!applied.ok) return { result: toolErr(applied.message, { code: "KEN_BURNS_INVALID" }), state };
    found.clip.crop = applied.crop;
    found.clip.keyframes = applied.keyframes;
    return {
      result: toolOk(`Applied Ken Burns to clip ${found.clip.id}`, {
        clipId: found.clip.id,
        from: applied.from,
        to: applied.to,
      }),
      state,
    };
  },
};
