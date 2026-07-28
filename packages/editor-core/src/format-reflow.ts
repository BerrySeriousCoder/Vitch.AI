import type { Clip, Keyframe, Track } from "@tempo/types";

export interface CompositionSize {
  width: number;
  height: number;
}

function validSize(size: CompositionSize): CompositionSize {
  return {
    width: Math.max(1, Number(size.width) || 1),
    height: Math.max(1, Number(size.height) || 1),
  };
}

function scaleKeyframe(keyframe: Keyframe, scaleX: number, scaleY: number): Keyframe {
  if (typeof keyframe.value !== "number") return keyframe;
  if (keyframe.property === "transform.x") return { ...keyframe, value: keyframe.value * scaleX };
  if (keyframe.property === "transform.y") return { ...keyframe, value: keyframe.value * scaleY };
  return keyframe;
}

function scaleClip(clip: Clip, scaleX: number, scaleY: number): Clip {
  const uniform = Math.min(scaleX, scaleY);
  const layout = clip.layout?.mode === "absolute"
    ? {
        ...clip.layout,
        x: clip.layout.x * scaleX,
        y: clip.layout.y * scaleY,
        width: clip.layout.width === undefined ? undefined : clip.layout.width * uniform,
        height: clip.layout.height === undefined ? undefined : clip.layout.height * uniform,
      }
    : clip.layout;
  return {
    ...clip,
    transform: {
      ...clip.transform,
      x: clip.transform.x * scaleX,
      y: clip.transform.y * scaleY,
      anchorX: clip.transform.anchorX * uniform,
      anchorY: clip.transform.anchorY * uniform,
    },
    transform3D: clip.transform3D
      ? {
          ...clip.transform3D,
          x: clip.transform3D.x * scaleX,
          y: clip.transform3D.y * scaleY,
          anchorX: clip.transform3D.anchorX * uniform,
          anchorY: clip.transform3D.anchorY * uniform,
        }
      : clip.transform3D,
    layout,
    keyframes: clip.keyframes.map((keyframe) => scaleKeyframe(keyframe, scaleX, scaleY)),
    textParams: clip.textParams
      ? {
          ...clip.textParams,
          fontSize: clip.textParams.fontSize * uniform,
          maxWidth: clip.textParams.maxWidth === undefined ? undefined : clip.textParams.maxWidth * uniform,
          strokeWidth: clip.textParams.strokeWidth === undefined ? undefined : clip.textParams.strokeWidth * uniform,
          backgroundPadding: clip.textParams.backgroundPadding === undefined ? undefined : clip.textParams.backgroundPadding * uniform,
          backgroundRadius: clip.textParams.backgroundRadius === undefined ? undefined : clip.textParams.backgroundRadius * uniform,
          richTextRuns: clip.textParams.richTextRuns?.map((run) => ({
            ...run,
            fontSize: run.fontSize === undefined ? undefined : run.fontSize * uniform,
            letterSpacing: run.letterSpacing === undefined ? undefined : run.letterSpacing * uniform,
          })),
        }
      : clip.textParams,
    shapeParams: clip.shapeParams
      ? {
          ...clip.shapeParams,
          width: clip.shapeParams.width * uniform,
          height: clip.shapeParams.height * uniform,
          strokeWidth: clip.shapeParams.strokeWidth * uniform,
          cornerRadius: clip.shapeParams.cornerRadius === undefined ? undefined : clip.shapeParams.cornerRadius * uniform,
        }
      : clip.shapeParams,
  };
}

/** Reflow pixel-space authoring when a delivery format changes. */
export function reflowTracksForComposition(
  tracks: readonly Track[],
  from: CompositionSize,
  to: CompositionSize
): Track[] {
  const source = validSize(from);
  const target = validSize(to);
  const scaleX = target.width / source.width;
  const scaleY = target.height / source.height;
  if (Math.abs(scaleX - 1) < 1e-9 && Math.abs(scaleY - 1) < 1e-9) {
    return tracks.map((track) => ({ ...track, clips: [...track.clips] }));
  }
  return tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => scaleClip(clip, scaleX, scaleY)),
  }));
}
