/** A small deterministic translational optical-flow solver for downscaled luma frames. */
export interface OpticalFlowVector { dx: number; dy: number; confidence: number; }

/**
 * Tracks a small textured patch between two luma frames. Unlike the global
 * solver this is intentionally local, so four independent points can follow
 * a perspective-changing planar surface.
 */
export function estimateFeatureTranslation(
  previous: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  patchRadius = 6,
  searchRadius = 8
): OpticalFlowVector {
  if (previous.length !== current.length || previous.length !== width * height || width < 24 || height < 24) {
    return { dx: 0, dy: 0, confidence: 0 };
  }
  const cx = Math.round(centerX);
  const cy = Math.round(centerY);
  const edge = patchRadius + searchRadius + 1;
  if (cx < edge || cy < edge || cx >= width - edge || cy >= height - edge) return { dx: 0, dy: 0, confidence: 0 };
  let bestDx = 0, bestDy = 0, bestCost = Number.POSITIVE_INFINITY, secondCost = Number.POSITIVE_INFINITY;
  for (let dy = -searchRadius; dy <= searchRadius; dy++) for (let dx = -searchRadius; dx <= searchRadius; dx++) {
    let cost = 0;
    for (let py = -patchRadius; py <= patchRadius; py++) for (let px = -patchRadius; px <= patchRadius; px++) {
      cost += Math.abs(previous[(cy + py) * width + cx + px]! - current[(cy + dy + py) * width + cx + dx + px]!);
    }
    if (cost < bestCost) { secondCost = bestCost; bestCost = cost; bestDx = dx; bestDy = dy; }
    else if (cost < secondCost) secondCost = cost;
  }
  return { dx: bestDx, dy: bestDy, confidence: Math.max(0, Math.min(1, (secondCost - bestCost) / Math.max(1, secondCost))) };
}

export function estimateTranslationalFlow(
  previous: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
  searchRadius = 8
): OpticalFlowVector {
  if (previous.length !== current.length || previous.length !== width * height || width < 24 || height < 24) {
    return { dx: 0, dy: 0, confidence: 0 };
  }
  // Inputs are deliberately decoded at a small analysis resolution. Dense
  // sampling avoids grid-aliasing on small/high-contrast features.
  const step = 1;
  const margin = searchRadius + 3;
  let bestDx = 0, bestDy = 0, bestCost = Number.POSITIVE_INFINITY, secondCost = Number.POSITIVE_INFINITY;
  for (let dy = -searchRadius; dy <= searchRadius; dy++) for (let dx = -searchRadius; dx <= searchRadius; dx++) {
    let cost = 0, count = 0;
    for (let y = margin; y < height - margin; y += step) for (let x = margin; x < width - margin; x += step) {
      const before = previous[y * width + x]!;
      const after = current[(y + dy) * width + x + dx]!;
      cost += Math.abs(before - after); count++;
    }
    const mean = cost / count;
    if (mean < bestCost) { secondCost = bestCost; bestCost = mean; bestDx = dx; bestDy = dy; }
    else if (mean < secondCost) secondCost = mean;
  }
  return { dx: bestDx, dy: bestDy, confidence: Math.max(0, Math.min(1, (secondCost - bestCost) / Math.max(1, secondCost))) };
}
