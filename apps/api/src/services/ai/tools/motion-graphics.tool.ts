import type {
  Clip,
  GradientFill,
  LayerGlow,
  LayerShadow,
  RichTextRun,
  ShapeParams,
  ShapeType,
  TextParams,
  VectorPathPoint,
} from "@tempo/types";
import { randomUUID } from "crypto";
import {
  applyTextAnimatorPreset,
  listTextAnimatorPresetIds,
  TEXT_ANIMATOR_PRESETS,
  validateAnimators,
  normalizeSplit,
  getTextAnimatorPreset,
  resolveTextFont,
  listTitleTemplates,
  getTitleTemplate,
  applyTitleTemplateToTextParams,
  toolOk,
  toolErr,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";
import { loadProjectFonts } from "./fonts.tool.js";
import { getGoogleFontCatalog } from "../../google-fonts.service.js";

const DEFAULT_TRANSFORM = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0,
  anchorY: 0,
};

const SHAPE_TYPES = new Set<ShapeType>([
  "rect",
  "ellipse",
  "triangle",
  "polygon",
  "star",
  "line",
  "path",
]);
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;

function isPaint(value: unknown, allowTransparent = false): value is string {
  return typeof value === "string" && (
    HEX_COLOR.test(value)
    || (allowTransparent && value.toLowerCase() === "transparent")
  );
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validateGradient(value: unknown): value is GradientFill {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const gradient = value as Partial<GradientFill>;
  return (gradient.type === "linear" || gradient.type === "radial")
    && isPaint(gradient.from)
    && isPaint(gradient.to)
    && (gradient.angle === undefined || finiteInRange(gradient.angle, -360_000, 360_000));
}

function validateShadow(value: unknown): value is LayerShadow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const shadow = value as Partial<LayerShadow>;
  return isPaint(shadow.color, true)
    && finiteInRange(shadow.offsetX, -100_000, 100_000)
    && finiteInRange(shadow.offsetY, -100_000, 100_000)
    && finiteInRange(shadow.blur, 0, 10_000)
    && (shadow.opacity === undefined || finiteInRange(shadow.opacity, 0, 1));
}

function validateGlow(value: unknown): value is LayerGlow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const glow = value as Partial<LayerGlow>;
  return isPaint(glow.color, true)
    && finiteInRange(glow.blur, 0, 10_000)
    && (glow.opacity === undefined || finiteInRange(glow.opacity, 0, 1));
}

type ShapePatchResult =
  | { ok: true; patch: Partial<ShapeParams> }
  | { ok: false; message: string };

function validateShapePatch(args: Record<string, unknown>, requireShape: boolean): ShapePatchResult {
  const patch: Partial<ShapeParams> = {};
  if (args.shape === undefined) {
    if (requireShape) return { ok: false, message: "shape is required" };
  } else if (typeof args.shape !== "string" || !SHAPE_TYPES.has(args.shape as ShapeType)) {
    return { ok: false, message: "shape must be rect, ellipse, triangle, polygon, star, line, or path" };
  } else {
    patch.shape = args.shape as ShapeType;
  }

  for (const key of ["fill", "stroke"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (!isPaint(value, key === "stroke")) {
      return { ok: false, message: `${key} must be a hex color${key === "stroke" ? " or transparent" : ""}` };
    }
    patch[key] = value;
  }

  const numericRules = {
    strokeWidth: [0, 10_000],
    width: [0.01, 100_000],
    height: [0.01, 100_000],
    cornerRadius: [0, 100_000],
    innerRadius: [0, 1],
  } as const;
  for (const [key, [min, max]] of Object.entries(numericRules) as [keyof typeof numericRules, readonly [number, number]][]) {
    const value = args[key];
    if (value === undefined) continue;
    if (!finiteInRange(value, min, max)) {
      return { ok: false, message: `${key} must be a finite number from ${min} to ${max}` };
    }
    patch[key] = value;
  }

  if (args.points !== undefined) {
    if (!finiteInRange(args.points, 3, 100) || !Number.isInteger(args.points)) {
      return { ok: false, message: "points must be an integer from 3 to 100" };
    }
    patch.points = args.points;
  }
  if (args.pathPoints !== undefined) {
    if (
      !Array.isArray(args.pathPoints) || args.pathPoints.length < 2 || args.pathPoints.length > 512 ||
      !args.pathPoints.every((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const point = candidate as Record<string, unknown>;
        if (!finiteInRange(point.x, 0, 1) || !finiteInRange(point.y, 0, 1)) return false;
        for (const key of ["inX", "inY", "outX", "outY"] as const) {
          if (point[key] !== undefined && !finiteInRange(point[key], -4, 5)) return false;
        }
        const hasIn = point.inX !== undefined || point.inY !== undefined;
        const hasOut = point.outX !== undefined || point.outY !== undefined;
        return (!hasIn || (point.inX !== undefined && point.inY !== undefined)) &&
          (!hasOut || (point.outX !== undefined && point.outY !== undefined));
      })
    ) {
      return { ok: false, message: "pathPoints must contain 2..512 normalized {x,y} vertices with optional paired inX/inY and outX/outY cubic handles" };
    }
    patch.pathPoints = args.pathPoints.map((point) => ({ ...(point as VectorPathPoint) }));
  }
  if (args.pathClosed !== undefined) {
    if (typeof args.pathClosed !== "boolean") return { ok: false, message: "pathClosed must be a boolean" };
    patch.pathClosed = args.pathClosed;
  }
  const resolvedShape = patch.shape ?? (args.shape as ShapeType | undefined);
  if (resolvedShape === "path" && requireShape && !patch.pathPoints) {
    return { ok: false, message: "path shapes require pathPoints" };
  }
  if (args.fillGradient !== undefined) {
    if (!validateGradient(args.fillGradient)) {
      return { ok: false, message: "fillGradient must contain type linear|radial, valid hex from/to colors, and an optional finite angle" };
    }
    patch.fillGradient = { ...args.fillGradient };
  }
  if (args.shadow !== undefined) {
    if (!validateShadow(args.shadow)) {
      return { ok: false, message: "shadow must contain a valid color, finite offsetX/offsetY, non-negative blur, and optional opacity from 0 to 1" };
    }
    patch.shadow = { ...args.shadow };
  }
  if (args.glow !== undefined) {
    if (!validateGlow(args.glow)) {
      return { ok: false, message: "glow must contain a valid color, non-negative blur, and optional opacity from 0 to 1" };
    }
    patch.glow = { ...args.glow };
  }
  return { ok: true, patch };
}

type TextPatchResult =
  | { ok: true; patch: Partial<TextParams> }
  | { ok: false; message: string };

function validateRichTextRuns(value: unknown): value is RichTextRun[] {
  if (!Array.isArray(value) || value.length > 500) return false;
  return value.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const run = candidate as Partial<RichTextRun>;
    return typeof run.text === "string"
      && run.text.length <= 100_000
      && (run.color === undefined || isPaint(run.color))
      && (run.fontFamily === undefined || (typeof run.fontFamily === "string" && run.fontFamily.trim().length > 0 && run.fontFamily.length <= 500))
      && (run.fontId === undefined || (typeof run.fontId === "string" && run.fontId.length <= 500))
      && (run.fontSize === undefined || finiteInRange(run.fontSize, 0.01, 10_000))
      && (run.fontWeight === undefined || (typeof run.fontWeight === "string" && run.fontWeight.length <= 100))
      && (run.italic === undefined || typeof run.italic === "boolean")
      && (run.underline === undefined || typeof run.underline === "boolean")
      && (run.letterSpacing === undefined || finiteInRange(run.letterSpacing, -10_000, 10_000));
  });
}

