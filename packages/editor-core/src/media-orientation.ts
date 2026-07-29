import type { MediaAsset, MediaMetadata, MediaOrientation } from "@tempo/types";

export interface MediaDisplayGeometry {
  width?: number;
  height?: number;
  aspectRatio?: number;
  orientation: MediaOrientation;
}

/** Classify display orientation with a square tolerance to avoid noisy near-square files. */
export function orientationFromDimensions(
  width: number | null | undefined,
  height: number | null | undefined
): MediaOrientation {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return "unknown";
  const ratio = w / h;
  if (ratio > 1.1) return "landscape";
  if (ratio < 1 / 1.1) return "portrait";
  return "square";
}

/** Use display dimensions first so phone rotation metadata cannot invert orientation. */
export function mediaDisplayGeometry(
  metadata: Partial<MediaMetadata> | Record<string, unknown> | null | undefined
): MediaDisplayGeometry {
  const meta = (metadata || {}) as Partial<MediaMetadata>;
  const width = Number(meta.displayWidth) > 0 ? Number(meta.displayWidth) : Number(meta.width) || undefined;
  const height = Number(meta.displayHeight) > 0 ? Number(meta.displayHeight) : Number(meta.height) || undefined;
  const orientation = orientationFromDimensions(width, height);
  return {
    width,
    height,
    aspectRatio: width && height ? width / height : undefined,
    orientation: orientation === "unknown" ? meta.orientation || "unknown" : orientation,
  };
}

export function mediaAssetOrientation(asset: Pick<MediaAsset, "metadata">): MediaOrientation {
  return mediaDisplayGeometry(asset.metadata).orientation;
}

export function orientationMatches(
  source: MediaOrientation,
  target: MediaOrientation
): boolean {
  if (source === "unknown" || target === "unknown") return true;
  return source === target;
}

/** Approximate source area retained by a center-cover crop. Higher is safer. */
export function coverRetention(
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
  targetWidth: number | undefined,
  targetHeight: number | undefined
): number | undefined {
  if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) return undefined;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  return Math.min(sourceRatio, targetRatio) / Math.max(sourceRatio, targetRatio);
}
