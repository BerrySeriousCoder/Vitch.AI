import {
  applyStyleDnaHints,
  coverRetention,
  extractStyleDnaFromBlueprint,
  filterShots,
  rankShots,
  shotsFromAssets,
  mediaAssetOrientation,
  mediaDisplayGeometry,
  orientationFromDimensions,
} from "@tempo/editor-core";
import type { MediaAsset, MediaOrientation, StyleDNA, StyleDnaNarrativeRole } from "@tempo/types";
import type { ProjectState } from "./project-state.js";
import { embedTextForRanking } from "../../media/shot-index.service.js";

const ROLES: StyleDnaNarrativeRole[] = [
  "hook",
  "build",
  "drop",
  "outro",
  "broll",
  "cta",
];

/** Drop heavy embedding vectors before sending shot JSON to the model. */
function shotForAgent<T extends { embedding?: number[]; assetId: string }>(
  shot: T,
  assets: MediaAsset[]
): Omit<T, "embedding"> & { sourceOrientation: MediaOrientation; sourceDimensions?: string } {
  const { embedding: _e, ...rest } = shot;
  const asset = assets.find((candidate) => candidate.id === shot.assetId);
  const geometry = asset
    ? mediaDisplayGeometry(asset.metadata)
    : { orientation: "unknown" as const, width: undefined, height: undefined };
  return {
    ...rest,
    sourceOrientation: geometry.orientation,
    ...(geometry.width && geometry.height ? { sourceDimensions: `${geometry.width}x${geometry.height}` } : {}),
  };
}

function sourceAssets(state: ProjectState): MediaAsset[] {
  return (state.mediaAssets || []).filter(
    (asset) => !asset.metadata?.referenceVideo && !asset.metadata?.referenceAudio
  );
}

function requestedOrientation(args: Record<string, any>, state: ProjectState): MediaOrientation {
  const explicit = String(args.orientation || "");
  if (["portrait", "landscape", "square"].includes(explicit)) return explicit as MediaOrientation;
  return orientationFromDimensions(state.settings?.width, state.settings?.height);
}

function resolveStyleDna(state: ProjectState): StyleDNA | null {
  if (state.styleDna) return state.styleDna;
  if (state.editBlueprint) {
    const dna = extractStyleDnaFromBlueprint(state.editBlueprint);
    state.styleDna = dna;
    return dna;
  }
  return null;
}

function safeStyleDnaClipIds(state: ProjectState, requested: unknown): string[] | undefined {
  if (!state.editBlueprint && !Array.isArray(requested)) return undefined;
  const requestedIds = Array.isArray(requested) ? new Set(requested.map(String)) : null;
  return state.tracks.flatMap((track) => track.clips).filter((clip) => {
    if (requestedIds && !requestedIds.has(clip.id)) return false;
    const binding = clip.referenceEditBinding;
    if (clip.trackMatte || binding?.kind === "support-layer") return false;
    if (binding?.kind === "composition-layer") {
      const segment = state.editBlueprint?.segments.find((candidate) => candidate.index === binding.segmentIndex);
      const layer = segment?.composition?.layers.find((candidate) => candidate.id === binding.layerId);
      if (layer?.role === "matte-fill") return false;
    }
    return true;
  }).map((clip) => clip.id);
}

