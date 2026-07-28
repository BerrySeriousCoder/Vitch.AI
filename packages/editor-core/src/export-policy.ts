import type { Track, Effect, Transition, Sequence } from "@tempo/types";
import { getEffectDefinition } from "./effect-registry";
import { getTransitionType } from "./transition-registry";
import { textHasKineticAnimators } from "./text-animators";
import { normalizeHold } from "./hold";
import { hasNestClips, isNestClip } from "./sequences";
import { isAdjustmentTrack } from "./adjustment-layer";
import { cropIsIdentity } from "./crop";

function finiteOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function trackNeedsFrameExport(tracks: readonly Track[]): boolean {
  for (const track of tracks) {
    // FFmpeg's simple path cannot apply a clip-local stack to the composed
    // result of all lower tracks. The shared WebGPU frame path can.
    if (isAdjustmentTrack(track) && track.clips.length > 0) return true;
    for (const clip of track.clips || []) {
      const transform = clip.transform;
      if (
        Math.abs(Number(transform?.x) || 0) > 0.0001 ||
        Math.abs(Number(transform?.y) || 0) > 0.0001 ||
        Math.abs(finiteOr(transform?.scaleX, 1) - 1) > 0.0001 ||
        Math.abs(finiteOr(transform?.scaleY, 1) - 1) > 0.0001 ||
        Math.abs(Number(transform?.rotation) || 0) > 0.0001 ||
        Math.abs(finiteOr(clip.opacity, 1) - 1) > 0.0001 ||
        clip.blendMode !== "normal"
      ) return true;
      // The simple FFmpeg path currently implements legacy contain only.
      // Any explicit alternate fit must use the shared geometry renderer.
      if (clip.mediaLayout && clip.mediaLayout.fit !== "contain") return true;
      // Format-aware base geometry is resolved by the shared canvas renderer;
      // the simple ASS path has no equivalent layout/safety contract.
      if (clip.layout) return true;
      // Parenting and luma/alpha mattes are evaluated by the shared WebGPU
      // compositor, so the simple FFmpeg graph must never silently drop them.
      if (clip.parentId || clip.trackMatte || clip.motionTrack || clip.planarTrack || clip.stabilization?.enabled || clip.multicam || clip.motionBlur?.enabled || clip.transform3D || clip.motionGraph) return true;
      if (clip.textParams?.captionPresetId || (clip.textParams?.backgroundRadius ?? 0) > 0) return true;
      if (clip.textParams?.fillGradient || clip.textParams?.fillEnabled === false || clip.textParams?.shadowStyle || clip.textParams?.glow) return true;
      if (clip.textParams?.richTextRuns?.length) return true;
      if (clip.lottieParams) return true;
      if (clip.shapeParams?.fillGradient || clip.shapeParams?.shadow || clip.shapeParams?.glow || clip.shapeParams?.shape === "path") return true;
      if (isNestClip(clip)) return true;
      if (clip.mask) return true;
      if (clip.chromaKey) return true;
      if (!cropIsIdentity(clip.crop)) return true;
      if (normalizeHold(clip.hold)) return true;
      if (clip.keyframes && clip.keyframes.length > 0) return true;
      if (textHasKineticAnimators(clip.textParams)) return true;
      if (clip.reversed === true || (Number(clip.speed) || 1) < 0) return true;
      if (clip.speedRamp && clip.speedRamp.length >= 2) return true;
      if (clip.retime?.interpolation === "frame-blend") return true;
      const effects = (clip.effects || []) as Effect[];
      for (const fx of effects) {
        if (fx.keyframes && fx.keyframes.length > 0) return true;
        if (fx.enabled === false) continue;
        const def = getEffectDefinition(fx.type);
        const backend = def?.exportBackend ?? "ffmpeg";
        if (backend === "approx" || backend === "frame") return true;
      }
    }
  }
  return false;
}

/**
 * True when export needs the headless WebGPU frame path.
 * Any nest clip on main forces frame export; also recurses into sequence contents.
 */
export function needsFrameExport(
  tracks: readonly Track[],
  transitions: readonly Transition[] = [],
  sequences: readonly Sequence[] = []
): boolean {
  if (hasNestClips(tracks)) return true;
  if (trackNeedsFrameExport(tracks)) return true;
  for (const seq of sequences) {
    if (trackNeedsFrameExport(seq.tracks || [])) return true;
    for (const tr of seq.transitions || []) {
      const def = getTransitionType(tr.type);
      if (def?.exportBackend === "frame") return true;
    }
  }
  for (const tr of transitions) {
    const def = getTransitionType(tr.type);
    if (def?.exportBackend === "frame") return true;
  }
  return false;
}
