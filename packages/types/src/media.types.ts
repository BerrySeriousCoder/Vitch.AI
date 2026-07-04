// ============================================================
// MEDIA TYPES
// Types for media assets (video, audio, images)
// ============================================================

/** User-uploaded or library font for text clips */
export interface FontAsset {
  id: string;
  /** CSS family name registered via FontFace */
  familyName: string;
  fileName: string;
  /** `/uploads/...` or CDN URL */
  url: string;
  format: "truetype" | "opentype" | "woff" | "woff2";
  projectId?: string | null;
  createdAt: string;
}

/** Project-scoped 3D LUT (.cube) for color grading */
export interface LutAsset {
  id: string;
  name: string;
  fileName: string;
  /** `/uploads/...` or CDN URL */
  url: string;
  format: "cube";
  size?: number | null;
  projectId?: string | null;
  createdAt: string;
}

/** Project-scoped references to reusable assets (fonts, packs) */
export interface ProjectAssets {
  fontIds: string[];
  lutIds?: string[];
  packIds: string[];
}

/** Supported media types */
export type MediaType = "video" | "audio" | "image";

/** Media upload status */
export type UploadStatus = "pending" | "uploading" | "processing" | "ready" | "error";

/** Semantic analysis lifecycle (independent of upload status) */
export type MediaAnalysisStatus = "pending" | "ready" | "error" | "skipped";

/** Lifecycle for an optional lightweight editorial proxy. */
export type MediaProxyStatus = "none" | "processing" | "ready" | "error";

/** Rotation-corrected display orientation used for editorial matching. */
export type MediaOrientation = "portrait" | "landscape" | "square" | "unknown";

/** A notable moment inside a video (seconds on source timeline) */
export interface MediaAnalysisMoment {
  t: number;
  label: string;
}

/**
 * Vision / classifier output for agent + UI.
 * Stored inside MediaMetadata.analysis (JSONB).
 */
export interface MediaAnalysis {
  summary: string;
  tags: string[];
  subjects: string[];
  shotType?: string;
  cameraMotion?: string;
  mood?: string;
  setting?: string;
  colorPalette?: string[];
  textInFrame?: string[];
  bestFor?: string[];
  moments?: MediaAnalysisMoment[];
  model: string;
  analyzedAt: string;
  error?: string;
}

/**
 * Decoded-pixel color measurements from representative video/image frames.
 * Values are normalized 0..1 and safe to compare across media assets.
 */
export interface ColorStatistics {
  meanRed: number;
  meanGreen: number;
  meanBlue: number;
  meanLuma: number;
  lumaStdDev: number;
  meanSaturation: number;
  blackPoint: number;
  whitePoint: number;
  sampleCount: number;
  sampledAt: string;
  source: "ffmpeg" | "palette";
}

/** Beat / energy grid from local onset analysis */
export interface MediaAudioRhythm {
  bpm: number;
  beats: { time: number; strength: number; isDownbeat: boolean }[];
  energyCurve: { time: number; energy: number }[];
  mood?: string;
  genre?: string;
  analyzedAt: string;
  model: string;
  error?: string;
}

export type TranscriptKind =
  | "speech"
  | "singing"
  | "mixed"
  | "music_instrumental"
  | "unknown";

export interface TranscriptWord {
  /** Stable within one transcript revision */
  id: string;
  start: number;
  end: number;
  text: string;
  confidence?: number;
  speaker?: string;
}

export interface TranscriptSegment {
  /** Stable within one transcript revision; optional on legacy transcripts */
  id?: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  wordIds?: string[];
  confidence?: number;
}

/** One indexed shot (scene) inside a media asset — source timeline seconds */
export interface ShotIndexEntry {
  id: string;
  assetId: string;
  start: number;
  end: number;
  summary?: string;
  tags: string[];
  subjects: string[];
  shotType?: string;
  cameraMotion?: string;
  mood?: string;
  /** 0..1 energy estimate */
  energy?: number;
  /** Role hints e.g. hook, broll */
  bestFor: string[];
  /** Optional embedding vector for similarity ranking */
  embedding?: number[];
  thumbnailUrl?: string;
  analyzedAt: string;
}

