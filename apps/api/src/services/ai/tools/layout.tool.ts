import type {
  Clip,
  GraphicLayout,
  GraphicLayoutZone,
  GraphicOverflowPolicy,
  GraphicSafetyTarget,
} from "@tempo/types";
import {
  estimateTextBounds,
  layoutZoneRect,
  resolveDeliveryProfile,
  resolveGraphicGeometry,
  toolErr,
  toolOk,
  validateGraphicGeometry,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";

const FALLBACK_SETTINGS = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 0,
  backgroundColor: "#000000",
  sampleRate: 44100,
};

function deliveryProfile(state: ProjectState) {
  return resolveDeliveryProfile(state.settings ?? FALLBACK_SETTINGS);
}

const SAFETY = new Set<GraphicSafetyTarget>(["none", "action", "title", "caption"]);
const OVERFLOW = new Set<GraphicOverflowPolicy>(["allow", "warn", "clamp", "reject"]);
const ZONES = new Set<GraphicLayoutZone>([
  "full", "action-safe", "title-safe", "top", "center", "lower-third", "caption",
]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function findGraphic(state: ProjectState, id: string): Clip | null {
  return state.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === id && Boolean(clip.textParams || clip.shapeParams)) ?? null;
}

function intrinsicBounds(clip: Clip): { width: number; height: number } {
  if (clip.textParams) return estimateTextBounds(clip.textParams);
  if (clip.shapeParams) {
    return { width: clip.shapeParams.width, height: clip.shapeParams.height };
  }
  return { width: 512, height: 512 };
}

function parseLayout(args: Record<string, unknown>): GraphicLayout | string {
  const mode = args.mode;
  const safety = args.safety ?? "title";
  const overflow = args.overflow ?? "warn";
  if (!SAFETY.has(safety as GraphicSafetyTarget)) return "safety must be none, action, title, or caption";
  if (!OVERFLOW.has(overflow as GraphicOverflowPolicy)) return "overflow must be allow, warn, clamp, or reject";
  const common = {
    schemaVersion: 1 as const,
    safety: safety as GraphicSafetyTarget,
    overflow: overflow as GraphicOverflowPolicy,
    source: "agent" as const,
  };

  if (mode === "absolute" || mode === "normalized") {
    if (!finite(args.x) || !finite(args.y)) return `${mode} layout requires finite x and y center coordinates`;
    if (args.width !== undefined && (!finite(args.width) || args.width <= 0)) return "width must be a positive finite number";
    if (args.height !== undefined && (!finite(args.height) || args.height <= 0)) return "height must be a positive finite number";
    return {
      ...common,
      mode,
      x: args.x,
      y: args.y,
      width: args.width as number | undefined,
      height: args.height as number | undefined,
    };
  }

  if (mode === "zone") {
    if (!ZONES.has(args.zone as GraphicLayoutZone)) return "zone layout requires a valid zone";
    const alignX = args.alignX ?? "center";
    const alignY = args.alignY ?? "center";
    if (!["start", "center", "end"].includes(String(alignX))) return "alignX must be start, center, or end";
    if (!["start", "center", "end"].includes(String(alignY))) return "alignY must be start, center, or end";
    for (const key of ["offsetX", "offsetY", "widthRatio", "heightRatio"] as const) {
      if (args[key] !== undefined && !finite(args[key])) return `${key} must be finite`;
    }
    if (finite(args.widthRatio) && args.widthRatio <= 0) return "widthRatio must be positive";
    if (finite(args.heightRatio) && args.heightRatio <= 0) return "heightRatio must be positive";
    return {
      ...common,
      mode: "zone",
      zone: args.zone as GraphicLayoutZone,
      alignX: alignX as "start" | "center" | "end",
      alignY: alignY as "start" | "center" | "end",
      offsetX: args.offsetX as number | undefined,
      offsetY: args.offsetY as number | undefined,
      widthRatio: args.widthRatio as number | undefined,
      heightRatio: args.heightRatio as number | undefined,
    };
  }
  return "mode must be absolute, normalized, or zone";
}

const LAYOUT_PROPERTIES = {
  clipId: { type: "string", description: "Exact id of a text or shape clip" },
  mode: { type: "string", enum: ["absolute", "normalized", "zone"] },
  x: { type: "number", description: "Center X: composition pixels in absolute mode, 0..1 composition ratio in normalized mode" },
  y: { type: "number", description: "Center Y: composition pixels in absolute mode, 0..1 composition ratio in normalized mode" },
  width: { type: "number", description: "Width: pixels in absolute mode, composition ratio in normalized mode" },
  height: { type: "number", description: "Height: pixels in absolute mode, composition ratio in normalized mode" },
  zone: { type: "string", enum: [...ZONES] },
  alignX: { type: "string", enum: ["start", "center", "end"] },
  alignY: { type: "string", enum: ["start", "center", "end"] },
  offsetX: { type: "number", description: "Horizontal offset as a fraction of the semantic zone" },
  offsetY: { type: "number", description: "Vertical offset as a fraction of the semantic zone" },
  widthRatio: { type: "number", description: "Graphic width as a fraction of the semantic zone" },
  heightRatio: { type: "number", description: "Graphic height as a fraction of the semantic zone" },
  safety: { type: "string", enum: [...SAFETY], description: "Boundary used for validation" },
  overflow: { type: "string", enum: [...OVERFLOW], description: "allow/warn preserve intent; clamp resolves inside safe area; reject refuses unsafe geometry" },
};

