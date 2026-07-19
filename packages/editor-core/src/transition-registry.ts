/**
 * Transition type registry — schemas for edit-point transitions.
 * Apply / validate live in transitions.ts; mix math in transition-mix.ts.
 */

export interface TransitionParamDefinition {
  type: "number" | "string" | "boolean";
  label: string;
  defaultValue: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** For string params: allowed values */
  enum?: string[];
}

export type TransitionMixFamily = "opacity" | "geometric";

export interface TransitionTypeDefinition {
  type: string;
  name: string;
  description: string;
  params: Record<string, TransitionParamDefinition>;
  previewBackend: "webgpu";
  exportBackend: "ffmpeg-fade" | "frame";
  /** How preview mixes A/B — opacity dissolve vs geometric wipe/push */
  mixFamily: TransitionMixFamily;
}

const DURATION_PARAM: TransitionParamDefinition = {
  type: "number",
  label: "Duration",
  defaultValue: 0.5,
  min: 0.05,
  max: 5,
  step: 0.05,
};

const DIRECTION_PARAM: TransitionParamDefinition = {
  type: "string",
  label: "Direction",
  defaultValue: "left",
  enum: ["left", "right", "up", "down"],
};

export const TRANSITION_TYPES: TransitionTypeDefinition[] = [
  {
    type: "crossfade",
    name: "Crossfade",
    description: "Opacity dissolve between outgoing and incoming clips",
    previewBackend: "webgpu",
    exportBackend: "ffmpeg-fade",
    mixFamily: "opacity",
    params: {
      duration: { ...DURATION_PARAM, defaultValue: 0.5 },
    },
  },
  {
    type: "dip-black",
    name: "Dip to Black",
    description: "Fade out to black then into the next clip",
    previewBackend: "webgpu",
    exportBackend: "ffmpeg-fade",
    mixFamily: "opacity",
    params: {
      duration: { ...DURATION_PARAM, defaultValue: 0.75 },
    },
  },
  {
    type: "wipe",
    name: "Wipe",
    description: "Soft-edged wipe revealing the incoming clip",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: {
      duration: { ...DURATION_PARAM, defaultValue: 0.5 },
      direction: { ...DIRECTION_PARAM },
      softness: {
        type: "number",
        label: "Softness",
        defaultValue: 0.08,
        min: 0,
        max: 0.5,
        step: 0.01,
      },
    },
  },
  {
    type: "push",
    name: "Push",
    description: "Incoming clip pushes the outgoing clip off-screen",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: {
      duration: { ...DURATION_PARAM, defaultValue: 0.5 },
      direction: { ...DIRECTION_PARAM },
    },
  },
  {
    type: "whip",
    name: "Whip",
    description: "Fast directional slide with motion smear",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: {
      duration: { ...DURATION_PARAM, defaultValue: 0.25 },
      direction: { ...DIRECTION_PARAM },
      blur: {
        type: "number",
        label: "Blur",
        defaultValue: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
      },
    },
  },
  {
    type: "iris",
    name: "Iris",
    description: "Circular soft reveal of the incoming clip",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: {
      duration: { ...DURATION_PARAM, defaultValue: 0.5 },
      softness: {
        type: "number",
        label: "Softness",
        defaultValue: 0.08,
        min: 0,
        max: 0.5,
        step: 0.01,
      },
      centerX: {
        type: "number",
        label: "Center X",
        defaultValue: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
      },
      centerY: {
        type: "number",
        label: "Center Y",
        defaultValue: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
      },
    },
  },
  {
    type: "zoom-smash",
    name: "Zoom Smash",
    description: "Fast zoom-through cut for high-energy beats",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.22 }, intensity: { type: "number", label: "Intensity", defaultValue: 0.7, min: 0, max: 1, step: 0.05 } },
  },
  {
    type: "spin",
    name: "Spin",
    description: "Rotating A/B transition around the frame centre",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.35 }, direction: { ...DIRECTION_PARAM, defaultValue: "right", enum: ["left", "right"] }, intensity: { type: "number", label: "Turns", defaultValue: 0.6, min: 0, max: 2, step: 0.05 } },
  },
  {
    type: "squeeze",
    name: "Squeeze",
    description: "Directional squeeze/reveal transition",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.3 }, direction: { ...DIRECTION_PARAM }, softness: { type: "number", label: "Softness", defaultValue: 0.08, min: 0, max: 0.5, step: 0.01 } },
  },
  {
    type: "peel",
    name: "Peel",
    description: "Diagonal page-peel style reveal",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.45 }, direction: { ...DIRECTION_PARAM }, softness: { type: "number", label: "Softness", defaultValue: 0.1, min: 0, max: 0.5, step: 0.01 } },
  },
  {
    type: "dip-white",
    name: "Dip to White",
    description: "Fade through white between clips",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.35 } },
  },
  {
    type: "flash",
    name: "Flash",
    description: "Brief white flash across a cut",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.14 }, intensity: { type: "number", label: "Intensity", defaultValue: 0.8, min: 0, max: 1, step: 0.05 } },
  },
  {
    type: "beat-flash",
    name: "Beat Flash",
    description: "Short high-energy flash for beat cuts",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.08 }, intensity: { type: "number", label: "Intensity", defaultValue: 1, min: 0, max: 1, step: 0.05 } },
  },
  {
    type: "glitch-transition",
    name: "Glitch",
    description: "Digital horizontal-slice transition",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.18 }, intensity: { type: "number", label: "Intensity", defaultValue: 0.7, min: 0, max: 1, step: 0.05 } },
  },
  {
    type: "light-leak-transition",
    name: "Light Leak",
    description: "Warm optical leak across a cut",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.3 }, intensity: { type: "number", label: "Intensity", defaultValue: 0.7, min: 0, max: 1, step: 0.05 } },
  },
  {
    type: "film-burn-transition",
    name: "Film Burn",
    description: "Warm burn-through transition",
    previewBackend: "webgpu",
    exportBackend: "frame",
    mixFamily: "geometric",
    params: { duration: { ...DURATION_PARAM, defaultValue: 0.35 }, intensity: { type: "number", label: "Intensity", defaultValue: 0.75, min: 0, max: 1, step: 0.05 } },
  },
];

export function listTransitionTypes(): TransitionTypeDefinition[] {
  return TRANSITION_TYPES;
}

export function listTransitionTypeIds(): string[] {
  return TRANSITION_TYPES.map((t) => t.type);
}

export function getTransitionType(type: string): TransitionTypeDefinition | undefined {
  return TRANSITION_TYPES.find((t) => t.type === type);
}

/** Default params for a transition type (excluding duration applied at edit-point). */
export function defaultTransitionParams(
  type: string
): Record<string, number | string | boolean> {
  const def = getTransitionType(type);
  if (!def) return {};
  const out: Record<string, number | string | boolean> = {};
  for (const [key, p] of Object.entries(def.params)) {
    if (key === "duration") continue;
    out[key] = p.defaultValue;
  }
  return out;
}
