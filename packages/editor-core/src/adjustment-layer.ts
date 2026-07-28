import type { AdjustmentLayer, Clip, Track } from "@tempo/types";

export const DEFAULT_ADJUSTMENT_LAYER: AdjustmentLayer = { target: "below" };

export interface CreateAdjustmentLayerInput {
  tracks: readonly Track[];
  trackId: string;
  clipId: string;
  name?: string;
  startTime: number;
  duration: number;
}

export type AdjustmentLayerResult =
  | { ok: true; tracks: Track[]; trackId: string; clipId: string }
  | { ok: false; message: string };

export function isAdjustmentTrack(track: Pick<Track, "type">): boolean {
  return track.type === "adjustment";
}

export function isAdjustmentClip(
  clip: Pick<Clip, "adjustmentLayer">,
  track?: Pick<Track, "type">
): boolean {
  return track
    ? isAdjustmentTrack(track) && clip.adjustmentLayer?.target === "below"
    : clip.adjustmentLayer?.target === "below";
}

export function validateAdjustmentClip(track: Track, clip: Clip): string | null {
  if (!isAdjustmentTrack(track)) return null;
  if (!isAdjustmentClip(clip, track)) {
    return `Adjustment clip ${clip.id} must declare adjustmentLayer.target = "below"`;
  }
  if (clip.sourceMediaId || clip.textParams || clip.shapeParams || clip.sourceSequenceId) {
    return `Adjustment clip ${clip.id} cannot contain media, text, shape, or a nested sequence`;
  }
  return null;
}

/** Pure creation primitive used by the UI and agent. */
export function createAdjustmentLayer(
  input: CreateAdjustmentLayerInput
): AdjustmentLayerResult {
  if (!input.trackId || !input.clipId) {
    return { ok: false, message: "trackId and clipId are required" };
  }
  if (!Number.isFinite(input.startTime) || input.startTime < 0) {
    return { ok: false, message: "startTime must be a non-negative finite number" };
  }
  if (!Number.isFinite(input.duration) || input.duration <= 0) {
    return { ok: false, message: "duration must be a positive finite number" };
  }

  const track: Track = {
    id: input.trackId,
    name: input.name?.trim() || "Adjustment Layer",
    type: "adjustment",
    order: input.tracks.length,
    locked: false,
    visible: true,
    solo: false,
    clips: [
      {
        id: input.clipId,
        trackId: input.trackId,
        sourceMediaId: null,
        startTime: input.startTime,
        duration: input.duration,
        sourceOffset: 0,
        speed: 1,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
        opacity: 1,
        blendMode: "normal",
        effects: [],
        keyframes: [],
        mask: null,
        adjustmentLayer: { ...DEFAULT_ADJUSTMENT_LAYER },
        muted: true,
        volume: 0,
      },
    ],
  };

  return {
    ok: true,
    tracks: [...input.tracks, track],
    trackId: track.id,
    clipId: input.clipId,
  };
}
