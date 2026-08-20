import type { BlueprintSegment, EditBlueprint, ProjectSettings } from "@tempo/types";
import { resolveDeliveryProfile } from "@tempo/editor-core";

type TextOverlay = BlueprintSegment["textOverlays"][number];

export interface AdaptedTextLayout {
  overlays: TextOverlay[];
  adapted: boolean;
  warnings: string[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Transfer reference text as a group between delivery rasters. A uniform
 * pixel-space transform preserves hierarchy and relative spacing; a final
 * title-safe fit prevents the common 16:9 -> 9:16 collision/cropping failure.
 * The creative agent may reflow after this, but never receives an unsafe base.
 */
export function adaptTextOverlaysForDelivery(
  blueprint: Pick<EditBlueprint, "referenceWidth" | "referenceHeight" | "aspectRatio">,
  segment: BlueprintSegment,
  settings: ProjectSettings
): AdaptedTextLayout {
  const sourceWidth = Math.max(1, blueprint.referenceWidth || 16);
  const sourceHeight = Math.max(1, blueprint.referenceHeight || 9);
  const targetWidth = Math.max(1, settings.width);
  const targetHeight = Math.max(1, settings.height);
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  const measured = segment.textOverlays
    .map((overlay, index) => ({ overlay, index }))
    .filter(({ overlay }) => overlay.geometry?.width && overlay.geometry.height);
  if (!measured.length || Math.abs(Math.log(sourceAspect / targetAspect)) < 0.06) {
    return { overlays: segment.textOverlays, adapted: false, warnings: [] };
  }

  const profile = resolveDeliveryProfile(settings);
  const safe = profile.titleSafe;
  const boxes = measured.map(({ overlay, index }) => {
    const geometry = overlay.geometry!;
    const width = geometry.width! * sourceWidth;
    const height = geometry.height! * sourceHeight;
    const cx = geometry.x * sourceWidth;
    const cy = geometry.y * sourceHeight;
    return { index, cx, cy, width, height };
  });
  const parent = boxes.map((_box, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]!));
  const join = (left: number, right: number) => { parent[root(right)] = root(left); };
  const lifetime = (overlay: TextOverlay) => [overlay.timing?.startRatio ?? 0, overlay.timing?.endRatio ?? 1] as const;
  for (let left = 0; left < measured.length; left++) {
    for (let right = left + 1; right < measured.length; right++) {
      const a = measured[left]!.overlay;
      const b = measured[right]!.overlay;
      const [aStart, aEnd] = lifetime(a);
      const [bStart, bEnd] = lifetime(b);
      const sameSequence = Boolean(a.sequenceGroupId && a.sequenceGroupId === b.sequenceGroupId);
      const coVisible = Math.max(aStart, bStart) <= Math.min(aEnd, bEnd) + 0.001;
      if (sameSequence || coVisible) join(left, right);
    }
  }
  const groups = new Map<number, typeof boxes>();
  for (let position = 0; position < boxes.length; position++) {
    const key = root(position);
    const group = groups.get(key) || [];
    group.push(boxes[position]!);
    groups.set(key, group);
  }
  const adaptedGeometry = new Map<number, NonNullable<TextOverlay["geometry"]>>();
  for (const group of groups.values()) {
    const left = Math.min(...group.map((box) => box.cx - box.width / 2));
    const right = Math.max(...group.map((box) => box.cx + box.width / 2));
    const top = Math.min(...group.map((box) => box.cy - box.height / 2));
    const bottom = Math.max(...group.map((box) => box.cy + box.height / 2));
    const groupWidth = Math.max(1, right - left);
    const groupHeight = Math.max(1, bottom - top);
    const baseScale = targetHeight / sourceHeight;
    const scale = Math.min(baseScale, safe.width * targetWidth / groupWidth, safe.height * targetHeight / groupHeight);
    const sourceCenterX = (left + right) / 2;
    const sourceCenterY = (top + bottom) / 2;
    const fittedHalfWidth = groupWidth * scale / 2;
    const fittedHalfHeight = groupHeight * scale / 2;
    const targetCenterX = clamp(
      clamp(sourceCenterX / sourceWidth, safe.x, safe.x + safe.width) * targetWidth,
      safe.x * targetWidth + fittedHalfWidth,
      (safe.x + safe.width) * targetWidth - fittedHalfWidth
    );
    const targetCenterY = clamp(
      clamp(sourceCenterY / sourceHeight, safe.y, safe.y + safe.height) * targetHeight,
      safe.y * targetHeight + fittedHalfHeight,
      (safe.y + safe.height) * targetHeight - fittedHalfHeight
    );
    for (const box of group) {
      adaptedGeometry.set(box.index, {
        ...segment.textOverlays[box.index]!.geometry!,
        x: clamp((targetCenterX + (box.cx - sourceCenterX) * scale) / targetWidth, 0, 1),
        y: clamp((targetCenterY + (box.cy - sourceCenterY) * scale) / targetHeight, 0, 1),
        width: clamp(box.width * scale / targetWidth, 0.001, 1),
        height: clamp(box.height * scale / targetHeight, 0.001, 1),
      });
    }
  }
  const overlays = segment.textOverlays.map((overlay, index) => {
    const geometry = adaptedGeometry.get(index);
    return geometry ? { ...overlay, geometry } : overlay;
  });
  return {
    overlays,
    adapted: true,
    warnings: [
      `ADAPTED_TEXT_LAYOUT: scene ${segment.index} ${sourceWidth}x${sourceHeight}->${targetWidth}x${targetHeight}; preserved ${groups.size} temporal text group(s) and fitted title-safe bounds`,
    ],
  };
}
