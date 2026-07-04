// ============================================================
// AI TYPES
// Types for the AI Creative Director agent system
// ============================================================

/** Role in AI conversation */
export type AIRole = "user" | "assistant" | "system" | "tool";

/** Ordered transcript part — source of truth for Cursor-style chat render */
export type AIMessagePart =
  | { type: "text"; id: string; text: string }
  | {
      type: "reasoning";
      id: string;
      stepId: string;
      text: string;
      status: "streaming" | "done";
    }
  | {
      type: "reply";
      id: string;
      stepId: string;
      text: string;
      status: "streaming" | "done";
    }
  | {
      type: "phase";
      id: string;
      phaseId: string;
      title: string;
      detail?: string;
    }
  | {
      type: "tool";
      id: string;
      stepId?: string;
      name: string;
      arguments: Record<string, unknown>;
      argumentsText?: string;
      result?: unknown;
      error?: string;
      durationMs?: number;
      mutating?: boolean;
      status: "running" | "done" | "error";
    };

/** A message in the AI conversation */
export interface AIMessage {
  id: string;
  role: AIRole;
  content: string;
  /** Chronological stream blocks (text interleaved with tools). Prefer over flat fields for UI. */
  parts?: AIMessagePart[];
  /** Legacy / mirror — derived from parts when present */
  toolCalls?: AIToolCall[];
  /** Legacy / mirror — derived from parts when present */
  toolResults?: AIToolResult[];
  timestamp: string;
}

/** An AI tool call (function calling) */
export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result from executing a tool */
export interface AIToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  error?: string;
}

/** Tool definition for the AI agent */
export interface AIToolDefinition {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, AIToolParameter>;
  required: string[];
}

/** Parameter definition for an AI tool */
export interface AIToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  default?: unknown;
}

// ============================================================
// EDIT BLUEPRINT (for "Edit Like This" feature)
// ============================================================

import type { ColorStatistics } from "./media.types.js";

/** A single segment in the edit blueprint */
export interface BlueprintSegment {
  index: number;
  /** Start time in the reference video (seconds) */
  startTime: number;
  /** Duration of this segment (seconds) */
  duration: number;
  /** Type of shot */
  shotType: "close-up" | "medium" | "wide" | "extreme-close-up" | "bird-eye" | "other";
  /** Camera/visual motion */
  motionType: "static" | "pan" | "zoom-in" | "zoom-out" | "shake" | "whip-pan" | "tracking" | "rotate";
  /** Transition to the next segment */
  transitionToNext: "cut" | "fade" | "dissolve" | "zoom" | "whip" | "glitch" | "swipe" | "none";
  /** Visual energy level 0-100 */
  energyLevel: number;
  /** Description of what's happening visually */
  visualDescription: string;
  /** Color palette dominant colors */
  colorPalette: string[];
  /** Effects used in this segment */
  effects: string[];
  /** Text overlays */
  textOverlays: BlueprintTextOverlay[];
  /** Whether this segment aligns with a music beat */
  onBeat: boolean;
  /** Speed of the footage (1 = normal) */
  speed: number;
  /** Measured multi-layer composition inside this deterministic scene span. */
  composition?: BlueprintComposition;
  /** Detailed transition recipe. Presets are optional implementation hints, not the source of truth. */
  transitionSpec?: BlueprintTransitionSpec;
}

export type BlueprintMotionEasing =
  | "hold"
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out";

export interface BlueprintNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A sampled state inside a layer's own visible interval. */
export interface BlueprintLayerKeyframe {
  timeRatio: number;
  /** Optional measured audio event anchor; takes precedence over timeRatio. */
  syncEventId?: string;
  easing?: BlueprintMotionEasing;
  viewport?: BlueprintNormalizedRect;
  opacity?: number;
  offsetXRatio?: number;
  offsetYRatio?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
}

export interface BlueprintLayerMotion {
  keyframes: BlueprintLayerKeyframe[];
  confidence?: number;
}

/**
 * One independently timed media surface observed inside a reference scene.
 * The asset matcher assigns a user source to every layer id independently.
 */
export interface BlueprintMediaLayer {
  id: string;
  role: "background" | "panel" | "matte-fill" | "overlay";
  contentDescription: string;
  zIndex: number;
  timing: { startRatio: number; endRatio: number; confidence?: number };
  viewport: BlueprintNormalizedRect;
  fit: "cover" | "contain";
  focalPoint?: { x: number; y: number };
  motion?: BlueprintLayerMotion;
  /** Make this media visible only through the alpha of the referenced text overlay. */
  matteTextOverlayIndex?: number;
}

export interface BlueprintComposition {
  /** Skip the ordinary full-frame segment clip when layers fully define the scene. */
  replaceBase: boolean;
  backgroundColor?: string;
  layers: BlueprintMediaLayer[];
  /** Explicit visibility/overlap phases inside one cut interval. */
  phases?: BlueprintCompositionPhase[];
  confidence?: number;
}

