import { randomUUID } from "crypto";
import {
  applyColorMatchToClip,
  colorStatisticsFromPalette,
  deriveColorMatch,
  type ColorMatchProposal,
} from "@tempo/editor-core";
import type { Clip, ColorStatistics } from "@tempo/types";
import type { ProjectState } from "./project-state.js";

function findClip(state: ProjectState, clipId: string): Clip | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return null;
}

function colorStatisticsForClip(state: ProjectState, clip: Clip): ColorStatistics | null {
  if (!clip.sourceMediaId) return null;
  const asset = state.mediaAssets?.find((candidate) => candidate.id === clip.sourceMediaId);
  if (!asset) return null;
  return asset.metadata?.colorStatistics ||
    colorStatisticsFromPalette(asset.metadata?.analysis?.colorPalette);
}

function applyProposal(
  state: ProjectState,
  targetClipIds: string[],
  proposalFor: (clip: Clip) => ColorMatchProposal | null
): Array<{ clipId: string; effectId: string; created: boolean; confidence: number }> {
  const applied: Array<{ clipId: string; effectId: string; created: boolean; confidence: number }> = [];
  for (const targetClipId of targetClipIds) {
    const clip = findClip(state, targetClipId);
    if (!clip) continue;
    const proposal = proposalFor(clip);
    if (!proposal) continue;
    const result = applyColorMatchToClip(state.tracks, targetClipId, proposal, randomUUID);
    if ("ok" in result) continue;
    state.tracks = result.tracks;
    applied.push({ clipId: targetClipId, effectId: result.effectId, created: result.created, confidence: result.proposal.confidence });
  }
  return applied;
}

export const colorMatchToolDefinitions = [
  {
    name: "match_clip_color",
    description: "Match one or more timeline target clips to a timeline reference clip using decoded media color statistics (falling back to analyzed palettes). Applies a non-destructive Color Match primary grade to each target.",
    parameters: {
      type: "object" as const,
      properties: {
        referenceClipId: { type: "string", description: "Timeline clip whose color look should be matched" },
        targetClipIds: { type: "array", items: { type: "string" }, description: "One or more timeline clips to correct" },
        strength: { type: "number", description: "0..1 match amount; default 0.45 (quality-safe for 8-bit footage)" },
      },
      required: ["referenceClipId", "targetClipIds"],
    },
  },
  {
    name: "apply_reference_color_match",
    description: "Apply the decoded color profile from the current Edit Like This reference Style DNA to timeline target clips. Use after recreating clips from a reference video.",
    parameters: {
      type: "object" as const,
      properties: {
        targetClipIds: { type: "array", items: { type: "string" }, description: "Target clips; omit to match all video clips" },
        strength: { type: "number", description: "0..1 match amount; default 0.35 (quality-safe for 8-bit footage)" },
      },
    },
  },
];

export const colorMatchToolExecutors: Record<string, (args: Record<string, any>, state: ProjectState) => { result: string; state: ProjectState }> = {
  match_clip_color: (args, state) => {
    const referenceId = String(args.referenceClipId || "");
    const referenceClip = findClip(state, referenceId);
    if (!referenceClip) return { result: `Error: Reference clip ${referenceId} not found`, state };
    const reference = colorStatisticsForClip(state, referenceClip);
    if (!reference) return { result: "Error: Reference clip has no decoded color statistics or analyzed palette. Analyze its source media first.", state };
    const targetIds = Array.isArray(args.targetClipIds) ? args.targetClipIds.map(String).filter((id) => id && id !== referenceId) : [];
    if (targetIds.length === 0) return { result: "Error: targetClipIds must contain a clip other than the reference", state };
    const strength = Number(args.strength ?? 0.45);
    const applied = applyProposal(state, targetIds, (target) => {
      const targetStats = colorStatisticsForClip(state, target);
      return targetStats ? deriveColorMatch(reference, targetStats, strength) : null;
    });
    if (applied.length === 0) return { result: "Error: None of the target clips have decoded color statistics or analyzed palettes.", state };
    return { result: JSON.stringify({ ok: true, referenceClipId: referenceId, applied }), state };
  },

  apply_reference_color_match: (args, state) => {
    const reference = state.styleDna?.color.referenceStatistics;
    if (!reference) return { result: "Error: No decoded reference color profile. Run Edit Like This with a reference video first.", state };
    const explicitTargets = Array.isArray(args.targetClipIds) ? args.targetClipIds.map(String) : null;
    const candidates = explicitTargets || state.tracks
      .filter((track) => track.type === "video")
      .flatMap((track) => track.clips.map((clip) => clip.id));
    const targetIds = candidates.filter((clipId) => {
      const clip = findClip(state, clipId);
      if (!clip) return false;
      const binding = clip.referenceEditBinding;
      if (clip.trackMatte || binding?.kind === "support-layer") return false;
      if (binding?.kind === "composition-layer") {
        const segment = state.editBlueprint?.segments.find((candidate) => candidate.index === binding.segmentIndex);
        const layer = segment?.composition?.layers.find((candidate) => candidate.id === binding.layerId);
        if (layer?.role === "matte-fill") return false;
      }
      return true;
    });
    if (!explicitTargets && targetIds.length === 0) {
      return { result: "Error: No safe ordinary video targets were found; matte/support sources are excluded from automatic grading.", state };
    }
    const strength = Number(args.strength ?? 0.35);
    const applied = applyProposal(state, targetIds, (target) => {
      const targetStats = colorStatisticsForClip(state, target);
      return targetStats ? deriveColorMatch(reference, targetStats, strength) : null;
    });
    if (applied.length === 0) return { result: "Error: No target clips with usable color data were found.", state };
    return { result: JSON.stringify({ ok: true, source: "edit-like-this-reference", applied }), state };
  },
};