function validateTextPatch(args: Record<string, unknown>, requireText: boolean): TextPatchResult {
  const patch: Partial<TextParams> = {};
  if (args.text === undefined) {
    if (requireText) return { ok: false, message: "text is required" };
  } else if (typeof args.text !== "string" || args.text.length > 100_000) {
    return { ok: false, message: "text must be a string no longer than 100000 characters" };
  } else {
    patch.text = args.text;
  }

  const strings = ["fontFamily", "fontWeight", "shadow"] as const;
  for (const key of strings) {
    const value = args[key];
    if (value === undefined) continue;
    const limit = key === "shadow" ? 1_000 : 500;
    if (typeof value !== "string" || !value.trim() || value.length > limit) {
      return { ok: false, message: `${key} must be a non-empty string no longer than ${limit} characters` };
    }
    patch[key] = value;
  }
  for (const key of ["color", "stroke", "backgroundColor"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (!isPaint(value, key !== "color")) {
      return { ok: false, message: `${key} must be a hex color${key !== "color" ? " or transparent" : ""}` };
    }
    patch[key] = value;
  }
  const numericRules = {
    fontSize: [0.01, 10_000],
    lineHeight: [0.01, 100],
    strokeWidth: [0, 10_000],
    letterSpacing: [-10_000, 10_000],
  } as const;
  for (const [key, [min, max]] of Object.entries(numericRules) as [keyof typeof numericRules, readonly [number, number]][]) {
    const value = args[key];
    if (value === undefined) continue;
    if (!finiteInRange(value, min, max)) {
      return { ok: false, message: `${key} must be a finite number from ${min} to ${max}` };
    }
    patch[key] = value;
  }
  if (args.textAlign !== undefined) {
    if (args.textAlign !== "left" && args.textAlign !== "center" && args.textAlign !== "right") {
      return { ok: false, message: "textAlign must be left, center, or right" };
    }
    patch.textAlign = args.textAlign;
  }
  if (args.richTextRuns !== undefined) {
    if (!validateRichTextRuns(args.richTextRuns)) return { ok: false, message: "richTextRuns contains an invalid styled span" };
    patch.richTextRuns = args.richTextRuns.map((run) => ({ ...run }));
  }
  if (args.fillGradient !== undefined) {
    if (!validateGradient(args.fillGradient)) return { ok: false, message: "fillGradient is invalid" };
    patch.fillGradient = { ...args.fillGradient };
  }
  if (args.fillEnabled !== undefined) {
    if (typeof args.fillEnabled !== "boolean") return { ok: false, message: "fillEnabled must be a boolean" };
    patch.fillEnabled = args.fillEnabled;
  }
  if (args.shadowStyle !== undefined) {
    if (!validateShadow(args.shadowStyle)) return { ok: false, message: "shadowStyle is invalid" };
    patch.shadowStyle = { ...args.shadowStyle };
  }
  if (args.glow !== undefined) {
    if (!validateGlow(args.glow)) return { ok: false, message: "glow is invalid" };
    patch.glow = { ...args.glow };
  }
  return { ok: true, patch };
}

export const motionGraphicsToolDefinitions = [
  {
    name: "add_text_clip",
    description:
      "Add a text overlay clip to a text track. Creates the text track automatically if trackId is not provided. Returns JSON {ok, clipId, trackId, summary} — always reuse clipId for set_text_font / update_text_clip / animators (never invent UUIDs).",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: {
          type: "string",
          description:
            "ID of a text track (optional -- if omitted, a new text track is created)",
        },
        text: { type: "string", description: "The text content to display" },
        startTime: {
          type: "number",
          description: "Start time on the timeline in seconds",
        },
        duration: { type: "number", description: "Duration in seconds" },
        fontSize: {
          type: "number",
          description: "Font size in pixels (default 48)",
        },
        fontFamily: {
          type: "string",
          description: "Font family fallback CSS (prefer fontId)",
        },
        fontId: {
          type: "string",
          description:
            "Preferred font id from list_fonts (google:Oswald or upload uuid). Sets fontId+fontFamily in one call.",
        },
        fontWeight: { type: "string", description: "Font weight (default 600)" },
        color: {
          type: "string",
          description: "Text color as hex (default '#ffffff')",
        },
        textAlign: {
          type: "string",
          enum: ["left", "center", "right"],
          description: "Text alignment (default 'center')",
        },
        lineHeight: { type: "number" },
        letterSpacing: { type: "number" },
        stroke: { type: "string" },
        strokeWidth: { type: "number" },
        backgroundColor: { type: "string" },
        shadow: {
          type: "string",
          description: "CSS text-shadow e.g. '2px 2px 4px rgba(0,0,0,0.5)'",
        },
        richTextRuns: { type: "array", description: "Ordered rich-text spans: [{text, color?, fontFamily?, fontId?, fontSize?, fontWeight?, italic?, underline?, letterSpacing?}]. Their concatenation is rendered as one deterministic graphic line." , items: { type: "object" } },
        fillGradient: { type: "object", description: "Native graphic fill: {type:'linear'|'radial', from:'#RRGGBB', to:'#RRGGBB', angle?:number}. Linear angle 0 = left to right." },
        fillEnabled: { type: "boolean", description: "False makes text outline-only (set stroke and strokeWidth too)." },
        shadowStyle: { type: "object", description: "Structured shadow: {color, offsetX, offsetY, blur, opacity?}. Preferred over legacy CSS shadow." },
        glow: { type: "object", description: "Outer glow: {color, blur, opacity?}. Use a separate glow effect for animated/intensity-controlled glow." },
      },
      required: ["text", "startTime", "duration"],
    },
  },
  {
    name: "add_shape_clip",
    description:
      "Add a shape clip to a shape track. Returns JSON {ok, clipId, trackId, summary}.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: {
          type: "string",
          description:
            "ID of a shape track (optional -- if omitted, a new shape track is created)",
        },
        shape: {
          type: "string",
          enum: ["rect", "ellipse", "triangle", "polygon", "star", "line", "path"],
          description: "Shape type",
        },
        startTime: {
          type: "number",
          description: "Start time on the timeline in seconds",
        },
        duration: { type: "number", description: "Duration in seconds" },
        fill: {
          type: "string",
          description: "Fill color as hex (default '#3b82f6')",
        },
        stroke: {
          type: "string",
          description: "Stroke color as hex (default 'transparent')",
        },
        strokeWidth: {
          type: "number",
          description: "Stroke width in pixels (default 0)",
        },
        width: {
          type: "number",
          description: "Shape width in pixels (default 200)",
        },
        height: {
          type: "number",
          description: "Shape height in pixels (default 200)",
        },
        cornerRadius: { type: "number", description: "Corner radius for rect" },
        points: {
          type: "number",
          description: "Sides (polygon) or points (star)",
        },
        innerRadius: {
          type: "number",
          description: "Inner radius ratio for star (0-1)",
        },
        pathPoints: { type: "array", description: "For shape=path: 2..512 normalized vertices [{x,y,inX?,inY?,outX?,outY?}]. Paired handles create cubic Bézier segments.", items: { type: "object" } },
        pathClosed: { type: "boolean", description: "Close/fill a vector path (default true); false creates an open stroked path" },
        fillGradient: { type: "object", description: "{type:'linear'|'radial', from:'#RRGGBB', to:'#RRGGBB', angle?:number}" },
        shadow: { type: "object", description: "{color, offsetX, offsetY, blur, opacity?}" },
        glow: { type: "object", description: "{color, blur, opacity?}" },
      },
      required: ["shape", "startTime", "duration"],
    },
  },
  {
    name: "add_lottie_clip",
    description: "Add an uploaded Lottie JSON animation as a rasterized graphic layer. Use list_media first and pass a mediaId whose metadata.graphicFormat is lottie. Preview and Chromium frame export render the same Lottie frame.",
    parameters: {
      type: "object" as const,
      properties: {
        assetId: { type: "string", description: "Uploaded Lottie JSON media asset id" },
        startTime: { type: "number" }, duration: { type: "number" }, trackId: { type: "string" },
        loop: { type: "boolean" }, speed: { type: "number", description: "Playback multiplier; default 1" },
      },
      required: ["assetId", "startTime", "duration"],
    },
  },
  {
    name: "update_text_clip",
    description:
      "Update text content or styling on an existing text clip (textParams). Prefer exact clipId from add_text_clip JSON. Supports fontId, shadow, letterSpacing, lineHeight, etc.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        text: { type: "string" },
        fontSize: { type: "number" },
        fontFamily: { type: "string" },
        fontId: {
          type: "string",
          description: "Font id from list_fonts — updates fontId + fontFamily",
        },
        fontWeight: { type: "string" },
        color: { type: "string" },
        textAlign: { type: "string", enum: ["left", "center", "right"] },
        lineHeight: { type: "number" },
        stroke: { type: "string" },
        strokeWidth: { type: "number" },
        letterSpacing: { type: "number" },
        backgroundColor: { type: "string" },
        shadow: {
          type: "string",
          description: "CSS text-shadow string",
        },
        richTextRuns: { type: "array", description: "Ordered rich-text spans: [{text, color?, fontFamily?, fontId?, fontSize?, fontWeight?, italic?, underline?, letterSpacing?}]", items: { type: "object" } },
        fillGradient: { type: "object", description: "{type:'linear'|'radial', from:'#RRGGBB', to:'#RRGGBB', angle?:number}" },
        fillEnabled: { type: "boolean" },
        shadowStyle: { type: "object", description: "{color, offsetX, offsetY, blur, opacity?}" },
        glow: { type: "object", description: "{color, blur, opacity?}" },
        clearFillGradient: { type: "boolean", description: "Remove the native fill gradient" },
        clearShadowStyle: { type: "boolean", description: "Remove the structured shadow" },
        clearGlow: { type: "boolean", description: "Remove the outer glow" },
        clearRichTextRuns: { type: "boolean", description: "Return to the plain text field" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "update_shape_clip",
    description: "Update shape type or styling on an existing shape clip (shapeParams).",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        shape: {
          type: "string",
          enum: ["rect", "ellipse", "triangle", "polygon", "star", "line", "path"],
        },
        fill: { type: "string" },
        stroke: { type: "string" },
        strokeWidth: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        cornerRadius: { type: "number" },
        points: { type: "number" },
        innerRadius: { type: "number" },
        pathPoints: { type: "array", description: "Normalized arbitrary polygon/Bézier vertices", items: { type: "object" } },
        pathClosed: { type: "boolean" },
        fillGradient: { type: "object", description: "{type:'linear'|'radial', from:'#RRGGBB', to:'#RRGGBB', angle?:number}" },
        shadow: { type: "object", description: "{color, offsetX, offsetY, blur, opacity?}" },
        glow: { type: "object", description: "{color, blur, opacity?}" },
        clearFillGradient: { type: "boolean", description: "Remove the native fill gradient" },
        clearShadow: { type: "boolean", description: "Remove the structured shadow" },
        clearGlow: { type: "boolean", description: "Remove the outer glow" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "list_text_animator_presets",
    description:
      "List kinetic text animator presets (typewriter, cascade-up, word-pop, line-fade).",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    name: "apply_text_animator_preset",
    description:
      "Apply a kinetic text animator preset to a text clip (per-char/word/line motion). Prefer over whole-clip keyframe presets for kinetic type.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        presetId: {
          type: "string",
          description: "Preset id from list_text_animator_presets",
        },
      },
      required: ["clipId", "presetId"],
    },
  },
  {
    name: "set_text_animators",
    description:
      "Set kinetic split mode and/or a raw per-unit animator stack on a text clip. Supports opacity, X/Y offset, scale, rotation, tracking, blur, and fill color. Pass animators:[] to clear.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        split: { type: "string", enum: ["none", "char", "word", "line"] },
        animators: {
          type: "array",
          description:
            "Animator objects: property (opacity|offsetX|offsetY|scale|rotation|tracking|blur|color), offsetSec, durationSec, staggerSec, from, to, ease (hold|linear|ease-in|ease-out|ease-in-out), optional range:[start,endExclusive], unitStartTimes:[seconds...] for irregular beat/impact/speech timing, and valueKeyframes:[{timeSec,value,easing}] for multi-stage per-unit curves such as hit→overshoot→hold→settle. Explicit unitStartTimes replace uniform stagger timing. Color uses fromColor/toColor and does not use numeric valueKeyframes.",
          items: { type: "object" },
        },
      },
      required: ["clipId"],
    },
  },
  {
    name: "clear_text_animators",
    description: "Clear kinetic split/animators on a text clip.",
    parameters: {
      type: "object" as const,
      properties: { clipId: { type: "string" } },
      required: ["clipId"],
    },
  },
  {
    name: "list_title_templates",
    description:
      "List title/lower-third/end-card templates (hook-title, lower-third, end-card, kinetic-hook, …). Use apply_title_template to create or restyle.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    name: "apply_title_template",
    description:
      "Apply a title template by id. If clipId is set, restyle that text clip; otherwise create a new text clip (like add_text_clip) then apply. Returns JSON {ok, clipId, trackId, templateId, summary}.",
    parameters: {
      type: "object" as const,
      properties: {
        templateId: {
          type: "string",
          description: "Template id from list_title_templates",
        },
        clipId: {
          type: "string",
          description: "Existing text clip to restyle (omit to create)",
        },
        text: {
          type: "string",
          description: "Slot text content (required when creating)",
        },
        startTime: {
          type: "number",
          description: "Required when creating — timeline start seconds",
        },
        duration: {
          type: "number",
          description:
            "Optional when creating — defaults to template suggestedDuration",
        },
        trackId: {
          type: "string",
          description: "Optional text track when creating",
        },
        fontId: {
          type: "string",
          description:
            "Optional override font after template (google:… or upload uuid)",
        },
      },
      required: ["templateId"],
    },
  },
];

