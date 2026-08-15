import {
  listTransitionTypes,
  listTransitionTypeIds,
  getTransitionType,
  applyTransition,
  applyTransitionToTrackCuts,
  removeTransition,
  updateTransitionDuration,
  defaultTransitionParams,
  validateHold,
  listEditPoints,
  transitionSameTrackHint,
  toolOk,
  toolErr,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";

function mediaDurationMap(state: ProjectState): Record<string, number> {
  const map: Record<string, number> = {};
  for (const asset of state.mediaAssets || []) {
    const d = asset.duration ?? asset.metadata?.duration;
    if (typeof d === "number" && d > 0) map[asset.id] = d;
  }
  return map;
}

function findTrackIdForClips(
  state: ProjectState,
  clipAId: string,
  clipBId: string
): string | null {
  for (const track of state.tracks) {
    const hasA = track.clips.some((c) => c.id === clipAId);
    const hasB = track.clips.some((c) => c.id === clipBId);
    if (hasA && hasB) return track.id;
  }
  return null;
}

const TYPE_IDS = listTransitionTypeIds();

// Reference analysis and ordinary user language use a few friendly names that
// are not persisted transition registry ids. Normalize them at the tool
// boundary so a model cannot strand an otherwise valid edit by repeating the
// blueprint vocabulary verbatim.
const TRANSITION_TYPE_ALIASES: Record<string, string> = {
  fade: "crossfade",
  dissolve: "crossfade",
  swipe: "wipe",
  "film-burn": "film-burn-transition",
};

function canonicalTransitionType(value: unknown): string {
  const type = String(value ?? "").trim().toLowerCase();
  return TRANSITION_TYPE_ALIASES[type] || type;
}

export const transitionsToolDefinitions = [
  {
    name: "list_transitions",
    description:
      "List registered transition types (crossfade, dip-black, wipe, push, …) with defaults and exportBackend. Use before add_transition.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_edit_points",
    description:
      "List abutting (or near-abutting) clip pairs on the same track that can take an edit-point transition. Prefer abuttingOnly:true before add_transition. Returns JSON {editPoints:[{trackId,clipAId,clipBId,cutTime,abutting,...}]}",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: {
          type: "string",
          description: "Optional — limit to one track",
        },
        abuttingOnly: {
          type: "boolean",
          description: "If true (default), only gap≈0 pairs",
        },
        maxGapSec: {
          type: "number",
          description:
            "When abuttingOnly is false, include gaps up to this (default 0.05)",
        },
      },
    },
  },
  {
    name: "get_transition_schema",
    description: "Get parameter schema for one transition type.",
    parameters: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description: `Transition type id from list_transitions (${TYPE_IDS.join(", ")})`,
          enum: TYPE_IDS,
        },
      },
      required: ["type"],
    },
  },
  {
    name: "add_transition",
    description:
      "Add an edit-point transition between two adjacent clips on the SAME track. Call list_edit_points first and use its clipAId/clipBId. Steals head/tail media; if handles are short pass allowHold:true. Returns JSON {ok, transitionId, ...}.",
    parameters: {
      type: "object" as const,
      properties: {
        clipAId: { type: "string", description: "Outgoing clip id" },
        clipBId: { type: "string", description: "Incoming clip id" },
        type: {
          type: "string",
          description: `Transition type from list_transitions (${TYPE_IDS.join(", ")}). Friendly aliases fade/dissolve and swipe are normalized to crossfade and wipe.`,
          enum: TYPE_IDS,
        },
        duration: {
          type: "number",
          description: "Overlap duration in seconds (default from schema)",
        },
        direction: {
          type: "string",
          description: "Wipe/push direction: left|right|up|down",
        },
        softness: {
          type: "number",
          description: "Wipe edge softness 0..0.5",
        },
        blur: {
          type: "number",
          description: "Whip motion smear amount (see get_transition_schema)",
        },
        centerX: {
          type: "number",
          description: "Iris center X 0..1",
        },
        centerY: {
          type: "number",
          description: "Iris center Y 0..1",
        },
        params: {
          type: "object",
          description: "Optional extra params object (merged with direction/softness/blur/center*)",
        },
        allowHold: {
          type: "boolean",
          description:
            "If true, insufficient media handles create a marked freeze hold on the outgoing clip instead of failing",
        },
      },
      required: ["clipAId", "clipBId", "type"],
    },
  },
  {
    name: "apply_transition_to_cuts",
    description: "Apply one transition recipe to every clean abutting cut on a track. Skips cuts with insufficient handles and returns applied/skipped details; use allowHold:true only when marked freeze extensions are acceptable.",
    parameters: {
      type: "object" as const,
      properties: {
        trackId: { type: "string" },
        type: { type: "string", description: `Transition type (${TYPE_IDS.join(", ")})`, enum: TYPE_IDS },
        duration: { type: "number" },
        params: { type: "object" },
        allowHold: { type: "boolean" },
      },
      required: ["trackId", "type"],
    },
  },
  {
    name: "set_clip_hold",
    description:
      "Set or clear a marked freeze/hold on a clip edge (in|out). durationSec 0 clears. Use when transition handles are short or for emphasis freezes.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        at: { type: "string", enum: ["in", "out"] },
        durationSec: {
          type: "number",
          description: "Hold duration in timeline seconds; 0 clears",
        },
      },
      required: ["clipId", "at", "durationSec"],
    },
  },
  {
    name: "update_transition",
    description: "Update a transition's duration (re-validates media handles).",
    parameters: {
      type: "object" as const,
      properties: {
        transitionId: { type: "string" },
        duration: { type: "number" },
      },
      required: ["transitionId", "duration"],
    },
  },
  {
    name: "remove_transition",
    description: "Remove a transition and restore abutting cut geometry.",
    parameters: {
      type: "object" as const,
      properties: {
        transitionId: { type: "string" },
      },
      required: ["transitionId"],
    },
  },
];