/** Scene-level shot index stored on MediaMetadata.shotIndex */
export interface ShotIndex {
  schemaVersion: 1;
  shots: ShotIndexEntry[];
  model: string;
  analyzedAt: string;
}

/** Timed speech/lyric transcript from OpenAI Whisper ASR */
export interface MediaAudioTranscript {
  /** Version 1 is legacy segment-only data; version 2 includes words + provenance. */
  schemaVersion?: 1 | 2;
  /** Changes every time source transcription/alignment is regenerated. */
  revision?: string;
  pipeline?: "speech" | "lyrics";
  language?: string;
  kind: TranscriptKind;
  summary: string;
  words?: TranscriptWord[];
  segments: TranscriptSegment[];
  sourceDuration?: number;
  model: string;
  alignmentModel?: string;
  analyzedAt: string;
  warnings?: string[];
  error?: string;
  usage?: {
    durationSeconds: number;
    estimatedCostUsd: number;
  };
}

/** Metadata extracted from a media file (+ optional semantic analysis) */
export interface MediaMetadata {
  /** Encoded raster dimensions before display rotation / sample-aspect correction. */
  width?: number;
  height?: number;
  /** Display dimensions after rotation and non-square-pixel correction. */
  displayWidth?: number;
  displayHeight?: number;
  sampleAspectRatio?: string;
  displayAspectRatio?: string;
  /** Derived from displayWidth/displayHeight after rotation and SAR correction. */
  orientation?: MediaOrientation;
  /** Clockwise display rotation reported by the container. */
  rotation?: 0 | 90 | 180 | 270;
  duration?: number;
  fps?: number;
  /** True when the container and average frame rates materially disagree. */
  isVariableFrameRate?: boolean;
  codec?: string;
  pixelFormat?: string;
  bitDepth?: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
  isHdr?: boolean;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  fileSize: number;
  mimeType: string;
  /** Explicitly distinguishes JSON vector animation from an ordinary JSON upload. */
  graphicFormat?: "lottie";
  /** Semantic classifier status */
  analysisStatus?: MediaAnalysisStatus;
  /** Flash vision / classifier result */
  analysis?: MediaAnalysis;
  /** Pixel-level color profile used by Color Match and Edit Like This. */
  colorStatistics?: ColorStatistics;
  /** Scene-level shot index for ranking / Edit Like This */
  shotIndex?: ShotIndex;
  /** Local beat grid + energy (audio / video soundtrack) */
  audioRhythm?: MediaAudioRhythm;
  /** Timed transcript / lyrics (audio / video soundtrack) */
  audioTranscript?: MediaAudioTranscript;
  /** pending | ready | error | skipped for audio pipeline */
  audioAnalysisStatus?: MediaAnalysisStatus;
  /** Preview proxy lifecycle; the original is always retained for export. */
  proxyStatus?: MediaProxyStatus;
  proxyError?: string;
  /** Human-readable encode profile, e.g. 960px H.264 editorial proxy. */
  proxyProfile?: string;
  /** Provenance for audio durably imported by Edit Like This. */
  referenceAudio?: {
    sourceUrl: string;
    blueprintId: string;
    rightsConfirmedAt: string;
    importedAt: string;
  };
  /** Provenance for a reference video retained for later agent inspection. */
  referenceVideo?: {
    sourceUrl: string;
    blueprintId: string;
    importedAt: string;
  };
  /** Durable local CV observations retained for later forensic rechecks. */
  referenceAnalysisEvidence?: import("./ai.types.js").ReferenceAnalysisEvidence;
}

/** A media asset in the library */
export interface MediaAsset {
  id: string;
  projectId: string;
  name: string;
  type: MediaType;
  /** URL to the stored file */
  url: string;
  /** URL to thumbnail image */
  thumbnailUrl: string | null;
  /** URL to a low-res proxy for preview */
  proxyUrl: string | null;
  /** URL to waveform data (for audio) */
  waveformUrl: string | null;
  /** Duration in seconds (video/audio); null for still images */
  duration: number | null;
  metadata: MediaMetadata;
  status: UploadStatus;
  createdAt: string;
}

/** Media upload request */
export interface MediaUploadRequest {
  projectId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}