export const layoutToolDefinitions = [
  {
    name: "inspect_composition_layout",
    description: "Inspect the exact composition dimensions, orientation, frozen delivery profile, safe areas, platform UI occlusion zones, and semantic layout zones before placing graphics.",
    parameters: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "set_graphic_layout",
    description: "Set deterministic base geometry for a text or shape clip. Use absolute composition pixels for exact reference replication, normalized coordinates for resolution-independent precision, or semantic zones for adaptive art direction. x/y are the graphic center. Transform remains an independent animation delta.",
    parameters: {
      type: "object" as const,
      properties: LAYOUT_PROPERTIES,
      required: ["clipId", "mode"],
    },
  },
  {
    name: "validate_graphic_layout",
    description: "Measure and validate one or all graphic layers against composition bounds, selected safety boundaries, and platform UI occlusion zones. Call after positioning graphics and before claiming the design is complete.",
    parameters: {
      type: "object" as const,
      properties: { clipId: { type: "string", description: "Optional; omit to validate every laid-out graphic" } },
      required: [],
    },
  },
];

export const layoutToolExecutors: Record<
  string,
  (args: Record<string, any>, state: ProjectState) => { result: string; state: ProjectState }
> = {
  inspect_composition_layout: (_args, state) => {
    const profile = deliveryProfile(state);
    const zones = Object.fromEntries([...ZONES].map((zone) => [zone, layoutZoneRect(profile, zone)]));
    return {
      result: toolOk(`Composition is ${profile.width}x${profile.height} (${profile.orientation}) for ${profile.label}`, {
        profile,
        coordinateSystem: "origin top-left; absolute x/y are center pixels; normalized x/y are center ratios",
        zones,
      }),
      state,
    };
  },

  set_graphic_layout: (args, state) => {
    const clip = findGraphic(state, String(args.clipId));
    if (!clip) return { result: toolErr(`Graphic clip ${args.clipId} not found`, { code: "GRAPHIC_NOT_FOUND" }), state };
    const parsed = parseLayout(args);
    if (typeof parsed === "string") return { result: toolErr(parsed, { code: "LAYOUT_INVALID" }), state };
    const profile = deliveryProfile(state);
    const geometry = resolveGraphicGeometry(profile, parsed, intrinsicBounds(clip));
    const issues = validateGraphicGeometry(profile, parsed, geometry);
    if (parsed.overflow === "reject" && issues.some((issue) => issue.severity === "error")) {
      return { result: toolErr("Layout rejected because it violates the selected safety policy", { code: "LAYOUT_REJECTED", geometry, issues }), state };
    }
    clip.layout = parsed;
    return {
      result: toolOk(`Set ${parsed.mode} layout on graphic ${clip.id}`, { clipId: clip.id, layout: parsed, geometry, issues }),
      state,
    };
  },

  validate_graphic_layout: (args, state) => {
    const profile = deliveryProfile(state);
    const candidates = args.clipId
      ? [findGraphic(state, String(args.clipId))].filter((clip): clip is Clip => clip !== null)
      : state.tracks.flatMap((track) => track.clips).filter((clip) => Boolean(clip.layout && (clip.textParams || clip.shapeParams)));
    if (candidates.length === 0) {
      return { result: toolErr(args.clipId ? `Graphic clip ${args.clipId} not found` : "No laid-out graphics found", { code: "NO_GRAPHICS" }), state };
    }
    const graphics = candidates.map((clip) => {
      const geometry = resolveGraphicGeometry(profile, clip.layout!, intrinsicBounds(clip));
      return { clipId: clip.id, layout: clip.layout, geometry, issues: validateGraphicGeometry(profile, clip.layout!, geometry) };
    });
    const errors = graphics.reduce((count, item) => count + item.issues.filter((issue) => issue.severity === "error").length, 0);
    const warnings = graphics.reduce((count, item) => count + item.issues.filter((issue) => issue.severity === "warning").length, 0);
    return { result: toolOk(`Validated ${graphics.length} graphic(s): ${errors} error(s), ${warnings} warning(s)`, { profileId: profile.id, errors, warnings, graphics }), state };
  },
};
