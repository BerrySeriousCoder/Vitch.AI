import { randomUUID } from "crypto";
import type { TimelineMarker } from "@tempo/types";
import type { ProjectState } from "./project-state.js";

const MARKER_TYPES = ["comment", "chapter", "todo", "beat"] as const;
const DEFAULT_COLOR = "#f59e0b";

function markerList(state: ProjectState): TimelineMarker[] {
  if (!state.markers) state.markers = [];
  return state.markers;
}

function normalizeTime(value: unknown): number | null {
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 ? Math.round(time * 1000) / 1000 : null;
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim().slice(0, 80);
  return label || null;
}

function normalizeColor(value: unknown): string | null {
  if (value === undefined) return DEFAULT_COLOR;
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

export const markerToolDefinitions = [
  {
    name: "add_marker",
    description: "Add a persistent timeline marker for a beat, chapter, review note, or edit reminder. Markers are snap targets in the timeline.",
    parameters: {
      type: "object" as const,
      properties: {
        time: { type: "number", description: "Timeline time in seconds (must be 0 or later)" },
        label: { type: "string", description: "Short visible label, maximum 80 characters" },
        type: { type: "string", enum: MARKER_TYPES, description: "comment | chapter | todo | beat" },
        color: { type: "string", description: "Optional marker color as #RRGGBB" },
      },
      required: ["time", "label"],
    },
  },
  {
    name: "update_marker",
    description: "Change a marker's time, label, type, or color. Use list_markers first if the marker id is not known.",
    parameters: {
      type: "object" as const,
      properties: {
        markerId: { type: "string" },
        time: { type: "number" },
        label: { type: "string" },
        type: { type: "string", enum: MARKER_TYPES },
        color: { type: "string", description: "#RRGGBB" },
      },
      required: ["markerId"],
    },
  },
  {
    name: "remove_marker",
    description: "Remove a persistent timeline marker by its exact marker id.",
    parameters: {
      type: "object" as const,
      properties: { markerId: { type: "string" } },
      required: ["markerId"],
    },
  },
  {
    name: "list_markers",
    description: "List all persistent timeline markers, ordered by time, before updating or removing one.",
    parameters: { type: "object" as const, properties: {} },
  },
];

export const markerToolExecutors: Record<
  string,
  (args: any, state: ProjectState) => { result: string; state: ProjectState }
> = {
  add_marker: (args, state) => {
    const time = normalizeTime(args.time);
    const label = normalizeLabel(args.label);
    const color = normalizeColor(args.color);
    const type = args.type === undefined ? "comment" : args.type;
    if (time === null) return { result: "Error: marker time must be a finite value at or after 0 seconds", state };
    if (!label) return { result: "Error: marker label must be non-empty", state };
    if (!color) return { result: "Error: marker color must use #RRGGBB", state };
    if (!MARKER_TYPES.includes(type)) return { result: "Error: marker type must be comment, chapter, todo, or beat", state };

    const marker: TimelineMarker = { id: randomUUID(), time, label, color, type };
    markerList(state).push(marker);
    state.markers!.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return { result: JSON.stringify({ ok: true, markerId: marker.id, marker }), state };
  },

  update_marker: (args, state) => {
    const marker = markerList(state).find((item) => item.id === args.markerId);
    if (!marker) return { result: `Error: Marker ${args.markerId} not found`, state };
    if (args.time !== undefined) {
      const time = normalizeTime(args.time);
      if (time === null) return { result: "Error: marker time must be a finite value at or after 0 seconds", state };
      marker.time = time;
    }
    if (args.label !== undefined) {
      const label = normalizeLabel(args.label);
      if (!label) return { result: "Error: marker label must be non-empty", state };
      marker.label = label;
    }
    if (args.color !== undefined) {
      const color = normalizeColor(args.color);
      if (!color) return { result: "Error: marker color must use #RRGGBB", state };
      marker.color = color;
    }
    if (args.type !== undefined) {
      if (!MARKER_TYPES.includes(args.type)) return { result: "Error: marker type must be comment, chapter, todo, or beat", state };
      marker.type = args.type;
    }
    state.markers!.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return { result: JSON.stringify({ ok: true, marker }), state };
  },

  remove_marker: (args, state) => {
    const markers = markerList(state);
    const index = markers.findIndex((item) => item.id === args.markerId);
    if (index < 0) return { result: `Error: Marker ${args.markerId} not found`, state };
    const [removed] = markers.splice(index, 1);
    return { result: JSON.stringify({ ok: true, markerId: removed!.id }), state };
  },

  list_markers: (_args, state) => ({
    result: JSON.stringify({ ok: true, markers: [...markerList(state)].sort((a, b) => a.time - b.time) }),
    state,
  }),
};