function findClip(state: ProjectState, clipId: string): Clip | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

async function resolveFontArgs(
  state: ProjectState,
  fontId?: string,
  fontFamily?: string
): Promise<{ fontId?: string; fontFamily: string } | { error: string }> {
  if (fontId) {
    await loadProjectFonts(state);
    const uploads = new Map(
      (state.fontAssets || []).map((f) => [f.id, f.familyName])
    );
    const catalog = await getGoogleFontCatalog();
    const resolved = resolveTextFont(
      String(fontId),
      uploads,
      catalog.map((font) => font.familyName)
    );
    if (!resolved) {
      return {
        error: `Unknown fontId "${fontId}". Call list_fonts first.`,
      };
    }
    return { fontId: resolved.fontId, fontFamily: resolved.fontFamily };
  }
  return { fontFamily: fontFamily || "Inter, sans-serif" };
}

export const motionGraphicsToolExecutors: Record<
  string,
  (
    args: any,
    state: ProjectState
  ) =>
    | { result: string; state: ProjectState }
    | Promise<{ result: string; state: ProjectState }>
> = {
  add_text_clip: async (args, state) => {
    if (!finiteInRange(args.startTime, 0, Number.MAX_SAFE_INTEGER)) {
      return { result: toolErr("startTime must be a non-negative finite number", { code: "INVALID_TEXT" }), state };
    }
    if (!finiteInRange(args.duration, 0.001, Number.MAX_SAFE_INTEGER)) {
      return { result: toolErr("duration must be a positive finite number", { code: "INVALID_TEXT" }), state };
    }
    const validated = validateTextPatch(args, true);
    if (!validated.ok) {
      return { result: toolErr(validated.message, { code: "INVALID_TEXT" }), state };
    }
    const font = await resolveFontArgs(state, args.fontId, args.fontFamily);
    if ("error" in font) {
      return { result: toolErr(font.error, { code: "UNKNOWN_FONT" }), state };
    }
    let trackId = args.trackId;

    if (!trackId) {
      const newTrackId = randomUUID();
      const textTrackCount = state.tracks.filter((t) => t.type === "text").length;
      state.tracks.push({
        id: newTrackId,
        name: `Text ${textTrackCount + 1}`,
        type: "text",
        order: state.tracks.length,
        locked: false,
        visible: true,
        solo: false,
        clips: [],
      });
      trackId = newTrackId;
    }

    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) {
      return {
        result: toolErr(`Track ${trackId} not found`, { code: "TRACK_NOT_FOUND" }),
        state,
      };
    }
    if (track.type !== "text") {
      return { result: toolErr(`Track ${trackId} is not a text track`, { code: "WRONG_TRACK_TYPE" }), state };
    }
    if (track.locked) {
      return { result: toolErr(`Track ${trackId} is locked`, { code: "TRACK_LOCKED" }), state };
    }

    const clipId = randomUUID();
    const clip: Clip = {
      id: clipId,
      trackId,
      sourceMediaId: null,
      startTime: args.startTime,
      duration: args.duration,
      sourceOffset: 0,
      speed: 1,
      transform: { ...DEFAULT_TRANSFORM },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
      textParams: {
        text: validated.patch.text!,
        fontSize: validated.patch.fontSize ?? 48,
        fontFamily: font.fontFamily,
        ...(font.fontId
          ? { fontId: font.fontId }
          : args.fontFamily
            ? {}
            : { fontId: "google:Inter" }),
        color: validated.patch.color ?? "#ffffff",
        textAlign: validated.patch.textAlign ?? "center",
        fontWeight: validated.patch.fontWeight ?? "600",
        lineHeight: validated.patch.lineHeight ?? 1.3,
        ...(validated.patch.letterSpacing !== undefined ? { letterSpacing: validated.patch.letterSpacing } : {}),
        ...(validated.patch.stroke !== undefined ? { stroke: validated.patch.stroke } : {}),
        ...(validated.patch.strokeWidth !== undefined ? { strokeWidth: validated.patch.strokeWidth } : {}),
        ...(validated.patch.backgroundColor !== undefined ? { backgroundColor: validated.patch.backgroundColor } : {}),
        ...(validated.patch.shadow !== undefined ? { shadow: validated.patch.shadow } : {}),
        ...(validated.patch.richTextRuns !== undefined ? { richTextRuns: validated.patch.richTextRuns } : {}),
        ...(validated.patch.fillGradient !== undefined ? { fillGradient: validated.patch.fillGradient } : {}),
        ...(validated.patch.fillEnabled !== undefined ? { fillEnabled: validated.patch.fillEnabled } : {}),
        ...(validated.patch.shadowStyle !== undefined ? { shadowStyle: validated.patch.shadowStyle } : {}),
        ...(validated.patch.glow !== undefined ? { glow: validated.patch.glow } : {}),
      },
    };

    track.clips.push(clip);
    return {
      result: toolOk(
        `Added text "${validated.patch.text}" at ${args.startTime}s for ${args.duration}s`,
        { clipId, trackId }
      ),
      state,
    };
  },

  add_shape_clip: (args, state) => {
    if (!finiteInRange(args.startTime, 0, Number.MAX_SAFE_INTEGER)) {
      return { result: toolErr("startTime must be a non-negative finite number", { code: "INVALID_SHAPE" }), state };
    }
    if (!finiteInRange(args.duration, 0.001, Number.MAX_SAFE_INTEGER)) {
      return { result: toolErr("duration must be a positive finite number", { code: "INVALID_SHAPE" }), state };
    }
    const validated = validateShapePatch(args, true);
    if (!validated.ok) {
      return { result: toolErr(validated.message, { code: "INVALID_SHAPE" }), state };
    }
    let trackId = args.trackId;

    if (!trackId) {
      const newTrackId = randomUUID();
      const shapeTrackCount = state.tracks.filter(
        (t) => t.type === "shape"
      ).length;
      state.tracks.push({
        id: newTrackId,
        name: `Shape ${shapeTrackCount + 1}`,
        type: "shape",
        order: state.tracks.length,
        locked: false,
        visible: true,
        solo: false,
        clips: [],
      });
      trackId = newTrackId;
    }

    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) {
      return {
        result: toolErr(`Track ${trackId} not found`, { code: "TRACK_NOT_FOUND" }),
        state,
      };
    }
    if (track.type !== "shape") {
      return { result: toolErr(`Track ${trackId} is not a shape track`, { code: "WRONG_TRACK_TYPE" }), state };
    }
    if (track.locked) {
      return { result: toolErr(`Track ${trackId} is locked`, { code: "TRACK_LOCKED" }), state };
    }

    const clipId = randomUUID();
    const clip: Clip = {
      id: clipId,
      trackId,
      sourceMediaId: null,
      startTime: args.startTime,
      duration: args.duration,
      sourceOffset: 0,
      speed: 1,
      transform: { ...DEFAULT_TRANSFORM },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
      shapeParams: {
        shape: validated.patch.shape!,
        fill: validated.patch.fill ?? "#3b82f6",
        stroke: validated.patch.stroke ?? "transparent",
        strokeWidth: validated.patch.strokeWidth ?? 0,
        width: validated.patch.width ?? 200,
        height: validated.patch.height ?? 200,
        ...(validated.patch.cornerRadius !== undefined ? { cornerRadius: validated.patch.cornerRadius } : {}),
        ...(validated.patch.points !== undefined ? { points: validated.patch.points } : {}),
        ...(validated.patch.innerRadius !== undefined ? { innerRadius: validated.patch.innerRadius } : {}),
        ...(validated.patch.pathPoints ? { pathPoints: validated.patch.pathPoints } : {}),
        ...(validated.patch.pathClosed !== undefined ? { pathClosed: validated.patch.pathClosed } : {}),
        ...(validated.patch.fillGradient ? { fillGradient: validated.patch.fillGradient } : {}),
        ...(validated.patch.shadow ? { shadow: validated.patch.shadow } : {}),
        ...(validated.patch.glow ? { glow: validated.patch.glow } : {}),
      },
    };

    track.clips.push(clip);
    return {
      result: toolOk(
        `Added ${args.shape} shape at ${args.startTime}s for ${args.duration}s`,
        { clipId, trackId }
      ),
      state,
    };
  },

  add_lottie_clip: (args, state) => {
    const asset = state.mediaAssets?.find((item) => item.id === args.assetId);
    if (!asset || (asset.metadata as any)?.graphicFormat !== "lottie") {
      return { result: toolErr("Lottie asset not found. Upload a .json Lottie file, then use its exact media id.", { code: "LOTTIE_ASSET_NOT_FOUND" }), state };
    }
    if (!finiteInRange(args.startTime, 0, Number.MAX_SAFE_INTEGER) || !finiteInRange(args.duration, 0.001, Number.MAX_SAFE_INTEGER)) {
      return { result: toolErr("startTime must be non-negative and duration must be positive", { code: "INVALID_LOTTIE" }), state };
    }
    if (args.speed !== undefined && !finiteInRange(args.speed, 0.01, 10_000)) {
      return { result: toolErr("speed must be a finite number of at least 0.01", { code: "INVALID_LOTTIE" }), state };
    }
    if (args.loop !== undefined && typeof args.loop !== "boolean") {
      return { result: toolErr("loop must be a boolean", { code: "INVALID_LOTTIE" }), state };
    }
    let trackId = args.trackId;
    if (!trackId) {
      const track = { id: randomUUID(), name: "Lottie Graphics", type: "shape" as const, order: state.tracks.length, locked: false, visible: true, solo: false, clips: [] as Clip[] };
      state.tracks.push(track);
      trackId = track.id;
    }
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return { result: toolErr(`Track ${trackId} not found`, { code: "TRACK_NOT_FOUND" }), state };
    if (track.type !== "shape") return { result: toolErr(`Track ${trackId} is not a shape track`, { code: "WRONG_TRACK_TYPE" }), state };
    if (track.locked) return { result: toolErr(`Track ${trackId} is locked`, { code: "TRACK_LOCKED" }), state };
    const clipId = randomUUID();
    track.clips.push({
      id: clipId, trackId, sourceMediaId: null, startTime: args.startTime, duration: args.duration, sourceOffset: 0, speed: 1,
      transform: { ...DEFAULT_TRANSFORM }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: true, volume: 0,
      lottieParams: { assetId: asset.id, loop: args.loop ?? true, speed: args.speed ?? 1 },
    });
    return { result: toolOk(`Added Lottie graphic ${asset.name}`, { clipId, trackId }), state };
  },

  update_text_clip: async (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) {
      return {
        result: toolErr(`Clip ${args.clipId} not found`, {
          code: "CLIP_NOT_FOUND",
          fixHint:
            "Use exact clipId from add_text_clip JSON (ok.clipId) or inspect_timeline — never invent UUIDs.",
        }),
        state,
      };
    }
    if (!clip.textParams) {
      return {
        result: toolErr(`Clip ${args.clipId} is not a text clip`, {
          code: "NOT_TEXT_CLIP",
        }),
        state,
      };
    }
    const validated = validateTextPatch(args, false);
    if (!validated.ok) {
      return { result: toolErr(validated.message, { code: "INVALID_TEXT" }), state };
    }
    let resolvedFont: { fontId?: string; fontFamily: string } | null = null;
    const clearTextKeys = ["clearFillGradient", "clearShadowStyle", "clearGlow", "clearRichTextRuns"] as const;
    for (const key of clearTextKeys) {
      if (args[key] !== undefined && typeof args[key] !== "boolean") {
        return { result: toolErr(`${key} must be a boolean`, { code: "INVALID_TEXT" }), state };
      }
    }
    if (args.fontId !== undefined) {
      const font = await resolveFontArgs(state, args.fontId);
      if ("error" in font) {
        return { result: toolErr(font.error, { code: "UNKNOWN_FONT" }), state };
      }
      resolvedFont = font;
    }
    const updated = Object.keys(validated.patch);
    const clears = clearTextKeys.filter((key) => args[key] === true);
    if (updated.length === 0 && clears.length === 0) {
      if (!resolvedFont) {
      return {
        result: toolErr("No text properties provided to update", {
          code: "NO_PARAMS",
        }),
        state,
      };
      }
    }
    Object.assign(clip.textParams, validated.patch);
    if (args.clearFillGradient === true) delete clip.textParams.fillGradient;
    if (args.clearShadowStyle === true) delete clip.textParams.shadowStyle;
    if (args.clearGlow === true) delete clip.textParams.glow;
    if (args.clearRichTextRuns === true) delete clip.textParams.richTextRuns;
    updated.push(...clears);
    if (resolvedFont) {
      if (resolvedFont.fontId) clip.textParams.fontId = resolvedFont.fontId;
      clip.textParams.fontFamily = resolvedFont.fontFamily;
      updated.push("fontId");
    }
    return {
      result: toolOk(`Updated text clip (${updated.join(", ")})`, {
        clipId: clip.id,
        trackId: clip.trackId,
      }),
      state,
    };
  },

  update_shape_clip: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip) {
      return {
        result: toolErr(`Clip ${args.clipId} not found`, {
          code: "CLIP_NOT_FOUND",
          fixHint:
            "Use exact clipId from add_shape_clip JSON (ok.clipId) or inspect_timeline.",
        }),
        state,
      };
    }
    if (!clip.shapeParams) {
      return {
        result: toolErr(`Clip ${args.clipId} is not a shape clip`, {
          code: "NOT_SHAPE_CLIP",
        }),
        state,
      };
    }
    const validated = validateShapePatch(args, false);
    if (!validated.ok) {
      return { result: toolErr(validated.message, { code: "INVALID_SHAPE" }), state };
    }
    const clearShapeKeys = ["clearFillGradient", "clearShadow", "clearGlow"] as const;
    for (const key of clearShapeKeys) {
      if (args[key] !== undefined && typeof args[key] !== "boolean") {
        return { result: toolErr(`${key} must be a boolean`, { code: "INVALID_SHAPE" }), state };
      }
    }
    const updated = Object.keys(validated.patch);
    const clears = clearShapeKeys.filter((key) => args[key] === true);
    if (updated.length === 0 && clears.length === 0) {
      return {
        result: toolErr("No shape properties provided to update", {
          code: "NO_PARAMS",
        }),
        state,
      };
    }
    Object.assign(clip.shapeParams, validated.patch);
    if (args.clearFillGradient === true) delete clip.shapeParams.fillGradient;
    if (args.clearShadow === true) delete clip.shapeParams.shadow;
    if (args.clearGlow === true) delete clip.shapeParams.glow;
    updated.push(...clears);
    return {
      result: toolOk(`Updated shape clip (${updated.join(", ")})`, {
        clipId: clip.id,
        trackId: clip.trackId,
      }),
      state,
    };
  },

  list_text_animator_presets: (_args, state) => {
    const list = TEXT_ANIMATOR_PRESETS.map(
      (p) => `- ${p.id}: ${p.name} (${p.split})`
    ).join("\n");
    return {
      result: `Kinetic presets:\n${list}\nids: ${listTextAnimatorPresetIds().join(", ")}`,
      state,
    };
  },

  apply_text_animator_preset: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip?.textParams) {
      return {
        result: toolErr(`text clip ${args.clipId} not found`, {
          code: "CLIP_NOT_FOUND",
        }),
        state,
      };
    }
    const preset = getTextAnimatorPreset(String(args.presetId));
    if (!preset) {
      return {
        result: toolErr(
          `unknown preset "${args.presetId}". Use list_text_animator_presets.`,
          { code: "UNKNOWN_PRESET" }
        ),
        state,
      };
    }
    clip.textParams = applyTextAnimatorPreset(
      clip.textParams,
      String(args.presetId),
      clip.duration
    );
    return {
      result: toolOk(`Applied kinetic preset ${args.presetId}`, {
        clipId: clip.id,
        trackId: clip.trackId,
      }),
      state,
    };
  },

  set_text_animators: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip?.textParams) {
      return {
        result: toolErr(`text clip ${args.clipId} not found`, {
          code: "CLIP_NOT_FOUND",
        }),
        state,
      };
    }
    if (args.split === undefined && args.animators === undefined) {
      return { result: toolErr("Provide split and/or animators", { code: "NO_PARAMS" }), state };
    }
    if (args.split !== undefined && !["none", "char", "word", "line"].includes(args.split)) {
      return { result: toolErr("split must be none, char, word, or line", { code: "INVALID_ANIMATORS" }), state };
    }
    let nextAnimators = null;
    if (args.animators !== undefined) {
      const validated = validateAnimators(args.animators);
      if (!validated.ok) {
        return {
          result: toolErr(validated.message || "Invalid animators", {
            code: "INVALID_ANIMATORS",
          }),
          state,
        };
      }
      nextAnimators = validated.value;
    }
    if (args.split !== undefined) clip.textParams.split = normalizeSplit(args.split);
    if (nextAnimators) clip.textParams.animators = nextAnimators;
    return {
      result: toolOk("Updated kinetic animators", {
        clipId: clip.id,
        trackId: clip.trackId,
      }),
      state,
    };
  },

  clear_text_animators: (args, state) => {
    const clip = findClip(state, args.clipId);
    if (!clip?.textParams) {
      return {
        result: toolErr(`text clip ${args.clipId} not found`, {
          code: "CLIP_NOT_FOUND",
        }),
        state,
      };
    }
    clip.textParams.split = "none";
    clip.textParams.animators = [];
    return {
      result: toolOk("Cleared kinetic animators", {
        clipId: clip.id,
        trackId: clip.trackId,
      }),
      state,
    };
  },

  list_title_templates: (_args, state) => {
    const list = listTitleTemplates()
      .map((t) => {
        const kinetic = t.kineticPresetId
          ? `, kinetic=${t.kineticPresetId}`
          : "";
        return `- ${t.id}: ${t.name} (${t.role}, ~${t.suggestedDuration}s${kinetic})`;
      })
      .join("\n");
    return {
      result: `Title templates:\n${list}`,
      state,
    };
  },

  apply_title_template: async (args, state) => {
    const templateId = String(args.templateId || "");
    const template = getTitleTemplate(templateId);
    if (!template) {
      return {
        result: toolErr(
          `Unknown template "${templateId}". Call list_title_templates.`,
          { code: "UNKNOWN_TEMPLATE" }
        ),
        state,
      };
    }

    let clip = args.clipId ? findClip(state, String(args.clipId)) : null;

    if (args.clipId && !clip?.textParams) {
      return {
        result: toolErr(`Text clip ${args.clipId} not found`, {
          code: "CLIP_NOT_FOUND",
          fixHint:
            "Use exact clipId from add_text_clip / apply_title_template JSON, or omit clipId to create.",
        }),
        state,
      };
    }

    if (!clip) {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) {
        return {
          result: toolErr("text is required when creating a new title clip", {
            code: "MISSING_TEXT",
          }),
          state,
        };
      }
      if (args.startTime === undefined || args.startTime === null) {
        return {
          result: toolErr(
            "startTime is required when creating a new title clip",
            { code: "MISSING_START" }
          ),
          state,
        };
      }

      const startTime = finiteInRange(args.startTime, 0, Number.MAX_SAFE_INTEGER) ? args.startTime : null;
      const duration = args.duration === undefined || args.duration === null
        ? template.suggestedDuration
        : finiteInRange(args.duration, 0.001, Number.MAX_SAFE_INTEGER) ? args.duration : null;
      if (startTime === null || duration === null) {
        return { result: toolErr("startTime must be non-negative and duration must be positive", { code: "INVALID_TITLE" }), state };
      }

      const fontFromTemplate = template.textParams.fontId;
      const font = await resolveFontArgs(
        state,
        args.fontId ? String(args.fontId) : fontFromTemplate,
        template.textParams.fontFamily
      );
      if ("error" in font) {
        return { result: toolErr(font.error, { code: "UNKNOWN_FONT" }), state };
      }

      let trackId = args.trackId as string | undefined;
      if (!trackId) {
        const newTrackId = randomUUID();
        const textTrackCount = state.tracks.filter(
          (t) => t.type === "text"
        ).length;
        state.tracks.push({
          id: newTrackId,
          name: `Text ${textTrackCount + 1}`,
          type: "text",
          order: state.tracks.length,
          locked: false,
          visible: true,
          solo: false,
          clips: [],
        });
        trackId = newTrackId;
      }

      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) {
        return {
          result: toolErr(`Track ${trackId} not found`, {
            code: "TRACK_NOT_FOUND",
          }),
          state,
        };
      }
      if (track.type !== "text") return { result: toolErr(`Track ${trackId} is not a text track`, { code: "WRONG_TRACK_TYPE" }), state };
      if (track.locked) return { result: toolErr(`Track ${trackId} is locked`, { code: "TRACK_LOCKED" }), state };

      const clipId = randomUUID();
      const baseParams: TextParams = {
        text,
        fontSize: template.textParams.fontSize ?? 48,
        fontFamily: font.fontFamily,
        ...(font.fontId ? { fontId: font.fontId } : { fontId: "google:Inter" }),
        color: template.textParams.color ?? "#ffffff",
        textAlign: template.textParams.textAlign ?? "center",
        fontWeight: template.textParams.fontWeight ?? "600",
        lineHeight: template.textParams.lineHeight ?? 1.3,
      };
      const merged = applyTitleTemplateToTextParams(
        baseParams,
        templateId,
        text
      );
      if (!merged) {
        return {
          result: toolErr(`Failed to apply template ${templateId}`, {
            code: "APPLY_FAILED",
          }),
          state,
        };
      }
      if (args.fontId) {
        merged.fontId = font.fontId;
        merged.fontFamily = font.fontFamily;
      }

      clip = {
        id: clipId,
        trackId,
        sourceMediaId: null,
        startTime,
        duration,
        sourceOffset: 0,
        speed: 1,
        transform: { ...DEFAULT_TRANSFORM },
        opacity: 1,
        blendMode: "normal",
        effects: [],
        keyframes: [],
        mask: null,
        muted: false,
        volume: 1,
        textParams: merged,
      };
      track.clips.push(clip);
    } else {
      const next = applyTitleTemplateToTextParams(
        clip.textParams!,
        templateId,
        args.text !== undefined ? String(args.text) : undefined
      );
      if (!next) {
        return {
          result: toolErr(`Failed to apply template ${templateId}`, {
            code: "APPLY_FAILED",
          }),
          state,
        };
      }
      clip.textParams = next;
      if (args.fontId) {
        const font = await resolveFontArgs(state, String(args.fontId));
        if ("error" in font) {
          return {
            result: toolErr(font.error, { code: "UNKNOWN_FONT" }),
            state,
          };
        }
        if (font.fontId) clip.textParams.fontId = font.fontId;
        clip.textParams.fontFamily = font.fontFamily;
      }
    }

    if (template.kineticPresetId && clip.textParams) {
      clip.textParams = applyTextAnimatorPreset(
        clip.textParams,
        template.kineticPresetId,
        clip.duration
      );
    }

    return {
      result: toolOk(
        `Applied title template ${templateId} (${template.name})`,
        {
          clipId: clip.id,
          trackId: clip.trackId,
          templateId,
        }
      ),
      state,
    };
  },
};
