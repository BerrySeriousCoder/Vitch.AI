// ============================================================
// PROJECT TYPES
// Core data model for Tempo video editor projects
// ============================================================

import type { DeliveryProfile, GraphicLayout } from "./delivery.types.js";

/** Supported blend modes for layer compositing */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion";

/** Easing functions for keyframe interpolation */
export type EasingType =
  | "hold"
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "cubic-bezier";

/** Track types in the timeline */
export type TrackType =
  | "video"
  | "audio"
  | "text"
  | "shape"
  | "effect"
  | "adjustment"
  /** Non-rendering controller track for AE-style null layers. */
  | "null";

/** 2D Transform properties */
export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  anchorX: number;
  anchorY: number;
}

/** Optional per-layer 3D transform; 2D fields remain the backwards-compatible default. */
export interface Transform3D {
  x: number; y: number; z: number;
  rotationX: number; rotationY: number; rotationZ: number;
  scaleX: number; scaleY: number; scaleZ: number;
  anchorX: number; anchorY: number; anchorZ: number;
}

export interface MotionBlurSettings {
  enabled: boolean;
  /** 0..360 degrees; 180 is a conventional cinematic shutter. */
  shutterAngle: number;
  samples: number;
}

export interface Camera3D {
  id: string; name: string; position: [number, number, number]; rotation: [number, number, number]; fov: number; near: number; far: number; enabled: boolean;
}

export interface Light3D {
  id: string; name: string; type: "ambient" | "directional" | "point" | "spot"; color: string; intensity: number; position: [number, number, number]; rotation: [number, number, number]; enabled: boolean;
}

/** Serializable node graph, evaluated by the shared motion renderer. */
export interface MotionGraph {
  id: string; name: string; nodes: Array<{ id: string; type: string; params: Record<string, number | string | boolean> }>; edges: Array<{ id: string; fromNodeId: string; fromPort: string; toNodeId: string; toPort: string }>;
}

/** A clip may inherit the animated transform and opacity of another clip. */
export type TrackMatteType = "alpha" | "luma";

/** Uses the rendered alpha or luma of another clip as this clip's visibility. */
export interface TrackMatte {
  sourceClipId: string;
  type: TrackMatteType;
  /** Non-destructive post-processing for AI or hand-authored mattes. */
  refinement?: {
    threshold: number;
    feather: number;
    inverted: boolean;
    /** -0.5 erodes / chokes the matte; +0.5 expands a soft matte edge. */
    choke?: number;
  };
  /** Keep only this region of the generated matte (garbage matte). */
  garbageMask?: Mask;
  /** Remove this region from the generated matte (holdout matte). */
  holdoutMask?: Mask;
}

/** Inverse global camera-motion correction generated from local optical flow. */
export interface StabilizationSettings {
  enabled: boolean;
  samples: MotionTrackSample[];
  /** 0 = preserve raw motion, 1 = maximize smoothing. */
  smoothness: number;
  /** Extra scale used to hide stabilizer edge movement. */
  cropScale: number;
}

/** One synchronized camera angle used by a non-destructive multicam clip. */
export interface MulticamAngle {
  id: string;
  name: string;
  sourceClipId: string;
  sourceMediaId: string;
  /** Source-media time corresponding to multicam time zero. */
  sourceOffset: number;
}

/** A live angle cut, measured in seconds from the multicam clip start. */
export interface MulticamSwitch {
  time: number;
  angleId: string;
}

/** Portable multicam edit decision list embedded in a visual timeline clip. */
export interface MulticamSettings {
  angles: MulticamAngle[];
  switches: MulticamSwitch[];
  /** Selected source's audio is used by the normal clip audio pipeline. */
  audioAngleId: string;
  /** Optional provenance from deterministic local waveform synchronization. */
  sync?: MulticamSyncMetadata;
}

export interface MulticamSyncMetadata {
  mode: "manual" | "audio-correlation" | "clap" | "timecode";
  referenceAngleId: string;
  /** Correlation confidence for each angle, 1 for the reference. */
  confidenceByAngle: Record<string, number>;
  analysedAt?: string;
}