export const intelligenceToolDefinitions = [
  {
    name: "get_style_dna",
    description:
      "Return the project's Style DNA (from Edit Like This) or derive it from editBlueprint if DNA is missing. Use before apply_style_dna / rank_shots.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_shots",
    description:
      "List scene-level shots from the media library shot index (falls back to whole-asset synthetic shots). Filter by assetId, tags, shotType, or query.",
    parameters: {
      type: "object" as const,
      properties: {
        assetId: { type: "string", description: "Limit to one media asset id" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Require these tags",
        },
        shotType: {
          type: "string",
          description: "close-up|medium|wide|...",
        },
        query: {
          type: "string",
          description: "Free-text filter against summary/tags/subjects",
        },
        orientation: {
          type: "string",
          enum: ["portrait", "landscape", "square"],
          description: "Optional strict source orientation filter; omit to list every orientation",
        },
        limit: {
          type: "number",
          description: "Max shots to return (default 40)",
        },
      },
    },
  },
  {
    name: "rank_shots",
    description:
      "Rank library shots for a narrative role (hook/build/drop/outro/broll/cta) or free-text criteria, using Style DNA when available.",
    parameters: {
      type: "object" as const,
      properties: {
        role: {
          type: "string",
          description: `Narrative role: ${ROLES.join(", ")}`,
        },
        query: {
          type: "string",
          description: "Optional free-text criteria",
        },
        shotType: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        orientation: { type: "string", enum: ["portrait", "landscape", "square"] },
        orientationPolicy: {
          type: "string",
          enum: ["prefer", "strict", "allow"],
          description: "Defaults to prefer. Use strict when the user asks for only vertical/horizontal footage.",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
        },
      },
    },
  },
  {
    name: "select_shots_for_plan",
    description:
      "Rank shots for the current in_progress/pending plan step's shotCriteria (or explicit role/tags/query). Use after execute_next_plan_step.",
    parameters: {
      type: "object" as const,
      properties: {
        stepId: { type: "string", description: "Optional step id; default = current in_progress/pending" },
        role: { type: "string" },
        query: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        orientation: { type: "string", enum: ["portrait", "landscape", "square"] },
        orientationPolicy: { type: "string", enum: ["prefer", "strict", "allow"] },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "save_style_dna",
    description:
      "Save the current Style DNA into the project styleDnaLibrary under a name for reuse.",
    parameters: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_style_dna",
    description: "List saved Style DNA entries in the project library.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    name: "apply_style_dna",
    description:
      "Apply Style DNA hints to the timeline: restrained primary color matching (without inventing vignette/grain) on video clips lacking color FX, plus text animation hints. For deeper reference correction, use apply_reference_color_match or an explicit color-grade after inspecting the source. Pass libraryId to load a saved DNA first.",
    parameters: {
      type: "object" as const,
      properties: {
        libraryId: {
          type: "string",
          description: "Optional saved Style DNA library entry id",
        },
        skipIfHasColorFx: {
          type: "boolean",
          description: "Skip clips that already have color FX (default true)",
        },
        clipIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional exact clip scope. Use for generated/reference clips so unrelated user layers are preserved.",
        },
      },
    },
  },
];

export const intelligenceToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) =>
    | { result: string; state: ProjectState }
    | Promise<{ result: string; state: ProjectState }>
