import type {
  BlueprintMediaLayer,
  BlueprintSegment,
  EditBlueprint,
  ReferenceAnalysisEvidence,
} from "@tempo/types";
import { GOOGLE_FONT_CATALOG, matchGoogleFontFamily } from "@tempo/editor-core";

export type BlueprintIssueSeverity = "warning" | "error";

export interface BlueprintIntegrityIssue {
  severity: BlueprintIssueSeverity;
  code: string;
  message: string;
  segmentIndex: number;
  layerId?: string;
  overlayIndex?: number;
  range: [number, number];
}

export interface BlueprintIntegrityReport {
  ok: boolean;
  issues: BlueprintIntegrityIssue[];
  focusRanges: Array<{ startTime: number; endTime: number; issueCodes: string[] }>;
}

export interface BlueprintIntegrityOptions {
  /**
   * The sampled-frame fallback cannot measure dense internal motion. Keep
   * referential/compositing errors fatal, but report measurement omissions as
   * warnings so an upstream Files API permission failure does not make the
   * entire coarse blueprint unusable.
   */
  allowDegradedMeasurements?: boolean;
  /** Cross-field depth/lifetime contradictions are normalized after the model pass. */
  allowRepairableSemantics?: boolean;
}

const DEGRADED_MEASUREMENT_CODES = new Set([
  "TEXT_SIZE_UNMEASURED",
  "PANEL_MOTION_REQUIRED",
  "GRID_FINAL_OCCUPANCY_INCOMPLETE",
  "VISIBLE_LAYER_COUNT_MISMATCH",
  "INTERNAL_EVENTS_UNMODELED",
]);

const REPAIRABLE_SEMANTIC_CODES = new Set([
  "MATTE_Z_MISMATCH",
  "OCCLUDED_BACKGROUND_MISSING",
  "OCCLUSION_Z_ORDER_INVALID",
]);

function rangeFor(segment: BlueprintSegment): [number, number] {
  return [segment.startTime, segment.startTime + segment.duration];
}

function differs(a: number | undefined, b: number | undefined, tolerance = 0.02): boolean {
  if (a === undefined && b === undefined) return false;
  if (a === undefined || b === undefined) return true;
  return Math.abs(a - b) > tolerance;
}

export function hasGeometryChange(layer: BlueprintMediaLayer): boolean {
  const keyframes = layer.motion?.keyframes || [];
  if (keyframes.length < 2) return false;
  const first = keyframes[0]!;
  return keyframes.slice(1).some((next) =>
    differs(first.viewport?.x, next.viewport?.x) ||
    differs(first.viewport?.y, next.viewport?.y) ||
    differs(first.viewport?.width, next.viewport?.width) ||
    differs(first.viewport?.height, next.viewport?.height) ||
    differs(first.offsetXRatio, next.offsetXRatio) ||
    differs(first.offsetYRatio, next.offsetYRatio) ||
    differs(first.scaleX, next.scaleX) ||
    differs(first.scaleY, next.scaleY) ||
    differs(first.rotation, next.rotation) ||
    differs(first.opacity, next.opacity)
  );
}

function linkedMatte(
  segment: BlueprintSegment,
  overlayIndex: number
): BlueprintMediaLayer | undefined {
  return segment.composition?.layers.find((layer) =>
    layer.role === "matte-fill" && layer.matteTextOverlayIndex === overlayIndex
  );
}

function phaseDescribesTextOcclusion(label: string): boolean {
  return /(?:cover|occlud|in front of|above).*(?:text|title|word|letter|glyph)|(?:text|title|word|letter|glyph).*(?:cover|occlud|behind|under)/i.test(label);
}

function appearsAnimated(layer: BlueprintMediaLayer, segment: BlueprintSegment): boolean {
  if (layer.timing.startRatio > 0.01) return true;
  const description = `${segment.visualDescription} ${layer.contentDescription}`.toLowerCase();
  return /enter|appear|reveal|grow|expand|slide|animate|move|wipe/.test(description);
}