/** One AI/manual 2D tracker sample, in normalized composition coordinates. */
export interface MotionTrackSample {
  /** Seconds relative to the controller clip start. */
  time: number;
  /** Tracked anchor point in the source frame, 0..1. */
  x: number;
  y: number;
  /** Relative size; 1 means no scale adjustment. */
  scale?: number;
  /** Optional in-plane rotation in degrees. */
  rotation?: number;
  /** Model-estimated confidence, 0..1. */
  confidence?: number;
}

/**
 * Editable motion-track data attached to a controller or visual clip. It is
 * resolved into ordinary transform values during preview and frame export.
 */
export interface MotionTrack {
  sourceClipId: string;
  subject: string;
  samples: MotionTrackSample[];
  /** Whether scale and rotation samples should affect the driven transform. */
  useScale?: boolean;
  useRotation?: boolean;
}

/** A normalized point on the composition, used for corner-pin tracking. */
export interface PlanarTrackPoint {
  x: number;
  y: number;
}

/** One tracked surface quadrilateral, ordered top-left, top-right, bottom-right, bottom-left. */
export interface PlanarTrackSample {
  /** Seconds relative to the receiving layer's start. */
  time: number;
  corners: [PlanarTrackPoint, PlanarTrackPoint, PlanarTrackPoint, PlanarTrackPoint];
  /** Local-feature match confidence, 0..1. */
  confidence?: number;
}

/**
 * Editable four-corner surface tracking data. The renderer perspective-pins
 * the receiving layer to this quad, making it useful for screen/sign/package
 * replacements rather than merely moving a layer's anchor point.
 */
export interface PlanarTrack {
  sourceClipId: string;
  surface: string;
  samples: PlanarTrackSample[];
}

/** A single keyframe for animating a property */
export interface Keyframe {
  id: string;
  property: string;
  time: number;
  value: number | string | boolean;
  easing: EasingType;
  /** Control points for cubic-bezier easing [x1, y1, x2, y2] */
  bezierHandles?: [number, number, number, number];
}

/** An effect applied to a clip */
export interface CurvePoint {
  /** Input value from 0 (black) to 1 (white). */
  x: number;
  /** Output value from 0 (black) to 1 (white). */
  y: number;
}

