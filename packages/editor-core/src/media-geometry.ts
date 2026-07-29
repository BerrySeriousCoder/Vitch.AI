import type { Crop, Keyframe, MediaFit, MediaLayout, MediaViewport } from "@tempo/types";
import { normalizeCrop } from "./crop";
import { resolveKeyframeValues } from "./keyframes";

export interface MediaGeometryInput {
  sourceWidth: number;
  sourceHeight: number;
  compositionWidth: number;
  compositionHeight: number;
  crop?: Crop | null;
  mediaLayout?: MediaLayout | null;
}

export interface MediaGeometryRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolvedMediaGeometry {
  fit: MediaFit;
  sourceUvRect: Crop;
  destinationRect: MediaGeometryRect;
  /** True only for the explicit `fill` mode with unlike aspect ratios. */
  distortsAspectRatio: boolean;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function focalPoint(layout?: MediaLayout | null): { x: number; y: number } {
  return {
    x: clamp(Number(layout?.focalPoint?.x ?? 0.5), 0, 1),
    y: clamp(Number(layout?.focalPoint?.y ?? 0.5), 0, 1),
  };
}

function centeredRect(width: number, height: number, compositionWidth: number, compositionHeight: number): MediaGeometryRect {
  return {
    x: (compositionWidth - width) / 2,
    y: (compositionHeight - height) / 2,
    width,
    height,
  };
}

export function normalizeMediaViewport(input?: Partial<MediaViewport> | null): MediaViewport {
  const x = clamp(Number(input?.x ?? 0), 0, 0.999);
  const y = clamp(Number(input?.y ?? 0), 0, 0.999);
  const width = clamp(Number(input?.width ?? 1), 0.001, 1 - x);
  const height = clamp(Number(input?.height ?? 1), 0.001, 1 - y);
  return { x, y, width, height };
}

export function validateMediaViewport(
  input: Partial<MediaViewport> | null | undefined
): { ok: true; value: MediaViewport } | { ok: false; message: string } {
  if (!input || typeof input !== "object") return { ok: false, message: "viewport must be an object" };
  const values = [input.x, input.y, input.width, input.height].map(Number);
  if (!values.every(Number.isFinite)) return { ok: false, message: "viewport values must be finite numbers" };
  const [x, y, width, height] = values as [number, number, number, number];
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    return { ok: false, message: "viewport must have positive size and remain inside normalized composition bounds" };
  }
  return { ok: true, value: { x, y, width, height } };
}

/** Resolve an animated destination cell without changing source pixels or aspect ratio. */
export function resolveMediaLayoutAtTime(
  layout: MediaLayout | null | undefined,
  keyframes: readonly Keyframe[],
  timeInClip: number
): MediaLayout | null | undefined {
  if (!layout) return layout;
  const values = resolveKeyframeValues([...keyframes], timeInClip);
  const base = normalizeMediaViewport(layout.viewport);
  const hasViewportAnimation = ["x", "y", "width", "height"].some(
    (property) => values[`mediaLayout.viewport.${property}`] !== undefined
  );
  if (!layout.viewport && !hasViewportAnimation) return layout;
  return {
    ...layout,
    viewport: normalizeMediaViewport({
      x: Number(values["mediaLayout.viewport.x"] ?? base.x),
      y: Number(values["mediaLayout.viewport.y"] ?? base.y),
      width: Number(values["mediaLayout.viewport.width"] ?? base.width),
      height: Number(values["mediaLayout.viewport.height"] ?? base.height),
    }),
  };
}

function cropAroundFocal(base: Crop, width: number, height: number, focal: { x: number; y: number }): Crop {
  const x = clamp(focal.x - width / 2, base.x, base.x + base.width - width);
  const y = clamp(focal.y - height / 2, base.y, base.y + base.height - height);
  return normalizeCrop({ x, y, width, height });
}

/**
 * Canonical media placement shared by preview and export.
 * Crop changes the effective source aspect before fit is resolved.
 */
export function resolveMediaGeometry(input: MediaGeometryInput): ResolvedMediaGeometry {
  const sourceWidth = positive(input.sourceWidth, 1);
  const sourceHeight = positive(input.sourceHeight, 1);
  const compositionWidth = positive(input.compositionWidth, 1);
  const compositionHeight = positive(input.compositionHeight, 1);
  const viewport = normalizeMediaViewport(input.mediaLayout?.viewport);
  const targetRect = {
    x: viewport.x * compositionWidth,
    y: viewport.y * compositionHeight,
    width: viewport.width * compositionWidth,
    height: viewport.height * compositionHeight,
  };
  const baseCrop = normalizeCrop(input.crop);
  const fit: MediaFit = input.mediaLayout?.fit ?? "contain";
  const croppedWidth = sourceWidth * baseCrop.width;
  const croppedHeight = sourceHeight * baseCrop.height;
  const sourceRatio = croppedWidth / croppedHeight;
  const compositionRatio = targetRect.width / targetRect.height;

  if (fit === "fill") {
    return {
      fit,
      sourceUvRect: baseCrop,
      destinationRect: targetRect,
      distortsAspectRatio: Math.abs(sourceRatio - compositionRatio) > 0.0001,
    };
  }

  if (fit === "cover") {
    let sourceUvRect = baseCrop;
    if (sourceRatio > compositionRatio) {
      const width = baseCrop.height * compositionRatio / (sourceWidth / sourceHeight);
      sourceUvRect = cropAroundFocal(baseCrop, width, baseCrop.height, focalPoint(input.mediaLayout));
    } else if (sourceRatio < compositionRatio) {
      const height = baseCrop.width * (sourceWidth / sourceHeight) / compositionRatio;
      sourceUvRect = cropAroundFocal(baseCrop, baseCrop.width, height, focalPoint(input.mediaLayout));
    }
    return {
      fit,
      sourceUvRect,
      destinationRect: targetRect,
      distortsAspectRatio: false,
    };
  }

  if (fit === "none") {
    return {
      fit,
      sourceUvRect: baseCrop,
      destinationRect: {
        x: targetRect.x + (targetRect.width - croppedWidth) / 2,
        y: targetRect.y + (targetRect.height - croppedHeight) / 2,
        width: croppedWidth,
        height: croppedHeight,
      },
      distortsAspectRatio: false,
    };
  }

  const scale = Math.min(targetRect.width / croppedWidth, targetRect.height / croppedHeight);
  const containedWidth = croppedWidth * scale;
  const containedHeight = croppedHeight * scale;
  return {
    fit: "contain",
    sourceUvRect: baseCrop,
    destinationRect: {
      x: targetRect.x + (targetRect.width - containedWidth) / 2,
      y: targetRect.y + (targetRect.height - containedHeight) / 2,
      width: containedWidth,
      height: containedHeight,
    },
    distortsAspectRatio: false,
  };
}
