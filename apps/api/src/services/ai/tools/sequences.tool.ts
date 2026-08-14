import {
  countSequenceUsage,
  createEmptySequence,
  createSequenceFromClips,
  deleteSequence,
  placeSequenceClip,
  renameSequence,
  sequenceContentEnd,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";

function ensureSequences(state: ProjectState) {
  if (!state.sequences) state.sequences = [];
  return state.sequences;
}

export const sequencesToolDefinitions = [
  {
    name: "list_sequences",
    description:
      "List nested sequences (precomps) in the project library with usage counts on the main timeline.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    name: "inspect_sequence",
    description: "Dump tracks/clips inside one sequence (observe). Depth 1 only — sequences cannot nest.",
    parameters: {
      type: "object" as const,
      properties: {
        sequenceId: { type: "string" },
      },
      required: ["sequenceId"],
    },
  },
  {
    name: "create_sequence",
    description:
      "Create an empty sequence or move main-timeline clipIds into a new sequence and replace them with one nest clip. Depth 1 — cannot nest a nest. Nested audio is silent when the sequence is used on Main (video-only).",
    parameters: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        clipIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional main-timeline clip ids to pack into the sequence",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "place_sequence_clip",
    description: "Place a sequence nest clip on a main timeline track.",
    parameters: {
      type: "object" as const,
      properties: {
        sequenceId: { type: "string" },
        trackId: { type: "string" },
        startTime: { type: "number" },
        duration: { type: "number" },
      },
      required: ["sequenceId", "trackId", "startTime"],
    },
  },
  {
    name: "rename_sequence",
    description: "Rename a sequence in the library.",
    parameters: {
      type: "object" as const,
      properties: {
        sequenceId: { type: "string" },
        name: { type: "string" },
      },
      required: ["sequenceId", "name"],
    },
  },
  {
    name: "delete_sequence",
    description:
      "Delete a sequence from the library. Fails if any main-timeline nest still references it.",
    parameters: {
      type: "object" as const,
      properties: {
        sequenceId: { type: "string" },
      },
      required: ["sequenceId"],
    },
  },
];

export const sequencesToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) => { result: string; state: ProjectState }
> = {
  list_sequences: (_args, state) => {
    const sequences = ensureSequences(state);
    if (sequences.length === 0) {
      return { result: "No sequences in library", state };
    }
    const lines = sequences.map((s) => {
      const used = countSequenceUsage(state.tracks, s.id);
      const end = sequenceContentEnd(s);
      return `${s.id} "${s.name}" contentEnd=${end.toFixed(2)}s used=${used}x`;
    });
    return { result: lines.join("\n"), state };
  },

  inspect_sequence: (args, state) => {
    const sequences = ensureSequences(state);
    const seq = sequences.find((s) => s.id === String(args.sequenceId));
    if (!seq) return { result: `Error: Sequence ${args.sequenceId} not found`, state };
    const summary = seq.tracks.map((t) => {
      const clips = t.clips
        .map(
          (c) =>
            `${c.id}@${c.startTime.toFixed(2)}s/${c.duration.toFixed(2)}s media=${c.sourceMediaId || "none"}`
        )
        .join(", ");
      return `${t.name}(${t.type}): [${clips}]`;
    });
    return {
      result: `Sequence "${seq.name}" (${seq.id})\n${summary.join("\n") || "(empty)"}`,
      state,
    };
  },

  create_sequence: (args, state) => {
    const sequences = ensureSequences(state);
    const name = String(args.name || "Sequence");
    const clipIds = Array.isArray(args.clipIds)
      ? args.clipIds.map(String)
      : [];
    if (clipIds.length === 0) {
      const seq = createEmptySequence(name);
      state.sequences = [...sequences, seq];
      return { result: `Created empty sequence ${seq.id} "${seq.name}"`, state };
    }
    const r = createSequenceFromClips(
      state.tracks,
      state.transitions || [],
      sequences,
      clipIds,
      name
    );
    if (!r.ok) return { result: `Error: ${r.message}`, state };
    state.tracks = r.tracks;
    state.transitions = r.transitions;
    state.sequences = r.sequences;
    return {
      result: `Created sequence ${r.sequenceId} from ${clipIds.length} clips; nest clip ${r.nestClipId}`,
      state,
    };
  },

  place_sequence_clip: (args, state) => {
    const sequences = ensureSequences(state);
    const r = placeSequenceClip(
      state.tracks,
      String(args.sequenceId),
      String(args.trackId),
      Number(args.startTime),
      args.duration !== undefined ? Number(args.duration) : 0,
      sequences
    );
    if (!r.ok) return { result: `Error: ${r.message}`, state };
    state.tracks = r.tracks;
    return {
      result: `Placed sequence ${args.sequenceId} as clip ${r.clipId}`,
      state,
    };
  },

  rename_sequence: (args, state) => {
    const sequences = ensureSequences(state);
    const r = renameSequence(sequences, String(args.sequenceId), String(args.name));
    if (!r.ok) return { result: `Error: ${r.message}`, state };
    state.sequences = r.sequences;
    return { result: `Renamed sequence to "${args.name}"`, state };
  },

  delete_sequence: (args, state) => {
    const sequences = ensureSequences(state);
    const r = deleteSequence(sequences, state.tracks, String(args.sequenceId));
    if (!r.ok) return { result: `Error: ${r.message}`, state };
    state.sequences = r.sequences;
    return { result: `Deleted sequence ${args.sequenceId}`, state };
  },
};