export interface ColorCurves {
  luma: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

/** Values accepted by schema-driven effect parameters. */
export type EffectParamValue = number | string | boolean | CurvePoint[];

export interface Effect {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  params: Record<string, EffectParamValue>;
  keyframes: Keyframe[];
}

/**
 * Primary, non-destructive color correction controls. Stored in an effect's
 * generic params map under the `color-grade` effect type.
 */
export interface PrimaryColorGrade {
  /** Exposure in EV stops. */
  exposure: number;
  /** Contrast adjustment as a percentage around zero. */
  contrast: number;
  /** Saturation adjustment as a percentage around zero. */
  saturation: number;
  /** Blue (-) to amber (+). */
  temperature: number;
  /** Green (-) to magenta (+). */
  tint: number;
  /** Dark-region recovery/lift as a percentage. */
  shadows: number;
  /** Bright-region recovery/lift as a percentage. */
  highlights: number;
  /** Black-point adjustment as a percentage. */
  blacks: number;
  /** White-point adjustment as a percentage. */
  whites: number;
  /** Saturation weighted toward less-saturated colors. */
  vibrance: number;
}

/**
 * Qualifies a color range in HSL, then adjusts only the matching pixels.
 * Stored in an effect's generic params map under the `hsl-secondary` type.
 */
export interface HslSecondary {
  /** Centre of the selected hue in degrees (0..360). */
  hueCenter: number;
  /** Half-width of the hue selection in degrees (1..180). */
  hueRange: number;
  /** Selected saturation range, normalized 0..1. */
  saturationMin: number;
  saturationMax: number;
  /** Selected HSL lightness range, normalized 0..1. */
  lightnessMin: number;
  lightnessMax: number;
  /** Softens all qualifier edges (0..1). */
  feather: number;
  /** Correction applied inside the qualified range. */
  hueShift: number;
  saturationShift: number;
  lightnessShift: number;
  /** Blend of the secondary correction (0..1). */
  mix: number;
}

/**
 * Professional Lift/Gamma/Gain color-wheel controls. Each wheel offers an
 * RGB balance plus a master tonal adjustment, all centered at zero.
 */
export interface LiftGammaGain {
  liftRed: number;
  liftGreen: number;
  liftBlue: number;
  liftMaster: number;
  gammaRed: number;
  gammaGreen: number;
  gammaBlue: number;
  gammaMaster: number;
  gainRed: number;
  gainGreen: number;
  gainBlue: number;
  gainMaster: number;
}

/** Input/output levels with a midtone gamma pivot. */
export interface Levels {
  /** Source luminance treated as black (0..1). */
  inputBlack: number;
  /** Source luminance treated as white (0..1). */
  inputWhite: number;
  /** Midtone gamma; 1 is neutral. */
  gamma: number;
  /** Output black floor (0..1). */
  outputBlack: number;
  /** Output white ceiling (0..1). */
  outputWhite: number;
}

/** Clip mask — typed rect/ellipse (normalized clip-local 0..1). */
export interface Mask {
  shape: "rect" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  feather: number;
  inverted: boolean;
  opacity: number;
}

/**
 * First-class chroma key (green/blue screen) on a clip — not an effect.
 * Runs before clip color/FX in the compositor; export uses frame path.
 */
export interface ChromaKey {
  /** Screen key color as #RRGGBB */
  keyColor: string;
  /** How much of the screen to remove (0..1). Higher = more aggressive. */
  similarity: number;
  /** Softness of the matte edge (0..1). */
  smoothness: number;
  /** Spill suppress strength on fringe (0..1). */
  spill: number;
  /** Optional label for UI/agent */
  screen?: "green" | "blue" | "custom";
}

/**
 * A non-destructive full-frame grade/composite layer. It evaluates the
 * already-composited tracks below it, then applies this clip's effect stack.
 * More targeted scopes can be added later without changing the clip model.
 */
export interface AdjustmentLayer {
  target: "below";
}

/** Non-destructive source crop in normalized source UV coordinates. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How source media is placed inside the composition before creative transforms. */
export type MediaFit = "cover" | "contain" | "fill" | "none";

/**
 * Resolution-independent destination region for a video/image layer. Values
 * are normalized against the composition, so one authored layout works for
 * preview, export, and later delivery-resolution changes.
 */
export interface MediaViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolution-independent base placement for video and image clips.
 * `fill` is the only mode which intentionally permits aspect distortion.
 */
export interface MediaLayout {
  schemaVersion: 1;
  fit: MediaFit;
  /** Subject/focal point in normalized source coordinates. Defaults to centre. */
  focalPoint?: { x: number; y: number };
  /** Optional destination cell. Omitted means the complete composition. */
  viewport?: MediaViewport;
}

export interface CaptionWordTiming {
  /** Word text as rendered in the cue */
  text: string;
  /** Seconds relative to the caption clip start */
  start: number;
  /** Seconds relative to the caption clip start */
  end: number;
}

/** Provenance linking a generated caption to audible source media. */
export interface CaptionBinding {
  sourceClipId: string;
  sourceMediaId: string;
  transcriptRevision: string;
  /** Source-media interval represented by this caption. */
  sourceStart: number;
  sourceEnd: number;
  wordIds: string[];
  generatedTiming: boolean;
  intentionalOffsetMs?: number;
  stale?: boolean;
}

/** Durable provenance for deterministic Edit Like This assembly and QA. */
export interface ReferenceEditBinding {
  blueprintId: string;
  kind: "segment" | "composition-layer" | "support-layer" | "text-overlay" | "music-bed";
  segmentIndex: number;
  layerId?: string;
  overlayIndex?: number;
  mappedAssetId?: string;
  expectedStartTime: number;
  expectedDuration: number;
  expectedSourceOffset?: number;
  requestedSpeed?: number;
}

/** How kinetic text is split into animatable units */
export type TextSplitMode = "none" | "char" | "word" | "line";

/** Animatable per-unit text properties (kinetic typography) */
export type TextAnimatorProperty =
  | "opacity"
  | "offsetX"
  | "offsetY"
  | "scale"
  | "rotation"
  | "tracking"
  | "blur"
  | "color";

export type TextAnimatorEase =
  | "hold"
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out";

/**
 * One animator channel applied across text units (char/word/line).
 * Unit i starts at offsetSec + i * staggerSec.
 */
export interface TextAnimator {
  property: TextAnimatorProperty;
  /** Seconds before first unit begins animating */
  offsetSec: number;
  /** Duration of one unit's animation */
  durationSec: number;
  /** Delay between consecutive units */
  staggerSec: number;
  from: number;
  to: number;
  /** Required for property=color; hex colors are interpolated per text unit. */
  fromColor?: string;
  toColor?: string;
  ease: TextAnimatorEase;
  /** Optional unit index range [start, endExclusive); omit = all units */
  range?: [number, number];
  /**
   * Explicit start time per rendered unit. When present it replaces uniform
   * offset+stagger timing and can follow irregular impacts, speech, or beats.
   */
  unitStartTimes?: number[];
  /** Multi-stage curve relative to each unit's resolved start time. */
  valueKeyframes?: Array<{
    timeSec: number;
    value: number;
    easing: TextAnimatorEase;
  }>;
}

/** Reusable paint definition for text and vector shapes. Coordinates are local to the rendered layer. */
export interface GradientFill {
  type: "linear" | "radial";
  from: string;
  to: string;
  /** Linear-gradient angle in degrees; 0 is left → right. */
  angle?: number;
}

/** Structured, renderer-safe layer shadow. CSS text-shadow remains supported for legacy projects. */
export interface LayerShadow {
  color: string;
  offsetX: number;
  offsetY: number;
  blur: number;
  opacity?: number;
}

/** Outer glow rendered behind the layer's own fill/stroke. */
export interface LayerGlow {
  color: string;
  blur: number;
  opacity?: number;
}

/** One independently styled span in a text layer. Runs are read in order. */
export interface RichTextRun {
  text: string;
  color?: string;
  fontFamily?: string;
  fontId?: string;
  fontSize?: number;
  fontWeight?: string;
  italic?: boolean;
  underline?: boolean;
  letterSpacing?: number;
}

/** Project-scoped design tokens used by reusable graphic templates. */
export interface BrandKit {
  name?: string;
  colors: string[];
  fontId?: string;
  fontFamily?: string;
  logoAssetId?: string;
}

/** Reusable single-layer graphic recipe. Slot tokens use {{name}} form. */
export interface GraphicTemplate {
  id: string;
  name: string;
  kind: "text" | "shape";
  textParams?: Partial<TextParams>;
  shapeParams?: Partial<ShapeParams>;
  /** Optional responsive or exact base geometry copied with the graphic recipe. */
  layout?: GraphicLayout;
  suggestedDuration: number;
  createdAt: string;
}

/** Lottie JSON playback settings for a graphic layer. Asset must be project-uploaded. */
export interface LottieParams {
  assetId: string;
  loop?: boolean;
  speed?: number;
}

/** Text rendering parameters for text clips */
export interface TextParams {
  text: string;
  /** Optional ordered spans. When present their concatenated text is rendered instead of `text`. */
  richTextRuns?: RichTextRun[];
  /**
   * Preferred: resolve via FontAsset id (uploaded or library).
   * When set, renderer loads that face; fontFamily is display/fallback CSS.
   */
  fontId?: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  color: string;
  /** Optional native canvas gradient replacing the solid text fill. */
  fillGradient?: GradientFill;
  /** False draws an outline-only text layer (stroke must be set). */
  fillEnabled?: boolean;
  textAlign: "left" | "center" | "right";
  lineHeight: number;
  stroke?: string;
  strokeWidth?: number;
  shadow?: string;
  shadowStyle?: LayerShadow;
  glow?: LayerGlow;
  backgroundColor?: string;
  /** Maximum rendered line width in composition pixels; text wraps before drawing. */
  maxWidth?: number;
  /** Padding around a caption/text background in composition pixels. */
  backgroundPadding?: number;
  /** Rounded-corner radius for the text background in composition pixels. */
  backgroundRadius?: number;
  /** Identifier of the reusable caption graphics preset last applied. */
  captionPresetId?: string;
  letterSpacing?: number;
  /** Enables deterministic per-word highlighting for karaoke captions. */
  karaokeWords?: CaptionWordTiming[];
  karaokeActiveColor?: string;
  karaokeInactiveColor?: string;
  /** Kinetic split mode; "none" = draw as whole lines (animators ignored). */
  split?: TextSplitMode;
  /** Per-unit animators (motion, rotation, tracking, blur, and fill color). */
  animators?: TextAnimator[];
}

/** Shape type for shape clips */
export type ShapeType = "rect" | "ellipse" | "triangle" | "polygon" | "star" | "line" | "path";

/** Normalized vector vertex with optional cubic handles relative to the shape bounds. */
export interface VectorPathPoint {
  x: number;
  y: number;
  inX?: number;
  inY?: number;
  outX?: number;
  outY?: number;
}

/** Shape rendering parameters for shape clips */
export interface ShapeParams {
  shape: ShapeType;
  fill: string;
  fillGradient?: GradientFill;
  stroke: string;
  strokeWidth: number;
  width: number;
  height: number;
  cornerRadius?: number;
  /** Number of sides (polygon) or points (star) */
  points?: number;
  /** Inner radius ratio for star shapes (0-1) */
  innerRadius?: number;
  /** Arbitrary normalized polygon/Bézier path, suitable as an alpha track matte. */
  pathPoints?: VectorPathPoint[];
  pathClosed?: boolean;
  shadow?: LayerShadow;
  glow?: LayerGlow;
}

/** A clip on a track (video, audio, text, shape, etc.) */
export interface Clip {
  id: string;
  trackId: string;
  sourceMediaId: string | null;
  /** Generated source (for example an AI matte) that is not in the media bin. */
  generatedMediaUrl?: string | null;
  /** Optional JSON vector animation rendered by the Lottie canvas runtime. */
  lottieParams?: LottieParams;
  /** Clips in the same group behave as one linked A/V edit unit. */
  linkGroupId?: string | null;
  /** Start time on the timeline (in seconds) */
  startTime: number;
  /** Duration on the timeline (in seconds) */
  duration: number;
  /** In-point offset within the source media (in seconds) */
  sourceOffset: number;
  /**
   * Constant playback rate magnitude when `speedRamp` is empty.
   * Prefer positive values; negative is sugar for `reversed: true` + abs(speed).
   * 1 = normal, 2 = 2×, 0.5 = half speed.
   */
  speed: number;
  /**
   * When true, play the consumed source window backwards (after rate integration).
   * Also implied when `speed < 0` and no ramp.
   */
  reversed?: boolean;
  /**
   * Optional rate envelope over clip-local time (seconds).
   * When length ≥ 2, overrides constant `speed` for source remapping.
   * Rates should be ≥ 0; use `reversed` for direction.
   */
  speedRamp?: SpeedRampPoint[] | null;
  /** Quality settings for variable-speed preview and frame export. */
  retime?: RetimeSettings | null;
  /** Source-aware fit policy. Legacy clips default to `contain`. */
  mediaLayout?: MediaLayout | null;
  transform: Transform;
  /** Optional format-aware base geometry. Transform remains the creative animation delta. */
  layout?: GraphicLayout;
  /** Optional AE-style parent/controller clip. Parent transforms are inherited. */
  parentId?: string | null;
  /** Optional alpha/luma matte source. The source clip is not rendered directly. */
  trackMatte?: TrackMatte | null;
  /** Non-rendering controller clip, normally placed on a `null` track. */
  nullLayer?: boolean;
  /** Optional editable 2D motion tracking data, usually placed on a null layer. */
  motionTrack?: MotionTrack | null;
  /** Optional editable four-corner planar/corner-pin tracking data. */
  planarTrack?: PlanarTrack | null;
  stabilization?: StabilizationSettings | null;
  /** Non-destructive synchronized angle stack and live switch decisions. */
  multicam?: MulticamSettings | null;
  transform3D?: Transform3D | null;
  motionBlur?: MotionBlurSettings | null;
  motionGraphId?: string | null;
  /** Optional embedded procedural graph evaluated with this clip for portable rigs. */
  motionGraph?: MotionGraph | null;
  opacity: number;
  blendMode: BlendMode;
  effects: Effect[];
  keyframes: Keyframe[];
  mask: Mask | null;
  /**
   * Chroma key / green-blue screen matte (first-class — not an effect).
   * Null/undefined = off.
   */
  chromaKey?: ChromaKey | null;
  /** Non-destructive source crop; keyframe crop.x/y/width/height for reframing. */
  crop?: Crop | null;
  /** Present only for clips on an adjustment track. */
  adjustmentLayer?: AdjustmentLayer | null;
  /** Whether the clip's audio is muted */
  muted: boolean;
  /** Audio volume for this clip (0-1) */
  volume: number;
  /** Static stereo position before clip/track pan automation (-1 left to 1 right). */
  pan?: number;
  /** Non-destructive clip-local volume and stereo-pan envelopes. */
  audioAutomation?: AudioAutomation | null;
  /** Audio fade-in duration in seconds (0 = none) */
  fadeInSec?: number;
  /** Audio fade-out duration in seconds (0 = none) */
  fadeOutSec?: number;
  /** Linear by default; equal-power keeps perceived loudness stable in overlaps. */
  audioFadeCurve?: "linear" | "equal-power";
  /** Text rendering params (only for text clips) */
  textParams?: TextParams;
  /** Source transcript binding for generated caption clips. */
  captionBinding?: CaptionBinding;
  /** Reference-edit provenance used by deterministic conformance validation. */
  referenceEditBinding?: ReferenceEditBinding;
  /** Shape rendering params (only for shape clips) */
  shapeParams?: ShapeParams;
  /**
   * Synthetic hold/freeze on the clip edge (marked explicitly — never silent).
   * `out` freezes the last source frame for the last durationSec of the clip;
   * `in` freezes the first source frame for the first durationSec.
   */
  hold?: ClipHold | null;
  /**
   * Nested sequence instance. When set, clip composites that sequence (depth 1).
   * Mutually exclusive with media/text/shape content (`sourceMediaId` must be null).
   */
  sourceSequenceId?: string | null;
}

/** Marked freeze/hold on a clip edge (timeline seconds). */
export interface ClipHold {
  at: "in" | "out";
  durationSec: number;
}

/** Instantaneous playback rate at a clip-local time (speed ramp envelope). */
export interface SpeedRampPoint {
  /** Time within the clip (seconds from clip start) */
  time: number;
  /** Playback rate (≥ 0). 1 = normal, 0 = freeze, 0.5 = half, 2 = 2× */
  rate: number;
  /** Outgoing velocity curve to the next point. */
  interpolation?: "linear" | "smooth" | "hold";
}

/** A durable timeline note/cue used for chapters, review notes, and snapping. */
export interface TimelineMarker {
  id: string;
  time: number;
  label: string;
  color: string;
  type?: "comment" | "chapter" | "todo" | "beat";
}

/** Per-clip retiming quality. Frame blend cross-dissolves adjacent source frames. */
export interface RetimeSettings {
  interpolation: "nearest" | "frame-blend";
  /** Source sampling cadence for frame blending; 12..60, default 30. */
  frameRate?: number;
}

/** A track in the timeline */
export interface Track {
  id: string;
  name: string;
  type: TrackType;
  /** Higher order = rendered on top */
  order: number;
  locked: boolean;
  visible: boolean;
  solo: boolean;
  clips: Clip[];
}

/** Project settings */
export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  duration: number;
  backgroundColor: string;
  sampleRate: number;
  /** Frozen delivery contract for platform format, safety guides, and agent geometry. */
  deliveryProfile?: DeliveryProfile;
}

