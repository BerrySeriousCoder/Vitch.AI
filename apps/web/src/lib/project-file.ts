import type {
  AudioMixer,
  BrandKit,
  Camera3D,
  EditPlan,
  GraphicTemplate,
  Light3D,
  ProjectSettings,
  Sequence,
  StyleDNA,
  TimelineMarker,
  Track,
  Transition,
} from "@tempo/types";

export interface TempoProjectFile {
  name: string;
  settings: ProjectSettings;
  tracks: Track[];
  audioMixer?: AudioMixer;
  transitions?: Transition[];
  editPlan?: EditPlan | null;
  styleDnaLibrary?: Array<{ id: string; name: string; dna: StyleDNA; createdAt: string }>;
  sequences?: Sequence[];
  cameras?: Camera3D[];
  lights?: Light3D[];
  markers?: TimelineMarker[];
  brandKit?: BrandKit | null;
  graphicTemplates?: GraphicTemplate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const TRACK_TYPES = new Set(["video", "audio", "text", "shape", "effect", "adjustment", "null"]);
const BLEND_MODES = new Set(["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion"]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validTransform(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["x", "y", "scaleX", "scaleY", "rotation", "anchorX", "anchorY"].every((key) => finite(value[key]));
}

function validClip(value: unknown, trackId: string, clipIds: Set<string>): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || clipIds.has(value.id)) return false;
  if (value.trackId !== trackId || !finite(value.startTime) || value.startTime < 0 || !finite(value.duration) || value.duration <= 0) return false;
  if (!finite(value.sourceOffset) || value.sourceOffset < 0 || !finite(value.speed) || value.speed === 0) return false;
  if (!validTransform(value.transform) || !finite(value.opacity) || value.opacity < 0 || value.opacity > 1) return false;
  if (typeof value.blendMode !== "string" || !BLEND_MODES.has(value.blendMode)) return false;
  if (!Array.isArray(value.effects) || !Array.isArray(value.keyframes) || typeof value.muted !== "boolean" || !finite(value.volume)) return false;
  clipIds.add(value.id);
  return true;
}

function validTrack(value: unknown, trackIds: Set<string>, clipIds: Set<string>): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || trackIds.has(value.id)) return false;
  if (typeof value.name !== "string" || typeof value.type !== "string" || !TRACK_TYPES.has(value.type)) return false;
  if (!finite(value.order) || typeof value.locked !== "boolean" || typeof value.visible !== "boolean" || typeof value.solo !== "boolean") return false;
  if (!Array.isArray(value.clips) || !value.clips.every((clip) => validClip(clip, value.id as string, clipIds))) return false;
  trackIds.add(value.id);
  return true;
}

function validSettings(value: Record<string, unknown>): boolean {
  return finite(value.width) && value.width > 0
    && finite(value.height) && value.height > 0
    && finite(value.fps) && value.fps > 0
    && finite(value.duration) && value.duration >= 0
    && typeof value.backgroundColor === "string"
    && finite(value.sampleRate) && value.sampleRate > 0;
}

/** Parse the portable, version-tolerant project envelope without accepting arbitrary DB fields. */
export function parseTempoProjectFile(text: string): TempoProjectFile | null {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name.trim() || !isRecord(raw.settings) || !Array.isArray(raw.tracks)) {
    return null;
  }
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  if (!validSettings(raw.settings) || !raw.tracks.every((track) => validTrack(track, trackIds, clipIds))) return null;
  for (const key of ["transitions", "styleDnaLibrary", "sequences", "cameras", "lights", "markers", "graphicTemplates"] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) return null;
  }
  if (raw.audioMixer !== undefined && !isRecord(raw.audioMixer)) return null;
  if (raw.brandKit !== undefined && raw.brandKit !== null && !isRecord(raw.brandKit)) return null;
  return raw as unknown as TempoProjectFile;
}

/** Every persisted editor surface included by project.store exportProjectJSON. */
export function projectFileData(file: TempoProjectFile) {
  return {
    tracks: file.tracks,
    audioMixer: file.audioMixer,
    transitions: file.transitions ?? [],
    editPlan: file.editPlan ?? null,
    styleDnaLibrary: file.styleDnaLibrary ?? [],
    sequences: file.sequences ?? [],
    cameras: file.cameras ?? [],
    lights: file.lights ?? [],
    markers: file.markers ?? [],
    brandKit: file.brandKit ?? null,
    graphicTemplates: file.graphicTemplates ?? [],
  };
}