function maximumActiveLayers(segment: BlueprintSegment): number {
  const phases = segment.composition?.phases;
  if (!phases?.length) return segment.composition?.layers.length || 0;
  return phases.reduce((max, phase) => Math.max(max, phase.activeLayerIds.length), 0);
}

function looksLikeGrid(segment: BlueprintSegment): boolean {
  const panels = segment.composition?.layers.filter((layer) => layer.role === "panel") || [];
  if (panels.length < 2) return false;
  return panels.some((layer) => layer.viewport.width <= 0.55 && layer.viewport.height <= 0.55) ||
    /grid|collage|quadrant|split.?screen|2x2/i.test(segment.visualDescription);
}

function evidenceFor(evidence: ReferenceAnalysisEvidence | undefined, segmentIndex: number) {
  return evidence?.scenes.find((scene) => scene.sceneIndex === segmentIndex);
}

function normalizedFontFamily(value: string | undefined): string {
  return String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function geometryFontWidth(
  overlay: BlueprintSegment["textOverlays"][number],
  referenceWidth: number,
  referenceHeight: number
): "condensed" | "normal" | "wide" | undefined {
  const geometry = overlay.geometry;
  const characterCount = Array.from(overlay.text.replace(/\s+/g, "")).length;
  if (!geometry?.width || !geometry.height || characterCount < 4) return undefined;
  const averageAdvance = geometry.width * referenceWidth /
    Math.max(1, characterCount * geometry.height * referenceHeight);
  if (averageAdvance < 0.52) return "condensed";
  if (averageAdvance > 0.61) return "wide";
  return "normal";
}

function variance(values: number[]): number {
  if (!values.length) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
}

function normalizeCumulativeTextGeometry(
  overlays: BlueprintSegment["textOverlays"],
  segmentIndex: number,
  warnings: string[]
): BlueprintSegment["textOverlays"] {
  const measured = overlays.filter((overlay) => overlay.geometry?.width && overlay.geometry.height);
  const cumulative = measured.length >= 3 && measured.slice(1).every((overlay, index) =>
    overlay.text.startsWith(measured[index]!.text)
  );
  if (!cumulative) return overlays;
  const reportedX = measured.map((overlay) => overlay.geometry!.x);
  const boxCenterX = measured.map((overlay) => overlay.geometry!.x + overlay.geometry!.width! / 2);
  const reportedRange = Math.max(...reportedX) - Math.min(...reportedX);
  if (reportedRange < 0.08 || variance(boxCenterX) >= variance(reportedX) * 0.25) return overlays;
  warnings.push(`NORMALIZED_TEXT_BOX_ORIGIN: scene ${segmentIndex} converted cumulative text boxes to center coordinates`);
  return overlays.map((overlay) => overlay.geometry?.width && overlay.geometry.height
    ? {
        ...overlay,
        geometry: {
          ...overlay.geometry,
          x: overlay.geometry.x + overlay.geometry.width / 2,
          y: overlay.geometry.y + overlay.geometry.height / 2,
        },
      }
    : overlay);
}

function normalizedOverlayText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * A title visible at the end of one scene and the start of the next is one
 * editorial object even when two provider chunks described it independently.
 * Canonicalize only its typography/style; timing, geometry, animation and
 * depth remain scene-specific because those may legitimately change at a cut.
 */
function reconcileBoundaryTypography(
  segments: BlueprintSegment[],
  warnings: string[]
): BlueprintSegment[] {
  const reconciled = segments.map((segment) => ({
    ...segment,
    textOverlays: segment.textOverlays.map((overlay) => ({
      ...overlay,
      ...(overlay.appearance ? { appearance: { ...overlay.appearance } } : {}),
    })),
  }));
  for (let index = 0; index < reconciled.length - 1; index++) {
    const left = reconciled[index]!;
    const right = reconciled[index + 1]!;
    for (const leftOverlay of left.textOverlays) {
      if ((leftOverlay.timing?.endRatio ?? 1) < 0.98) continue;
      const key = normalizedOverlayText(leftOverlay.text);
      if (!key) continue;
      const rightOverlay = right.textOverlays.find((candidate) =>
        (candidate.timing?.startRatio ?? 0) <= 0.02 &&
        normalizedOverlayText(candidate.text) === key &&
        (!leftOverlay.sequenceGroupId || !candidate.sequenceGroupId ||
          leftOverlay.sequenceGroupId === candidate.sequenceGroupId)
      );
      if (!rightOverlay || !leftOverlay.appearance || !rightOverlay.appearance) continue;
      const leftConfidence = leftOverlay.appearance.confidence ?? 0;
      const rightConfidence = rightOverlay.appearance.confidence ?? 0;
      const authority = rightConfidence > leftConfidence ? rightOverlay : leftOverlay;
      const follower = authority === leftOverlay ? rightOverlay : leftOverlay;
      const changed = JSON.stringify(follower.appearance) !== JSON.stringify(authority.appearance) ||
        follower.style !== authority.style || follower.backgroundMode !== authority.backgroundMode;
      if (!changed) continue;
      follower.appearance = { ...authority.appearance };
      follower.style = authority.style;
      follower.backgroundMode = authority.backgroundMode;
      warnings.push(
        `NORMALIZED_BOUNDARY_TYPOGRAPHY: scenes ${left.index}->${right.index} retained “${authority.text}” as one style`
      );
    }
  }
  return reconciled;
}

export function validateBlueprintIntegrity(
  blueprint: Pick<EditBlueprint, "segments" | "analysisEvidence">,
  options: BlueprintIntegrityOptions = {}
): BlueprintIntegrityReport {
  const issues: BlueprintIntegrityIssue[] = [];
  const push = (
    segment: BlueprintSegment,
    issue: Omit<BlueprintIntegrityIssue, "segmentIndex" | "range">
  ) => issues.push({
    ...issue,
    severity:
      (options.allowDegradedMeasurements && DEGRADED_MEASUREMENT_CODES.has(issue.code)) ||
      (options.allowRepairableSemantics && REPAIRABLE_SEMANTIC_CODES.has(issue.code))
        ? "warning"
        : issue.severity,
    segmentIndex: segment.index,
    range: rangeFor(segment),
  });

  for (const segment of blueprint.segments) {
    const composition = segment.composition;
    const ids = new Set(composition?.layers.map((layer) => layer.id) || []);
    for (let overlayIndex = 0; overlayIndex < segment.textOverlays.length; overlayIndex++) {
      const overlay = segment.textOverlays[overlayIndex]!;
      if (overlay.fillMode === "media-matte") {
        const matte = linkedMatte(segment, overlayIndex);
        if (!matte) push(segment, {
          severity: "error",
          code: "MATTE_FILL_REQUIRED",
          message: `Media-filled text ${overlayIndex} has no linked matte-fill layer`,
          overlayIndex,
        });
        if (matte && overlay.zIndex !== undefined && matte.zIndex !== overlay.zIndex) {
          push(segment, {
            severity: "error",
            code: "MATTE_Z_MISMATCH",
            message: `Media-filled text ${overlayIndex} uses zIndex ${overlay.zIndex} but its visible matte layer ${matte.id} uses ${matte.zIndex}`,
            layerId: matte.id,
            overlayIndex,
          });
        }
      }
      if (
        !overlay.appearance?.fontSizeRatio &&
        !overlay.geometry?.height &&
        !overlay.geometry?.width
      ) push(segment, {
        severity: "error",
        code: "TEXT_SIZE_UNMEASURED",
        message: `Text ${overlayIndex} has neither a font-size ratio nor measurable glyph geometry`,
        overlayIndex,
      });
    }
    for (const layer of composition?.layers || []) {
      if (layer.role === "matte-fill" && layer.matteTextOverlayIndex === undefined) {
        push(segment, {
          severity: "error",
          code: "MATTE_SOURCE_REQUIRED",
          message: `Matte-fill layer ${layer.id} is not linked to a text overlay`,
          layerId: layer.id,
        });
      }
      if (layer.matteTextOverlayIndex !== undefined && !segment.textOverlays[layer.matteTextOverlayIndex]) {
        push(segment, {
          severity: "error",
          code: "MATTE_SOURCE_INVALID",
          message: `Layer ${layer.id} references missing text overlay ${layer.matteTextOverlayIndex}`,
          layerId: layer.id,
        });
      }
      if (layer.role === "panel" && appearsAnimated(layer, segment) && !hasGeometryChange(layer)) {
        push(segment, {
          severity: "error",
          code: "PANEL_MOTION_REQUIRED",
          message: `Panel ${layer.id} appears during the scene but has no measured entrance geometry`,
          layerId: layer.id,
        });
      }
    }
    for (const phase of composition?.phases || []) {
      for (const id of phase.activeLayerIds) {
        if (!ids.has(id)) push(segment, {
          severity: "error",
          code: "PHASE_LAYER_MISSING",
          message: `Composition phase ${phase.id} references unknown layer ${id}`,
          layerId: id,
        });
      }
      for (const overlayIndex of phase.activeTextOverlayIndices) {
        if (!segment.textOverlays[overlayIndex]) push(segment, {
          severity: "error",
          code: "PHASE_TEXT_MISSING",
          message: `Composition phase ${phase.id} references unknown text overlay ${overlayIndex}`,
          overlayIndex,
        });
      }
      if (phaseDescribesTextOcclusion(phase.label)) {
        const activePanels = (composition?.layers || []).filter((layer) =>
          layer.role === "panel" && phase.activeLayerIds.includes(layer.id)
        );
        const activeText = phase.activeTextOverlayIndices
          .map((overlayIndex) => ({ overlayIndex, overlay: segment.textOverlays[overlayIndex] }))
          .filter((entry) => Boolean(entry.overlay));
        if (activePanels.length && activeText.length === 0) {
          push(segment, {
            severity: "error",
            code: "OCCLUDED_BACKGROUND_MISSING",
            message: `Composition phase ${phase.id} says panels cover text, but the underlying text is not active during the covering motion`,
          });
        }
        for (const panel of activePanels) {
          for (const { overlayIndex, overlay } of activeText) {
            const matte = linkedMatte(segment, overlayIndex);
            const backgroundZ = Math.max(overlay!.zIndex ?? matte?.zIndex ?? -100, matte?.zIndex ?? -100);
            if (panel.zIndex <= backgroundZ) push(segment, {
              severity: "error",
              code: "OCCLUSION_Z_ORDER_INVALID",
              message: `Phase ${phase.id} says ${panel.id} covers text ${overlayIndex}, but panel zIndex ${panel.zIndex} is not above the text composite zIndex ${backgroundZ}`,
              layerId: panel.id,
              overlayIndex,
            });
          }
        }
      }
    }
    const local = evidenceFor(blueprint.analysisEvidence, segment.index);
    if (looksLikeGrid(segment) && !composition?.phases?.length) {
      push(segment, {
        severity: "error",
        code: "GRID_PHASES_REQUIRED",
        message: "Multi-panel grid has no explicit simultaneous visibility phases",
      });
    }
    if (looksLikeGrid(segment) && maximumActiveLayers(segment) < (composition?.layers.filter((layer) => layer.role === "panel").length || 0)) {
      push(segment, {
        severity: "error",
        code: "GRID_FINAL_OCCUPANCY_INCOMPLETE",
        message: "The final composition phase never activates every measured panel simultaneously",
      });
    }
    if (
      local && local.maxVisibleComponents >= 4 &&
      composition && maximumActiveLayers(segment) < 4
    ) push(segment, {
      severity: "error",
      code: "VISIBLE_LAYER_COUNT_MISMATCH",
      message: `Local pixels show at least ${local.maxVisibleComponents} simultaneous surfaces but the blueprint activates only ${maximumActiveLayers(segment)}`,
    });
    if (
      local && local.eventTimes.length >= 2 &&
      composition?.layers.some((layer) => layer.role === "panel") &&
      composition.layers.every((layer) => layer.role !== "panel" || !hasGeometryChange(layer))
    ) push(segment, {
      severity: "error",
      code: "INTERNAL_EVENTS_UNMODELED",
      message: `Local analysis measured ${local.eventTimes.length} internal visual events but panel motion is absent`,
    });
  }

  const byRange = new Map<string, { startTime: number; endTime: number; issueCodes: string[] }>();
  for (const issue of issues.filter((candidate) => candidate.severity === "error")) {
    const key = `${issue.range[0]}:${issue.range[1]}`;
    const current = byRange.get(key) || { startTime: issue.range[0], endTime: issue.range[1], issueCodes: [] };
    if (!current.issueCodes.includes(issue.code)) current.issueCodes.push(issue.code);
    byRange.set(key, current);
  }
  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
    focusRanges: [...byRange.values()],
  };
}