/** Audio mixer state */
export type TrackAudioRole = "music" | "voice" | "other";

export interface AudioDuckSettings {
  enabled: boolean;
  /** rule = voice-window gain; sidechain = export sidechaincompress / preview envelope approx */
  mode?: "rule" | "sidechain";
  /** Gain applied to music while voice overlaps (0..1) */
  level: number;
  attackSec: number;
  releaseSec: number;
}

/** A point in a clip-local or track-timeline audio envelope (seconds). */
export interface AudioAutomationPoint {
  /** Stable UI identity; legacy/project-imported points may omit it. */
  id?: string;
  time: number;
  /** Volume is 0..2; pan is -1 (left) through 1 (right). */
  value: number;
  interpolation?: "linear" | "hold";
}

/** Independent volume and stereo-pan envelopes. */
export interface AudioAutomation {
  volume?: AudioAutomationPoint[];
  pan?: AudioAutomationPoint[];
}

/** Simple 3-band EQ gains in dB */
export interface TrackEqSettings {
  lowGainDb: number;
  midGainDb: number;
  highGainDb: number;
}

/** Track-level corrective and dynamics chain, in playback order. */
export interface TrackAudioPostSettings {
  denoise: { enabled: boolean; amount: number };
  deEsser: { enabled: boolean; intensity: number; frequency: number };
  compressor: { enabled: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number };
  limiter: { enabled: boolean; ceilingDb: number };
}

