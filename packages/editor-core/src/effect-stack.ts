import type { Clip, Effect, Track } from "@tempo/types";
import { getEffectDefinition } from "./effect-registry";

export type ClipAttributeScope = "effects" | "color" | "motion" | "audio";

export interface ApplyClipAttributesInput {
  sourceClipId: string;
  targetClipIds: string[];
  scopes: ClipAttributeScope[];
  /** Replace the relevant target effect group instead of appending it. */
  replaceEffects?: boolean;
}

export interface EffectStackResult {
  tracks: Track[];
  affectedClipIds: string[];
}

type Failure = { ok: false; message: string };

function findClip(tracks: readonly Track[], clipId: string): Clip | null {
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return null;
}

function cloneEffect(effect: Effect, createId: () => string): Effect {
  return {
    ...effect,
    id: createId(),
    params: Object.fromEntries(
      Object.entries(effect.params).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map((point) => ({ ...point })) : value,
      ])
    ),
    keyframes: effect.keyframes.map((keyframe) => ({ ...keyframe, id: createId() })),
  };
}

function isColorEffect(effect: Effect): boolean {
  return getEffectDefinition(effect.type)?.category === "color";
}

/** Enable/disable one effect without changing its parameters or keyframes. */
export function setEffectEnabled(
  tracks: readonly Track[],
  clipId: string,
  effectId: string,
  enabled: boolean
): EffectStackResult | Failure {
  const clip = findClip(tracks, clipId);
  if (!clip) return { ok: false, message: `Clip ${clipId} not found` };
  if (!clip.effects.some((effect) => effect.id === effectId)) {
    return { ok: false, message: `Effect ${effectId} not found on clip ${clipId}` };
  }
  return {
    tracks: tracks.map((track) => ({
      ...track,
      clips: track.clips.map((candidate) => candidate.id !== clipId
        ? candidate
        : { ...candidate, effects: candidate.effects.map((effect) => effect.id === effectId ? { ...effect, enabled } : effect) }),
    })),
    affectedClipIds: [clipId],
  };
}

/** Reorder a clip's complete effect stack. Rejects partial or duplicate orderings. */
export function reorderClipEffects(
  tracks: readonly Track[],
  clipId: string,
  effectIds: readonly string[]
): EffectStackResult | Failure {
  const clip = findClip(tracks, clipId);
  if (!clip) return { ok: false, message: `Clip ${clipId} not found` };
  const existing = new Set(clip.effects.map((effect) => effect.id));
  if (effectIds.length !== existing.size || new Set(effectIds).size !== existing.size || effectIds.some((id) => !existing.has(id))) {
    return { ok: false, message: "effectIds must contain every effect on the clip exactly once" };
  }
  const byId = new Map(clip.effects.map((effect) => [effect.id, effect]));
  return {
    tracks: tracks.map((track) => ({
      ...track,
      clips: track.clips.map((candidate) => candidate.id !== clipId
        ? candidate
        : { ...candidate, effects: effectIds.map((id) => byId.get(id)!) }),
    })),
    affectedClipIds: [clipId],
  };
}

/** Copy selected non-destructive attribute groups from one clip to many targets. */
export function applyClipAttributes(
  tracks: readonly Track[],
  input: ApplyClipAttributesInput,
  createId: () => string
): EffectStackResult | Failure {
  const source = findClip(tracks, input.sourceClipId);
  if (!source) return { ok: false, message: `Source clip ${input.sourceClipId} not found` };
  const scopes = new Set(input.scopes);
  if (scopes.size === 0) return { ok: false, message: "At least one attribute scope is required" };
  const targetIds = [...new Set(input.targetClipIds)].filter((id) => id !== source.id);
  if (targetIds.length === 0) return { ok: false, message: "Provide at least one target clip different from the source" };
  const missing = targetIds.filter((id) => !findClip(tracks, id));
  if (missing.length > 0) return { ok: false, message: `Target clip(s) not found: ${missing.join(", ")}` };
  const replacement = input.replaceEffects !== false;
  const sourceColorEffects = source.effects.filter(isColorEffect);

  const nextTracks = tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (!targetIds.includes(clip.id)) return clip;
      let next: Clip = clip;
      if (scopes.has("effects")) {
        const copied = source.effects.map((effect) => cloneEffect(effect, createId));
        next = { ...next, effects: replacement ? copied : [...next.effects, ...copied] };
      } else if (scopes.has("color")) {
        const copied = sourceColorEffects.map((effect) => cloneEffect(effect, createId));
        next = {
          ...next,
          effects: replacement
            ? [...next.effects.filter((effect) => !isColorEffect(effect)), ...copied]
            : [...next.effects, ...copied],
        };
      }
      if (scopes.has("motion")) {
        next = {
          ...next,
          transform: { ...source.transform },
          opacity: source.opacity,
          blendMode: source.blendMode,
          crop: source.crop ? { ...source.crop } : source.crop,
          keyframes: source.keyframes.map((keyframe) => ({ ...keyframe, id: createId() })),
        };
      }
      if (scopes.has("audio")) {
        next = {
          ...next,
          volume: source.volume,
          muted: source.muted,
          fadeInSec: source.fadeInSec,
          fadeOutSec: source.fadeOutSec,
        };
      }
      return next;
    }),
  }));
  return { tracks: nextTracks, affectedClipIds: targetIds };
}
