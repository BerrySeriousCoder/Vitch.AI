export type PreviewMediaQuality = "auto" | "proxy" | "original";

export interface PreviewRenderDimensions {
  width: number;
  height: number;
  longEdge: number;
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** Size the GPU working set for the visible monitor, never final delivery. */
export function previewRenderDimensions(
  compositionWidth: number,
  compositionHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
  quality: PreviewMediaQuality
): PreviewRenderDimensions {
  const sourceWidth = Math.max(2, Math.round(compositionWidth) || 2);
  const sourceHeight = Math.max(2, Math.round(compositionHeight) || 2);
  const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
  const displayLongEdge = Math.max(0, viewportWidth, viewportHeight) * Math.max(1, devicePixelRatio || 1);
  const cap = quality === "original" ? 1920 : quality === "proxy" ? 960 : 1280;
  const floor = quality === "original" ? 960 : 720;
  const requestedLongEdge = displayLongEdge > 0 ? Math.max(floor, displayLongEdge) : cap;
  const longEdge = Math.min(sourceLongEdge, cap, requestedLongEdge);
  const scale = longEdge / sourceLongEdge;
  const width = even(sourceWidth * scale);
  const height = even(sourceHeight * scale);
  return { width, height, longEdge: Math.max(width, height) };
}
