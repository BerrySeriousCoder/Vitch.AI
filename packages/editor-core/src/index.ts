export {
  TEXT_ANIMATION_PRESETS,
  SHAPE_ANIMATION_PRESETS,
  getAnimationPreset,
  listAnimationPresetIds,
  applyAnimationPresetToKeyframes,
  type AnimationPreset,
} from "./animation-presets";

export {
  CAPTION_PRESETS,
  getCaptionPreset,
  applyCaptionPreset,
  type CaptionPreset,
} from "./caption-presets";

export {
  audioAutomationBounds,
  normalizeAudioAutomationPoints,
  normalizeAudioAutomation,
  audioAutomationValueAt,
  resolveAudioAutomationBreakpoints,
  multiplyAudioAutomationBreakpoints,
  ffmpegAudioAutomationExpr,
  type AudioAutomationProperty,
  type AudioAutomationBreakpoint,
} from "./audio-automation";

export {
  normalizeMulticam,
  resolveMulticamAngleAtTime,
  setMulticamSwitch,
} from "./multicam";

export {
  EFFECT_PRESETS,
  getEffectPreset,
  listEffectPresetIds,
  type EffectPreset,
} from "./effect-presets";

export {
  registerEffect,
  getEffectDefinition,
  listEffectDefinitions,
  listEffectTypes,
  getEffectSchema,
  defaultEffectInstance,
  validateEffectParams,
  type EffectDefinition,
  type EffectParamDefinition,
  type EffectPreviewBackend,
  type EffectExportBackend,
} from "./effect-registry";

export {
  DEFAULT_PRIMARY_COLOR_GRADE,
  normalizePrimaryColorGrade,
  isPrimaryColorGradeNeutral,
} from "./color-grade";

export {
  DEFAULT_HSL_SECONDARY,
  normalizeHslSecondary,
  isHslSecondaryNeutral,
} from "./hsl-secondary";

export {
  DEFAULT_LIFT_GAMMA_GAIN,
  normalizeLiftGammaGain,
  isLiftGammaGainNeutral,
} from "./color-wheels";

export {
  DEFAULT_LEVELS,
  normalizeLevels,
  isLevelsNeutral,
} from "./levels";

export {
  NEUTRAL_COLOR_STATISTICS,
  colorStatisticsFromPalette,
  deriveColorMatch,
  applyColorMatchToClip,
  type ColorMatchProposal,
  type ApplyColorMatchResult,
} from "./color-match";

export {
  setEffectEnabled,
  reorderClipEffects,
  applyClipAttributes,
  type ClipAttributeScope,
  type ApplyClipAttributesInput,
  type EffectStackResult,
} from "./effect-stack";

export {
  MAX_CURVE_POINTS,
  DEFAULT_CURVE_POINTS,
  COLOR_CURVE_CHANNELS,
  createDefaultCurve,
  normalizeCurvePoints,
  validateCurvePoints,
  normalizeColorCurves,
  sampleCurve,
} from "./color-curves";

export {
  parseCubeLut,
  identityCubeLut,
  cinematicCubeLut,
  getBuiltinLut,
  isBuiltinLutId,
  blendCubeLut,
  serializeCubeLut,
  BUILTIN_LUT_IDS,
  type ParsedCubeLut,
} from "./cube-lut";

export {
  TRANSITION_TYPES,
  listTransitionTypes,
  listTransitionTypeIds,
  getTransitionType,
  defaultTransitionParams,
  type TransitionTypeDefinition,
  type TransitionParamDefinition,
  type TransitionMixFamily,
} from "./transition-registry";

export {
  applyTransition,
  applyTransitionToTrackCuts,
  removeTransition,
  updateTransitionDuration,
  validateTransitionPlacement,
  pruneInvalidTransitions,
  removeMatchingTransitions,
  findActiveTransition,
  getTransitionWindow,
  getTransitionProgress,
  getTransitionClipOpacity,
  getTransitionMix,
  clipEnd,
  availableTailSourceSec,
  availableHeadSourceSec,
  type MediaDurationMap,
  type TransitionResult,
  type TransitionHandleError,
  type ApplyTransitionInput,
  type TransitionMix,
  type TransitionDirection,
  type GeometricTransitionKind,
} from "./transitions";

export {
  closeGapOnTrack,
  rippleDeleteClip,
  deleteClipLeaveGap,
  rippleTrimClip,
  replaceClipMedia,
  shiftClipsAfter,
  trackHasOverlap,
  type TimelineEditResult,
  type TimelineEditOk,
  type TimelineEditErr,
  type ReplaceFit,
} from "./timeline-edit";

export {
  rollEdit,
  slideEdit,
  slipEdit,
  matchFrameTime,
} from "./advanced-timeline-edit";