/**
 * Resolve cross-field contradictions which have one unambiguous interpretation.
 * This does not invent visual motion: it only keeps a text/matte composite on a
 * single global depth and preserves explicitly described occluded backgrounds.
 */
export function reconcileBlueprintSemantics(
  blueprint: EditBlueprint
): { blueprint: EditBlueprint; warnings: string[] } {
  const warnings: string[] = [];
  const segments = blueprint.segments.map((segment) => {
    const composition = segment.composition;
    const textOverlays = normalizeCumulativeTextGeometry(segment.textOverlays.map((overlay) => ({
      ...overlay,
      ...(overlay.timing ? { timing: { ...overlay.timing } } : {}),
    })), segment.index, warnings);
    const referenceWidth = Math.max(1, blueprint.referenceWidth || 16);
    const referenceHeight = Math.max(1, blueprint.referenceHeight || 9);
    for (let overlayIndex = 0; overlayIndex < textOverlays.length; overlayIndex++) {
      const overlay = textOverlays[overlayIndex]!;
      const measuredWidth = geometryFontWidth(overlay, referenceWidth, referenceHeight);
      if (!measuredWidth || !overlay.appearance) continue;
      const hint = normalizedFontFamily(overlay.appearance.fontFamilyHint);
      const hintedFont = GOOGLE_FONT_CATALOG.find((font) => normalizedFontFamily(font.family) === hint);
      const hintedWidth = hintedFont?.width || "normal";
      let fontFamilyHint = overlay.appearance.fontFamilyHint;
      if (hintedFont && hintedWidth !== measuredWidth) {
        fontFamilyHint = matchGoogleFontFamily({
          category: overlay.appearance.fontFamilyClass,
          width: measuredWidth,
          role: "title",
        });
        warnings.push(
          `NORMALIZED_FONT_GEOMETRY: scene ${segment.index} text ${overlayIndex} ` +
          `${overlay.appearance.fontFamilyHint || "unknown"}->${fontFamilyHint} (${measuredWidth})`
        );
      }
      overlay.appearance = {
        ...overlay.appearance,
        fontWidth: measuredWidth,
        ...(fontFamilyHint ? { fontFamilyHint } : {}),
      };
    }
    const cumulativeTypography = textOverlays.length >= 3 && textOverlays.slice(1).every((overlay, index) =>
      overlay.text.startsWith(textOverlays[index]!.text)
    );
    const typographyAuthority = cumulativeTypography ? textOverlays.at(-1)?.appearance : undefined;
    if (typographyAuthority?.fontFamilyHint && typographyAuthority.fontWidth) {
      let propagated = false;
      for (const overlay of textOverlays) {
        if (!overlay.appearance) continue;
        if (
          overlay.appearance.fontFamilyHint !== typographyAuthority.fontFamilyHint ||
          overlay.appearance.fontWidth !== typographyAuthority.fontWidth
        ) propagated = true;
        overlay.appearance = {
          ...overlay.appearance,
          fontFamilyHint: typographyAuthority.fontFamilyHint,
          fontWidth: typographyAuthority.fontWidth,
        };
      }
      if (propagated) warnings.push(`NORMALIZED_CUMULATIVE_FONT: scene ${segment.index} uses ${typographyAuthority.fontFamilyHint}`);
    }
    if (!composition) return { ...segment, textOverlays };
    let layers = composition.layers.map((layer) => ({
      ...layer,
      timing: { ...layer.timing },
      viewport: { ...layer.viewport },
      ...(layer.focalPoint ? { focalPoint: { ...layer.focalPoint } } : {}),
      ...(layer.motion ? {
        motion: {
          ...layer.motion,
          keyframes: layer.motion.keyframes.map((keyframe) => ({
            ...keyframe,
            ...(keyframe.viewport ? { viewport: { ...keyframe.viewport } } : {}),
          })),
        },
      } : {}),
    }));
    const layerById = () => new Map(layers.map((layer) => [layer.id, layer]));

    for (let overlayIndex = 0; overlayIndex < textOverlays.length; overlayIndex++) {
      const overlay = textOverlays[overlayIndex]!;
      if (overlay.fillMode !== "media-matte" || overlay.zIndex === undefined) continue;
      layers = layers.map((layer) => {
        if (layer.role !== "matte-fill" || layer.matteTextOverlayIndex !== overlayIndex || layer.zIndex === overlay.zIndex) {
          return layer;
        }
        warnings.push(`NORMALIZED_MATTE_Z: scene ${segment.index} layer ${layer.id} ${layer.zIndex}->${overlay.zIndex}`);
        return { ...layer, zIndex: overlay.zIndex! };
      });
    }

    const phases = (composition.phases || []).map((phase, phaseIndex, source) => {
      if (!phaseDescribesTextOcclusion(phase.label)) return { ...phase };
      const previous = source[phaseIndex - 1];
      const inheritedText = phase.activeTextOverlayIndices.length
        ? phase.activeTextOverlayIndices
        : previous?.activeTextOverlayIndices || [];
      const inheritedMattes = inheritedText.flatMap((overlayIndex) => {
        const matte = layers.find((layer) =>
          layer.role === "matte-fill" && layer.matteTextOverlayIndex === overlayIndex
        );
        return matte ? [matte.id] : [];
      });
      const activeLayerIds = [...new Set([...phase.activeLayerIds, ...inheritedMattes])];
      if (inheritedText.length !== phase.activeTextOverlayIndices.length) {
        warnings.push(`PRESERVED_OCCLUDED_TEXT: scene ${segment.index} phase ${phase.id}`);
      }
      return {
        ...phase,
        activeLayerIds,
        activeTextOverlayIndices: [...inheritedText],
      };
    });

    const ids = layerById();
    for (const phase of phases) {
      if (!phaseDescribesTextOcclusion(phase.label)) continue;
      const backgroundZ = phase.activeTextOverlayIndices.reduce((max, overlayIndex) => {
        const overlay = textOverlays[overlayIndex];
        const matte = layers.find((layer) => layer.role === "matte-fill" && layer.matteTextOverlayIndex === overlayIndex);
        return Math.max(max, overlay?.zIndex ?? -100, matte?.zIndex ?? -100);
      }, -100);
      if (backgroundZ === -100) continue;
      for (const layerId of phase.activeLayerIds) {
        const layer = ids.get(layerId);
        if (!layer || layer.role !== "panel" || layer.zIndex > backgroundZ) continue;
        const nextZ = backgroundZ + 1;
        warnings.push(`NORMALIZED_OCCLUSION_Z: scene ${segment.index} layer ${layer.id} ${layer.zIndex}->${nextZ}`);
        layers = layers.map((candidate) => candidate.id === layer.id ? { ...candidate, zIndex: nextZ } : candidate);
        ids.set(layer.id, { ...layer, zIndex: nextZ });
      }
    }

    for (const phase of phases) {
      for (const overlayIndex of phase.activeTextOverlayIndices) {
        const overlay = textOverlays[overlayIndex];
        if (!overlay) continue;
        const timing = overlay.timing || { startRatio: 0, endRatio: 1 };
        overlay.timing = {
          ...timing,
          startRatio: Math.min(timing.startRatio, phase.startRatio),
          endRatio: Math.max(timing.endRatio, phase.endRatio),
        };
      }
      layers = layers.map((layer) => phase.activeLayerIds.includes(layer.id)
        ? {
            ...layer,
            timing: {
              ...layer.timing,
              startRatio: Math.min(layer.timing.startRatio, phase.startRatio),
              endRatio: Math.max(layer.timing.endRatio, phase.endRatio),
            },
          }
        : layer);
    }

    return {
      ...segment,
      textOverlays,
      composition: { ...composition, layers, ...(phases.length ? { phases } : {}) },
    };
  });
  const reconciledSegments = reconcileBoundaryTypography(segments, warnings);
  return { blueprint: { ...blueprint, segments: reconciledSegments }, warnings };
}