/** Final-bus safety and loudness targets for delivered files. */
export interface MasteringSettings {
  limiterEnabled: boolean;
  ceilingDb: number;
  loudnessEnabled: boolean;
  targetLufs: number;
}

export interface AudioMixer {
  masterVolume: number;
  trackVolumes: Record<string, number>;
  /** Static per-track stereo position (-1 left to 1 right). */
  trackPans?: Record<string, number>;
  trackMutes: Record<string, boolean>;
  /** Track-wide envelopes use absolute timeline seconds. */
  trackAutomation?: Record<string, AudioAutomation>;
  /** Per-track role for rule-based ducking */
  trackRoles?: Record<string, TrackAudioRole>;
  duck?: AudioDuckSettings;
  /** Per-track 3-band EQ */
  trackEq?: Record<string, TrackEqSettings>;
  /** Per-track cleanup/dynamics chain. */
  trackPost?: Record<string, TrackAudioPostSettings>;
  /** Final master-bus limiting and loudness normalization. */
  mastering?: MasteringSettings;
}

/**
 * Edit-point transition between two clips on the same track.
 * Not a clip filter — validated + applied via @tempo/editor-core handles.
 */
export interface Transition {
  id: string;
  trackId: string;
  clipAId: string;
  clipBId: string;
  /** Overlap / mix duration in seconds */
  duration: number;
  /** Registry type id, e.g. crossfade, dip-black */
  type: string;
  params: Record<string, number | string | boolean>;
  /** When true, insufficient media handles may be filled with marked clip holds */
  allowHold?: boolean;
}

/** First-class nested sequence / precomp (project library). */
export interface Sequence {
  id: string;
  name: string;
  tracks: Track[];
  transitions: Transition[];
  /** Optional authored default duration hint for place UI */
  durationHint?: number;
}

/** Full project state (the source of truth) */
export interface Project {
  id: string;
  name: string;
  settings: ProjectSettings;
  tracks: Track[];
  /** Project-level edit-point transitions */
  transitions?: Transition[];
  /** Nested sequence library (precomps); clips reference via sourceSequenceId */
  sequences?: Sequence[];
  cameras?: Camera3D[];
  lights?: Light3D[];
  motionGraphs?: MotionGraph[];
  audioMixer: AudioMixer;
  createdAt: string;
  updatedAt: string;
}