export {
  linkClips,
  unlinkClips,
  rippleDeleteLinkedGroup,
} from "./linked-clips";

export { resolveThreePointEdit, type ThreePointEditMarks } from "./three-point-edit";
export { sourceEdit, type SourceEditMode, type SourceEditMetadata, type SourceEditResult } from "./source-edit";

export {
  TIMING_EPSILON,
  validateClipTiming,
  getSourceRange,
  getClipSourceRange,
  mapSourcePointToTimeline,
  mapTimelinePointToSource,
  mapSourceIntervalToTimeline,
  type ClipTiming,
  type TimeInterval,
} from "./source-media-timeline";

export { needsFrameExport } from "./export-policy";
export { DEFAULT_MOTION_BLUR, DEFAULT_TRANSFORM_3D, normalizeMotionBlur, normalizeTransform3D } from "./advanced-motion";
export { validateMotionGraph, evaluateMotionGraph, type MotionGraphValues } from "./motion-graph";
export { DEFAULT_TRACK_AUDIO_POST, DEFAULT_MASTERING, normalizeTrackAudioPost, normalizeMastering, ffmpegAudioPostFilters, ffmpegMasteringFilters } from "./audio-post";
export { DEFAULT_STABILIZATION, normalizeStabilization, resolveStabilizationAtTime } from "./stabilization";
export { estimateTranslationalFlow, estimateFeatureTranslation, type OpticalFlowVector } from "./optical-flow";
export { normalizeRotoMatteRefinement, normalizeRotoRegion } from "./roto-matte";

export {
  MAX_PLANAR_TRACK_SAMPLES,
  normalizePlanarTrackSamples,
  normalizePlanarTrack,
  resolvePlanarTrackAtTime,
} from "./planar-track";

export {
  MAX_MOTION_TRACK_SAMPLES,
  normalizeMotionTrackSamples,
  normalizeMotionTrack,
  resolveMotionTrackAtTime,
  type ResolvedMotionTrack,
} from "./motion-track";

export {
  transformToAffine,
  multiplyAffineTransforms,
  resolveCompositingStates,
  canSetParent,
  validateCompositingHierarchy,
  setClipParent,
  setClipTrackMatte,
  type AffineTransform,
  type LocalCompositingState,
  type ResolvedCompositingState,
  type CompositingIssue,
} from "./compositing-hierarchy";

export {
  DEFAULT_CROP,
  normalizeCrop,
  validateCrop,
  cropIsIdentity,
  resolveCropAtTime,
  listKenBurnsPresetIds,
  applyKenBurns,
  type KenBurnsPresetId,
  type ApplyKenBurnsInput,
  type ApplyKenBurnsResult,
} from "./crop";

export {
  resolveMediaGeometry,
  normalizeMediaViewport,
  validateMediaViewport,
  resolveMediaLayoutAtTime,
  type MediaGeometryInput,
  type MediaGeometryRect,
  type ResolvedMediaGeometry,
} from "./media-geometry";

export {
  reflowTracksForComposition,
  type CompositionSize,
} from "./format-reflow";

export {
  DEFAULT_ADJUSTMENT_LAYER,
  isAdjustmentTrack,
  isAdjustmentClip,
  validateAdjustmentClip,
  createAdjustmentLayer,
  type CreateAdjustmentLayerInput,
  type AdjustmentLayerResult,
} from "./adjustment-layer";

export {
  isNestClip,
  sequenceLocalTime,
  sequenceContentEnd,
  createEmptySequence,
  createSequenceFromClips,
  placeSequenceClip,
  deleteSequence,
  renameSequence,
  validateSequences,
  hasNestClips,
  countSequenceUsage,
  type SequenceOpResult,
  type SequenceOpOk,
  type SequenceOpErr,
} from "./sequences";

export {
  TEXT_ANIMATOR_PRESETS,
  getTextAnimatorPreset,
  listTextAnimatorPresetIds,
  applyTextAnimatorPreset,
  normalizeAnimator,
  validateAnimators,
  normalizeSplit,
  textHasKineticAnimators,
  splitTextUnits,
  resolveUnitMotion,
  type TextUnit,
  type UnitMotion,
  type TextAnimatorPreset,
} from "./text-animators";

export {
  DEFAULT_MASK,
  normalizeMask,
  validateMask,
  clipHasMask,
} from "./mask";

export {
  DEFAULT_CHROMA_KEY,
  GREEN_SCREEN_PRESET,
  BLUE_SCREEN_PRESET,
  normalizeChromaKey,
  validateChromaKey,
  listChromaPresetIds,
  applyChromaPreset,
  parseKeyColorRgb,
  computeChromaMatte,
  applySpillSuppress,
  clipHasChromaKey,
  clipHasChromaKeyOnClip,
  getChromaSchema,
  rgbToCbCr,
  type ChromaPresetId,
} from "./chroma-key";