> = {
  get_style_dna: (_args, state) => {
    const dna = resolveStyleDna(state);
    if (!dna) {
      return {
        result:
          "No Style DNA on this project. Run Edit Like This on a reference, or continue without DNA.",
        state,
      };
    }
    return {
      result: JSON.stringify(dna, null, 2),
      state,
    };
  },

  list_shots: (args, state) => {
    const assets = sourceAssets(state);
    let shots = shotsFromAssets(assets);
    shots = filterShots(shots, {
      assetId: args.assetId,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      shotType: args.shotType ? String(args.shotType) : undefined,
      query: args.query ? String(args.query) : undefined,
    });
    const explicitOrientation = String(args.orientation || "");
    const orientation = ["portrait", "landscape", "square"].includes(explicitOrientation)
      ? explicitOrientation as MediaOrientation
      : "unknown";
    if (orientation !== "unknown") {
      shots = shots.filter((shot) => {
        const asset = assets.find((candidate) => candidate.id === shot.assetId);
        return asset ? mediaAssetOrientation(asset) === orientation : false;
      });
    }
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 40));
    const slice = shots.slice(0, limit);
    return {
      result: JSON.stringify(
        {
          count: shots.length,
          returned: slice.length,
          orientation,
          shots: slice.map((shot) => shotForAgent(shot, assets)),
        },
        null,
        2
      ),
      state,
    };
  },

  rank_shots: async (args, state) => {
    const dna = resolveStyleDna(state);
    const assets = sourceAssets(state);
    const shots = shotsFromAssets(assets);
    if (shots.length === 0) {
      return {
        result: "No shots available. Upload/analyze media first.",
        state,
      };
    }
    const role = args.role ? String(args.role) : undefined;
    const query = args.query ? String(args.query) : undefined;
    const embedSource = [query, role].filter(Boolean).join(" · ");
    let queryEmbedding: number[] | undefined;
    if (embedSource && shots.some((s) => s.embedding?.length)) {
      try {
        queryEmbedding = await embedTextForRanking(embedSource);
      } catch {
        queryEmbedding = undefined;
      }
    }
    let ranked = rankShots(
      shots,
      {
        role: role || args.query || "broll",
        query,
        shotType: args.shotType ? String(args.shotType) : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        ...(queryEmbedding ? { queryEmbedding } : {}),
      },
      dna
    );
    const orientation = requestedOrientation(args, state);
    const orientationPolicy = ["strict", "allow"].includes(String(args.orientationPolicy))
      ? String(args.orientationPolicy)
      : "prefer";
    if (orientation !== "unknown" && orientationPolicy !== "allow") {
      ranked = ranked
        .map((entry) => {
          const asset = assets.find((candidate) => candidate.id === entry.shot.assetId);
          const geometry = asset
            ? mediaDisplayGeometry(asset.metadata)
            : { orientation: "unknown" as const, width: undefined, height: undefined };
          const matches = geometry.orientation === orientation;
          const orientationKnown = geometry.orientation !== "unknown";
          const retention = coverRetention(
            geometry.width,
            geometry.height,
            state.settings?.width,
            state.settings?.height
          );
          return {
            ...entry,
            score: entry.score + (matches ? 35 : orientationKnown ? -35 : 0) + (retention === undefined ? 0 : retention * 10),
            reasons: [
              ...entry.reasons,
              matches
                ? `orientation ${orientation}`
                : orientationKnown
                  ? `orientation mismatch (${geometry.orientation}→${orientation})`
                  : "orientation unknown",
              ...(retention === undefined ? [] : [`cover retention ${(retention * 100).toFixed(0)}%`]),
            ],
          };
        })
        .filter((entry) => orientationPolicy !== "strict" || entry.reasons.includes(`orientation ${orientation}`))
        .sort((a, b) => b.score - a.score);
    }
    const limit = Math.max(1, Math.min(30, Number(args.limit) || 10));
    return {
      result: JSON.stringify(
        {
          role: role || null,
          hasStyleDna: !!dna,
          usedEmbedding: Boolean(queryEmbedding),
          targetOrientation: orientation,
          orientationPolicy,
          ranked: ranked.slice(0, limit).map((r) => ({
            score: r.score,
            reasons: r.reasons,
            shot: shotForAgent(r.shot, assets),
          })),
        },
        null,
        2
      ),
      state,
    };
  },

  select_shots_for_plan: async (args, state) => {
    const step =
      (args.stepId &&
        state.editPlan?.steps.find((s) => s.id === String(args.stepId))) ||
      state.editPlan?.steps.find((s) => s.status === "in_progress") ||
      state.editPlan?.steps.find((s) => s.status === "pending");
    const criteria = step?.shotCriteria;
    const role =
      (args.role ? String(args.role) : undefined) ||
      criteria?.role ||
      undefined;
    const query =
      (args.query ? String(args.query) : undefined) ||
      criteria?.query ||
      criteria?.energy ||
      step?.purpose;
    const tags =
      (Array.isArray(args.tags) ? args.tags.map(String) : undefined) ||
      criteria?.tags;
    return intelligenceToolExecutors.rank_shots!(
      {
        role,
        query,
        tags,
        orientation: args.orientation,
        orientationPolicy: args.orientationPolicy,
        limit: args.limit,
      },
      state
    );
  },

  save_style_dna: (args, state) => {
    const dna = resolveStyleDna(state);
    if (!dna) return { result: "Error: no Style DNA to save", state };
    const name = String(args.name || "").trim();
    if (!name) return { result: "Error: name required", state };
    if (!state.styleDnaLibrary) state.styleDnaLibrary = [];
    const id = `dna_lib_${Date.now().toString(36)}`;
    state.styleDnaLibrary.push({
      id,
      name,
      dna,
      createdAt: new Date().toISOString(),
    });
    return {
      result: `Saved Style DNA "${name}" as ${id} (library size ${state.styleDnaLibrary.length})`,
      state,
    };
  },

  list_style_dna: (_args, state) => {
    const lib = state.styleDnaLibrary || [];
    return {
      result: JSON.stringify(
        lib.map((e) => ({
          id: e.id,
          name: e.name,
          createdAt: e.createdAt,
          pacing: e.dna.pacing?.label,
        })),
        null,
        2
      ),
      state,
    };
  },

  apply_style_dna: (args, state) => {
    if (args.libraryId) {
      const entry = (state.styleDnaLibrary || []).find(
        (e) => e.id === String(args.libraryId)
      );
      if (!entry) {
        return { result: `Error: library entry ${args.libraryId} not found`, state };
      }
      state.styleDna = entry.dna;
    }
    const dna = resolveStyleDna(state);
    if (!dna) {
      return {
        result: "Error: No Style DNA available to apply.",
        state,
      };
    }
    const next = applyStyleDnaHints(state.tracks, dna, {
      skipIfHasColorFx: args.skipIfHasColorFx !== false,
      clipIds: safeStyleDnaClipIds(state, args.clipIds),
    });
    state.tracks = next;
    return {
      result: `Applied Style DNA hints (pacing=${dna.pacing.label}, contrastBias=${dna.color.contrastBias ?? 0}). Video clips without color FX got mild grade; text clips may have animation hints.`,
      state,
    };
  },
};