export interface BlueprintCompositionPhase {
  id: string;
  label: string;
  startRatio: number;
  endRatio: number;
  syncEventId?: string;
  activeLayerIds: string[];
  activeTextOverlayIndices: number[];
  confidence?: number;
}

export interface BlueprintTransitionSpec {
  durationRatio?: number;
  direction?: "left" | "right" | "up" | "down";
  softness?: number;
  easing?: BlueprintMotionEasing;
  /** Registry id only when the observed transition genuinely matches one. */
  presetType?: string;
  /** Measured outgoing/incoming motion used when no registry preset matches. */
  outgoing?: BlueprintLayerMotion;
  incoming?: BlueprintLayerMotion;
  confidence?: number;
}

export interface BlueprintTextAnimatorChannel {
  property: "opacity" | "offsetX" | "offsetY" | "scale" | "rotation" | "tracking" | "blur";
  from: number;
  to: number;
  offsetRatio: number;
  durationRatio: number;
  staggerRatio: number;
  /** Explicit per-unit event ratios for irregular rhythmic animation. */
  unitStartRatios?: number[];
  /** Locally detected impact ids; resolved to exact clip-local times by the compiler. */
  unitSyncEventIds?: string[];
  /** Multi-stage curve relative to each unit start, normalized to overlay duration. */
  keyframes?: Array<{ timeRatio: number; value: number; easing?: BlueprintMotionEasing }>;
  easing?: BlueprintMotionEasing;
}

export interface BlueprintTextAnimation {
  unit: "whole" | "char" | "word" | "line";
  channels: BlueprintTextAnimatorChannel[];
  /** Whole-layer motion is separate from per-unit motion and must be observed, never inferred from style. */
  motion?: BlueprintLayerMotion;
  confidence?: number;
}

/** Text overlay info from the reference video */
export interface BlueprintTextOverlay {
  text: string;
  style: "bold" | "minimal" | "kinetic" | "typewriter" | "glitch" | "bounce";
  position: "top" | "center" | "bottom" | "custom";
  animation: string;
  /** Global compositing order shared with composition layer zIndex values. */
  zIndex?: number;
  /** Measured animation recipe; when present it supersedes the nearest-preset label. */
  animationSpec?: BlueprintTextAnimation;
  /** How the glyphs are painted in the reference. */
  fillMode?: "solid" | "media-matte";
  /** How this overlay participates in a timed text sequence. */
  sequenceMode?: "static" | "cumulative" | "exclusive";
  /** Stable id shared by the word/text states that belong to one sequence. */
  sequenceGroupId?: string;
  /** Whether the backing color hugs text or replaces the full video frame. */
  backgroundMode?: "text-box" | "full-frame";
  /** Typography and paint measured from the reference frames. */
  appearance?: {
    fontFamilyClass?: "sans" | "serif" | "display" | "monospace" | "handwritten";
    /** Closest Google Fonts family observed by the reference model. */
    fontFamilyHint?: string;
    /** Visual width class used when an exact family cannot be identified. */
    fontWidth?: "condensed" | "normal" | "wide";
    fontWeight?: number;
    /** Approximate cap-height/font-size as a fraction of composition height. */
    fontSizeRatio?: number;
    color?: string;
    strokeColor?: string;
    strokeWidthRatio?: number;
    backgroundColor?: string;
    backgroundOpacity?: number;
    textAlign?: "left" | "center" | "right";
    /** Letter spacing as a fraction of the inferred font size. */
    letterSpacingRatio?: number;
    uppercase?: boolean;
    shadow?: boolean;
    rotation?: number;
    confidence?: number;
  };
  /**
   * Reference-frame geometry in normalized composition coordinates. x/y are
   * the overlay centre, matching Tempo's GraphicLayout coordinate contract.
   */
  geometry?: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    confidence?: number;
  };
  /** Approximate visibility window inside the segment, normalized 0..1. */
  timing?: {
    startRatio: number;
    endRatio: number;
    confidence?: number;
  };
}

/** Beat information from audio analysis */
export interface BeatInfo {
  time: number;
  strength: number;
  isDownbeat: boolean;
}

export interface AudioImpactEvent extends BeatInfo {
  id: string;
  kind: "onset" | "beat" | "downbeat";
  confidence?: number;
}

/** Audio analysis from the reference video */
export interface AudioAnalysis {
  bpm: number;
  beats: BeatInfo[];
  /** Measured non-periodic transient/impact events, retained even without a valid BPM grid. */
  impacts?: AudioImpactEvent[];
  energyCurve: { time: number; energy: number }[];
  mood: string;
  genre: string;
  /** True only when the grid came from measured onsets, never a metronome guess. */
  beatSource?: "detected" | "unavailable";
  beatConfidence?: number;
  warnings?: string[];
}