export {
  normalizeHold,
  validateHold,
  planHoldExtension,
} from "./hold";

export {
  normalizeSpeedRamp,
  normalizeRetimeSettings,
  DEFAULT_RETIME_SETTINGS,
  validateSpeedRamp,
  speedMagnitude,
  isClipReversed,
  rateAtTime,
  integrateRate,
  motionSourceSpan,
  sourceTimeAt,
  sourceTimeWithHold,
  listSpeedPresetIds,
  applySpeedPreset,
  type SourceTimeResult,
  type SpeedPresetId,
} from "./speed-ramp";

export {
  DEFAULT_AUDIO_DUCK,
  DEFAULT_TRACK_EQ,
  normalizeDuckSettings,
  normalizeTrackEq,
  ffmpegEqFilters,
  getTrackRole,
  mergeIntervals,
  voiceActivityWindows,
  musicDuckBreakpoints,
  ffmpegVolumeExprFromBreakpoints,
  ffmpegSidechainCompressOpts,
  type TimeInterval as DuckTimeInterval,
} from "./audio-duck";

export {
  extractStyleDnaFromBlueprint,
  scoreShotForRole,
  rankShots,
  applyStyleDnaHints,
  resolveStyleDnaAnimationPresetId,
  STYLE_DNA_ANIMATION_MAP,
  cosineSimilarity,
  type RankedShot,
  type RankShotsCriteria,
  type ApplyStyleDnaOpts,
} from "./style-dna";

export {
  shotsFromAssets,
  syntheticShotFromAnalysis,
  filterShots,
  normalizeShotIndex,
  type FilterShotsOpts,
} from "./shot-index";

export {
  orientationFromDimensions,
  mediaDisplayGeometry,
  mediaAssetOrientation,
  orientationMatches,
  coverRetention,
  type MediaDisplayGeometry,
} from "./media-orientation";

export {
  GOOGLE_FONT_FAMILIES,
  GOOGLE_FONT_CATALOG,
  googleFontId,
  parseGoogleFontId,
  isKnownGoogleFont,
  isSafeGoogleFontFamily,
  matchGoogleFontFamily,
  fontFamilyCss,
  listGoogleFonts,
  resolveTextFont,
  type GoogleFontFamily,
  type FontListEntry,
  type FontCategory,
  type FontRole,
  type GoogleFontDef,
  type GoogleFontMatchInput,
} from "./fonts";

export {
  listTitleTemplates,
  getTitleTemplate,
  applyTitleTemplateToTextParams,
  type TitleTemplate,
  type TitleTemplateRole,
} from "./title-templates";

export {
  listTempoPacks,
  getTempoPack,
  listPresets,
  validateTempoPackManifest,
  registerTempoPack,
  clearProjectPacks,
  applyPreset,
  safePackPath,
  type TempoPack,
  type TempoPackManifest,
  type TempoPackPreset,
  type TempoPackKind,
} from "./tempo-pack";

export {
  validateTimeline,
  formatTimelineValidationIssues,
  type TimelineValidationIssue,
  type TimelineValidationSeverity,
} from "./validate-timeline";

export {
  interpolateValue,
  resolveKeyframeValues,
  resolveEffectParamsAtTime,
  getEasingFunction,
  linear,
  easeIn,
  easeOut,
  easeInOut,
  cubicBezier,
  type EasingFunction,
} from "./keyframes";

export {
  EFFECT_ANIMATION_PRESETS,
  getEffectAnimationPreset,
  listEffectAnimationPresetIds,
  applyEffectAnimationPresetToKeyframes,
  type EffectAnimationPreset,
} from "./effect-animation-presets";

export {
  appendTextPart,
  appendToolCallPart,
  completeToolPart,
  mirrorsFromParts,
  ensureMessageParts,
  applyAgentEventToParts,
} from "./ai-message-parts";

export {
  listDeliveryProfiles,
  getDeliveryProfile,
  customDeliveryProfile,
  resolveDeliveryProfile,
  rectToPixels,
  layoutZoneRect,
  resolveGraphicGeometry,
  validateGraphicGeometry,
  estimateTextBounds,
} from "./delivery-profiles";

export {
  formatToolResult,
  toolOk,
  toolErr,
  type ToolResultPayload,
  type ToolResultOk,
  type ToolResultErr,
} from "./tool-result";

export {
  listEditPoints,
  findClipLocation,
  transitionSameTrackHint,
  type EditPointCandidate,
} from "./edit-points";