export const transitionsToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) => { result: string; state: ProjectState }
> = {
  list_transitions: (_args, state) => {
    const types = listTransitionTypes().map((t) => ({
      type: t.type,
      name: t.name,
      description: t.description,
      mixFamily: t.mixFamily,
      defaultDuration: t.params.duration?.defaultValue ?? 0.5,
      exportBackend: t.exportBackend,
      params: t.params,
    }));
    const existing = (state.transitions || []).map((t) => ({
      id: t.id,
      type: t.type,
      clipAId: t.clipAId,
      clipBId: t.clipBId,
      duration: t.duration,
      params: t.params,
    }));
    return {
      result: JSON.stringify({ types, existing, count: types.length }),
      state,
    };
  },

  list_edit_points: (args, state) => {
    const abuttingOnly = args.abuttingOnly !== false;
    const editPoints = listEditPoints(state.tracks, {
      trackId: args.trackId ? String(args.trackId) : undefined,
      abuttingOnly,
      maxGapSec:
        typeof args.maxGapSec === "number" ? args.maxGapSec : undefined,
    });
    return {
      result: JSON.stringify({
        ok: true,
        editPoints,
        count: editPoints.length,
        summary:
          editPoints.length === 0
            ? "No edit points found — ensure clips abut on the same track"
            : `${editPoints.length} edit point(s)`,
      }),
      state,
    };
  },

  get_transition_schema: (args, state) => {
    const type = canonicalTransitionType(args.type);
    const def = getTransitionType(type);
    if (!def) {
      return {
        result: toolErr(`Unknown transition type "${args.type}"`, {
          code: "UNKNOWN_TYPE",
        }),
        state,
      };
    }
    return { result: JSON.stringify(def), state };
  },

  add_transition: (args, state) => {
    if (args.allowHold !== undefined && typeof args.allowHold !== "boolean") {
      return { result: toolErr("allowHold must be a boolean", { code: "INVALID_PARAMS" }), state };
    }
    const trackId = findTrackIdForClips(state, args.clipAId, args.clipBId);
    if (!trackId) {
      const hint = transitionSameTrackHint(
        state.tracks,
        String(args.clipAId),
        String(args.clipBId)
      );
      return {
        result: toolErr(hint.error, {
          code: "DIFFERENT_TRACK_OR_MISSING",
          fixHint: hint.fixHint,
          clipLocations: hint.clipLocations,
          suggestedPairs: hint.suggestedPairs,
        }),
        state,
      };
    }
    const type = canonicalTransitionType(args.type);
    const def = getTransitionType(type);
    if (!def) {
      return {
        result: toolErr(
          `Unknown type "${args.type}". Use list_transitions.`,
          { code: "UNKNOWN_TYPE" }
        ),
        state,
      };
    }
    const existingTransition = (state.transitions || []).find(
      (transition) =>
        (transition.clipAId === String(args.clipAId) &&
          transition.clipBId === String(args.clipBId)) ||
        (transition.clipAId === String(args.clipBId) &&
          transition.clipBId === String(args.clipAId))
    );
    if (existingTransition?.type === type) {
      return {
        result: toolOk(`The ${type} transition already exists; no change needed`, {
          transitionId: existingTransition.id,
          trackId,
          clipAId: String(args.clipAId),
          clipBId: String(args.clipBId),
          alreadyExists: true,
        }),
        state,
      };
    }
    if (existingTransition) {
      return {
        result: toolErr(
          `Transition ${existingTransition.id} (${existingTransition.type}) already exists between these clips`,
          {
            code: "DIFFERENT_TRANSITION_EXISTS",
            fixHint: `Call remove_transition with transitionId "${existingTransition.id}" before adding ${type}.`,
            transitionId: existingTransition.id,
          }
        ),
        state,
      };
    }
    const duration =
      typeof args.duration === "number"
        ? args.duration
        : Number(def.params.duration?.defaultValue ?? 0.5);

    const params: Record<string, number | string | boolean> = {
      ...defaultTransitionParams(type),
      ...(args.params && typeof args.params === "object" ? args.params : {}),
    };
    if (args.direction != null) params.direction = String(args.direction);
    if (args.softness != null) params.softness = Number(args.softness);
    if (args.blur != null) params.blur = Number(args.blur);
    if (args.centerX != null) params.centerX = Number(args.centerX);
    if (args.centerY != null) params.centerY = Number(args.centerY);

    const result = applyTransition(
      state.tracks,
      state.transitions || [],
      {
        trackId,
        clipAId: String(args.clipAId),
        clipBId: String(args.clipBId),
        type,
        duration,
        params,
        allowHold: args.allowHold ?? false,
      },
      mediaDurationMap(state)
    );
    if (!result.ok) {
      const msg = result.message || "add_transition failed";
      const needsHold =
        /insufficient|handle|tail|head/i.test(msg) && !args.allowHold;
      return {
        result: toolErr(msg, {
          code: "TRANSITION_APPLY_FAILED",
          fixHint: needsHold
            ? "Retry add_transition with allowHold:true, or call set_clip_hold on the outgoing clip out-edge, then retry."
            : "Call list_edit_points and use an abutting same-track pair; ensure media durations are known.",
        }),
        state,
      };
    }
    state.tracks = result.value.tracks;
    state.transitions = result.value.transitions;
    const holdNote = result.value.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === args.clipAId)?.hold;
    return {
      result: toolOk(
        `Added ${type} transition${
          holdNote
            ? ` (with marked hold out ${holdNote.durationSec.toFixed(2)}s)`
            : ""
        }`,
        {
          transitionId: result.value.transition.id,
          trackId,
          clipAId: String(args.clipAId),
          clipBId: String(args.clipBId),
        }
      ),
      state,
    };
  },

  apply_transition_to_cuts: (args, state) => {
    if (args.allowHold !== undefined && typeof args.allowHold !== "boolean") {
      return { result: toolErr("allowHold must be a boolean", { code: "INVALID_PARAMS" }), state };
    }
    const type = canonicalTransitionType(args.type);
    const def = getTransitionType(type);
    if (!def) return { result: toolErr(`Unknown type "${type}". Use list_transitions.`, { code: "UNKNOWN_TYPE" }), state };
    const trackId = String(args.trackId);
    if (!state.tracks.some((track) => track.id === trackId)) return { result: `Error: Track ${trackId} not found`, state };
    const duration = typeof args.duration === "number" ? args.duration : Number(def.params.duration?.defaultValue ?? 0.5);
    const result = applyTransitionToTrackCuts(state.tracks, state.transitions || [], {
      trackId,
      type,
      duration,
      params: { ...defaultTransitionParams(type), ...(args.params && typeof args.params === "object" ? args.params : {}) },
      allowHold: args.allowHold ?? false,
    }, mediaDurationMap(state));
    state.tracks = result.tracks;
    state.transitions = result.transitions;
    return { result: JSON.stringify({ ok: true, applied: result.applied.map((transition) => transition.id), skipped: result.skipped }), state };
  },

  set_clip_hold: (args, state) => {
    let clip = null as null | { hold?: unknown; id: string };
    for (const track of state.tracks) {
      const c = track.clips.find((x) => x.id === args.clipId);
      if (c) {
        clip = c;
        break;
      }
    }
    if (!clip) return { result: `Error: Clip ${args.clipId} not found`, state };
    const durationSec = Number(args.durationSec);
    if (!(durationSec > 0)) {
      clip.hold = null;
      return { result: `Cleared hold on ${clip.id}`, state };
    }
    const validated = validateHold({ at: args.at, durationSec });
    if (!validated.ok) return { result: `Error: ${validated.message}`, state };
    clip.hold = validated.value;
    return {
      result: `Set hold ${args.at} ${durationSec}s on ${clip.id}`,
      state,
    };
  },

  update_transition: (args, state) => {
    const result = updateTransitionDuration(
      state.tracks,
      state.transitions || [],
      String(args.transitionId),
      Number(args.duration),
      mediaDurationMap(state)
    );
    if (!result.ok) {
      return { result: `Error: ${result.message}`, state };
    }
    state.tracks = result.value.tracks;
    state.transitions = result.value.transitions;
    return {
      result: `Updated transition ${args.transitionId} duration to ${args.duration}s`,
      state,
    };
  },

  remove_transition: (args, state) => {
    const result = removeTransition(
      state.tracks,
      state.transitions || [],
      String(args.transitionId)
    );
    if (!result.ok) {
      return { result: `Error: ${result.message}`, state };
    }
    state.tracks = result.value.tracks;
    state.transitions = result.value.transitions;
    return {
      result: `Removed transition ${args.transitionId}`,
      state,
    };
  },
};