export interface ReferenceEvidenceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Deterministic, local observation sampled from decoded reference pixels. */
export interface ReferenceFrameEvidence {
  time: number;
  changeScore: number;
  meanLuma: number;
  blackRatio: number;
  foreground?: ReferenceEvidenceRect;
  components: ReferenceEvidenceRect[];
  /** Median direction and mean magnitude from dense optical flow, normalized to the frame. */
  flow?: { dx: number; dy: number; magnitude: number };
}

export interface ReferenceSceneEvidence {
  sceneIndex: number;
  startTime: number;
  endTime: number;
  frames: ReferenceFrameEvidence[];
  eventTimes: number[];
  maxVisibleComponents: number;
  /** Set when the local OCR adapter measured text rather than the VLM inferring it. */
  textObservations?: Array<{
    time: number;
    text: string;
    confidence: number;
    rect: ReferenceEvidenceRect;
  }>;
}

export interface ReferenceAnalysisEvidence {
  schemaVersion: 1;
  provider: "tempo-local-cv" | "tempo-opencv-paddleocr";
  analysisFps: number;
  width: number;
  height: number;
  scenes: ReferenceSceneEvidence[];
  warnings?: string[];
}

/** Soundtrack and source-audio contract for an Edit Like This run. */
export interface EditLikeThisAudioPolicy {
  /** Which durable asset should provide the recreation soundtrack. */
  soundtrack: "reference" | "uploaded" | "none";
  /** How audio embedded in the user's mapped video clips should be mixed. */
  sourceAudio: "mute" | "keep" | "duck";
  /** Required when soundtrack=uploaded; must belong to the current project. */
  uploadedAudioAssetId?: string;
  /** Required when soundtrack=reference. The server never assumes reuse rights. */
  referenceAudioAuthorized?: boolean;
  /** Linear gain for the soundtrack clip. */
  soundtrackVolume: number;
  /** Linear gain for audio embedded in mapped source clips. */
  sourceVolume: number;
  /** Music gain while source dialogue is active when sourceAudio=duck. */
  duckLevel: number;
}

/** The full edit blueprint — output of analyzing a reference video */
export interface EditBlueprint {
  id: string;
  referenceUrl: string;
  totalDuration: number;
  aspectRatio: string;
  /** Source dimensions retained so delivery geometry does not depend on parsing a ratio string. */
  referenceWidth?: number;
  referenceHeight?: number;
  /** Durable project media asset retained for follow-up reference inspection. */
  referenceAssetId?: string;
  /** Decoded representative-frame color profile of the reference video. */
  colorStatistics?: ColorStatistics;
  segments: BlueprintSegment[];
  audioAnalysis: AudioAnalysis;
  overallStyle: {
    colorGrading: string;
    pacing: "slow" | "moderate" | "fast" | "variable";
    mood: string;
    genre: string;
  };
  /** Auditable model usage and estimated API cost for reference analysis. */
  analysisUsage?: ReferenceAnalysisUsage;
  /** Non-fatal degradation notes, including fallback analysis paths. */
  analysisWarnings?: string[];
  /** Local pixel/audio measurements used to constrain the generative analysis. */
  analysisEvidence?: ReferenceAnalysisEvidence;
  createdAt: string;
}

export interface ReferenceAnalysisUsage {
  model: string;
  videoFps: number;
  mediaResolution: "high" | "medium" | "low";
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  estimatedInputUsd: number;
  estimatedOutputUsd: number;
  estimatedTranscriptionUsd: number;
  estimatedTotalUsd: number;
}

/** Structured agent edit plan (user request → steps), distinct from EditBlueprint / StyleDNA */
export type EditPlanStepStatus = "pending" | "in_progress" | "done" | "failed";

export interface EditPlanStepToolHint {
  tool: string;
  argsSketch?: Record<string, unknown>;
}

export interface EditPlanShotCriteria {
  role?: string;
  tags?: string[];
  energy?: string;
  query?: string;
}

export interface EditPlanStep {
  id: string;
  purpose: string;
  status: EditPlanStepStatus;
  notes?: string;
  durationSec?: number;
  toolHints?: EditPlanStepToolHint[];
  shotCriteria?: EditPlanShotCriteria;
  acceptance?: string;
  /** Issue codes from last critique that relate to this step */
  critiqueIssueCodes?: string[];
  lastCritiqueAt?: string;
}

export interface EditPlan {
  goal: string;
  durationSec?: number;
  steps: EditPlanStep[];
  updatedAt?: string;
}

/** Vision critic issue from critique_preview */
export interface CritiqueIssue {
  severity: "info" | "warn" | "error";
  time: number;
  code: string;
  message: string;
  fixHint?: string;
  clipId?: string;
}

/** Structured scorecard returned by critique_preview */
export interface CritiqueScorecard {
  overall?: number;
  dims?: {
    visual?: number;
    pacing?: number;
    typography?: number;
  };
  issues: CritiqueIssue[];
  sampledTimes: number[];
}
