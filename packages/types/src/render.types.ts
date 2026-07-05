// ============================================================
// RENDER TYPES
// Types for video export and render jobs
// ============================================================

/** Render job status */
export type RenderStatus =
  | "queued"
  | "processing"
  | "encoding"
  | "uploading"
  | "completed"
  | "failed";

/** Video codec options. Mezzanine codecs are intended for finishing/master delivery. */
export type VideoCodec =
  | "h264"
  | "h265"
  | "vp9"
  | "av1"
  | "prores-422-hq"
  | "prores-4444"
  | "dnxhr-hqx"
  | "dnxhr-444";

/** Audio codec options */
export type AudioCodec = "aac" | "opus" | "mp3" | "pcm-s24le";

/** Export format options */
export type ExportFormat = "mp4" | "webm" | "mov" | "gif";

/** Export quality preset */
export type QualityPreset = "draft" | "standard" | "high" | "ultra";

/** Output transfer/gamut contract. HDR modes always require a 10-bit-or-better codec. */
export type ExportColorSpace = "rec709" | "rec2100-pq" | "rec2100-hlg";

/** Encoded component precision. */
export type ExportBitDepth = 8 | 10;

/** Static HDR10 mastering metadata. Values are in cd/m² (nits). */
export interface HdrMasteringMetadata {
  /** Mastering-display peak luminance. */
  maxLuminance: number;
  /** Mastering-display black level. */
  minLuminance: number;
  /** Maximum content light level. */
  maxCll: number;
  /** Maximum frame-average light level. */
  maxFall: number;
}

/** Export settings for a render job */
export interface ExportSettings {
  format: ExportFormat;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  width: number;
  height: number;
  fps: number;
  /** @deprecated Retained for old render jobs; qualityPreset controls CRF. */
  videoBitrate: string;
  audioBitrate: string;
  qualityPreset: QualityPreset;
  /** Defaults to Rec.709 for render jobs created before color management. */
  colorSpace?: ExportColorSpace;
  /** H.264 is 8-bit; HEVC HDR and mezzanine masters are 10-bit. */
  bitDepth?: ExportBitDepth;
  /** Present for PQ/HDR10 delivery. Ignored by SDR and HLG profiles. */
  hdrMetadata?: HdrMasteringMetadata;
}

/** A render job */
export interface RenderJob {
  id: string;
  projectId: string;
  userId: string;
  status: RenderStatus;
  progress: number;
  settings: ExportSettings;
  outputUrl: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