function derivedFallbackPhases(segment: BlueprintSegment): NonNullable<BlueprintSegment["composition"]>["phases"] {
  const composition = segment.composition;
  if (!composition) return undefined;
  const boundaries = new Set<number>([0, 1]);
  for (const layer of composition.layers) {
    boundaries.add(Math.max(0, Math.min(1, layer.timing.startRatio)));
    boundaries.add(Math.max(0, Math.min(1, layer.timing.endRatio)));
  }
  for (const overlay of segment.textOverlays) {
    boundaries.add(Math.max(0, Math.min(1, overlay.timing?.startRatio ?? 0)));
    boundaries.add(Math.max(0, Math.min(1, overlay.timing?.endRatio ?? 1)));
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  return ordered.slice(0, -1).flatMap((startRatio, index) => {
    const endRatio = ordered[index + 1]!;
    if (endRatio - startRatio < 0.001) return [];
    const midpoint = startRatio + (endRatio - startRatio) / 2;
    const activeLayerIds = composition.layers
      .filter((layer) => midpoint >= layer.timing.startRatio && midpoint < layer.timing.endRatio)
      .map((layer) => layer.id);
    const activeTextOverlayIndices = segment.textOverlays.flatMap((overlay, overlayIndex) => {
      const start = overlay.timing?.startRatio ?? 0;
      const end = overlay.timing?.endRatio ?? 1;
      return midpoint >= start && midpoint < end ? [overlayIndex] : [];
    });
    return [{
      id: `fallback-phase-${index}`,
      label: "Visibility derived from sampled-frame layer timings",
      startRatio,
      endRatio,
      activeLayerIds,
      activeTextOverlayIndices,
      confidence: 0.35,
    }];
  });
}

/**
 * Make sampled-frame model output safe to compile without pretending that the
 * fallback measured details it could not observe. Invalid matte references are
 * removed, media-filled text without a retained matte degrades to solid text,
 * and missing visibility phases are derived only from already-reported timing.
 */
export function reconcileSampledFallbackBlueprint(
  blueprint: EditBlueprint
): { blueprint: EditBlueprint; warnings: string[] } {
  const warnings: string[] = [];
  const segments = blueprint.segments.map((original) => {
    let textOverlays = original.textOverlays.map((overlay) => ({ ...overlay }));
    const composition = original.composition;
    if (!composition) return { ...original, textOverlays };

    const layers: BlueprintMediaLayer[] = composition.layers.flatMap<BlueprintMediaLayer>((layer) => {
      const matteIndex = layer.matteTextOverlayIndex;
      const matteOverlay = matteIndex === undefined ? undefined : textOverlays[matteIndex];
      const validMatte = Boolean(matteOverlay && matteOverlay.fillMode === "media-matte");
      if (layer.role === "matte-fill" && !validMatte) {
        warnings.push(
          `SAMPLED_FALLBACK_DROPPED_INVALID_MATTE: scene ${original.index} layer ${layer.id}`
        );
        return [];
      }
      if (matteIndex !== undefined && !validMatte) {
        warnings.push(
          `SAMPLED_FALLBACK_REMOVED_INVALID_MATTE_LINK: scene ${original.index} layer ${layer.id}`
        );
        const { matteTextOverlayIndex: _invalid, ...safeLayer } = layer;
        return [safeLayer];
      }
      return [{ ...layer }];
    });

    textOverlays = textOverlays.map((overlay, overlayIndex) => {
      if (overlay.fillMode !== "media-matte") return overlay;
      const linked = layers.some((layer) =>
        layer.role === "matte-fill" && layer.matteTextOverlayIndex === overlayIndex
      );
      if (linked) return overlay;
      warnings.push(
        `SAMPLED_FALLBACK_UNVERIFIED_MEDIA_TEXT: scene ${original.index} text ${overlayIndex} rendered as solid`
      );
      const { fillMode: _unverified, ...solidOverlay } = overlay;
      return solidOverlay;
    });

    if (layers.length === 0) {
      warnings.push(`SAMPLED_FALLBACK_DROPPED_EMPTY_COMPOSITION: scene ${original.index}`);
      return { ...original, textOverlays, composition: undefined };
    }

    const validLayerIds = new Set(layers.map((layer) => layer.id));
    const cleanedPhases = composition.phases?.flatMap((phase) => {
      const activeLayerIds = phase.activeLayerIds.filter((id) => validLayerIds.has(id));
      const activeTextOverlayIndices = phase.activeTextOverlayIndices.filter(
        (index) => index >= 0 && index < textOverlays.length
      );
      return [{ ...phase, activeLayerIds, activeTextOverlayIndices }];
    });
    const provisional: BlueprintSegment = {
      ...original,
      textOverlays,
      composition: {
        ...composition,
        replaceBase: composition.replaceBase && layers.length > 0,
        layers,
        ...(cleanedPhases?.length ? { phases: cleanedPhases } : {}),
      },
    };
    if (!provisional.composition!.phases?.length) {
      provisional.composition = {
        ...provisional.composition!,
        phases: derivedFallbackPhases(provisional),
      };
      warnings.push(`SAMPLED_FALLBACK_DERIVED_PHASES: scene ${original.index}`);
    }
    return provisional;
  });
  return {
    blueprint: { ...blueprint, segments },
    warnings,
  };
}

/**
 * Only accepts dense-pass structures which pass the same invariants as the
 * primary structure. This prevents a plausible but incomplete second answer
 * from silently replacing better evidence.
 */
export function chooseReliableSegment(
  primary: BlueprintSegment,
  detail: BlueprintSegment,
  evidence?: ReferenceAnalysisEvidence
): BlueprintSegment {
  const primaryReport = validateBlueprintIntegrity({ segments: [primary], analysisEvidence: evidence });
  const detailReport = validateBlueprintIntegrity({ segments: [detail], analysisEvidence: evidence });
  const primaryErrors = primaryReport.issues.filter((issue) => issue.severity === "error").length;
  const detailErrors = detailReport.issues.filter((issue) => issue.severity === "error").length;
  if (detailErrors > primaryErrors) return primary;
  if (detailErrors < primaryErrors) return detail;
  const detailInformation = (detail.composition?.layers.length || 0) * 4 +
    (detail.composition?.phases?.length || 0) * 2 +
    detail.textOverlays.filter((overlay) => overlay.animationSpec).length;
  const primaryInformation = (primary.composition?.layers.length || 0) * 4 +
    (primary.composition?.phases?.length || 0) * 2 +
    primary.textOverlays.filter((overlay) => overlay.animationSpec).length;
  return detailInformation >= primaryInformation ? detail : primary;
}
