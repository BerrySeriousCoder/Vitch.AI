import { execFile } from "child_process";
import { promisify } from "util";
import { ffmpegSidechainCompressOpts } from "@tempo/editor-core";
import type {
  AudioCodec,
  EffectParamValue,
  ExportBitDepth,
  ExportColorSpace,
  HdrMasteringMetadata,
  QualityPreset,
  VideoCodec,
} from "@tempo/types";
import { logger } from "./logger.js";

const exec = promisify(execFile);

export interface ProbeResult {
  duration: number;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  sampleAspectRatio?: string;
  displayAspectRatio?: string;
  rotation?: 0 | 90 | 180 | 270;
  fps?: number;
  isVariableFrameRate?: boolean;
  videoCodec?: string;
  audioCodec?: string;
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
  hasVideo?: boolean;
  hasAudio?: boolean;
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  const rate = numerator! / denominator!;
  return rate > 0 ? Math.round(rate * 1000) / 1000 : undefined;
}

function normalizeRotation(value: unknown): 0 | 90 | 180 | 270 {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = ((Math.round(numeric) % 360) + 360) % 360;
  if (normalized >= 315 || normalized < 45) return 0;
  if (normalized < 135) return 90;
  if (normalized < 225) return 180;
  return 270;
}

function parseRatio(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "0:1" || value === "N/A") return undefined;
  const [numerator, denominator] = value.split(":").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator! / denominator!;
}

export async function probe(filePath: string): Promise<ProbeResult> {
  try {
    const { stdout } = await exec("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);

    const data = JSON.parse(stdout);
    const format = data.format || {};
    const videoStream = (data.streams || []).find((s: any) => s.codec_type === "video");
    const audioStream = (data.streams || []).find((s: any) => s.codec_type === "audio");

    const averageFps = parseRate(videoStream?.avg_frame_rate);
    const containerFps = parseRate(videoStream?.r_frame_rate);
    const fps = averageFps || containerFps;
    const rotation = normalizeRotation(
      videoStream?.side_data_list?.find((entry: any) => entry?.rotation !== undefined)?.rotation
        ?? videoStream?.tags?.rotate
    );
    const width = Number(videoStream?.width) || undefined;
    const height = Number(videoStream?.height) || undefined;
    const sampleAspect = parseRatio(videoStream?.sample_aspect_ratio) || 1;
    const rotated = rotation === 90 || rotation === 270;
    const correctedWidth = width ? Math.round(width * sampleAspect) : undefined;
    const displayWidth = rotated ? height : correctedWidth;
    const displayHeight = rotated ? correctedWidth : height;
    const colorTransfer = videoStream?.color_transfer || undefined;
    const colorPrimaries = videoStream?.color_primaries || undefined;
    const isHdr = colorTransfer === "smpte2084" || colorTransfer === "arib-std-b67";

    return {
      duration: parseFloat(format.duration) || 0,
      width,
      height,
      displayWidth,
      displayHeight,
      sampleAspectRatio: videoStream?.sample_aspect_ratio || undefined,
      displayAspectRatio: videoStream?.display_aspect_ratio || undefined,
      rotation,
      fps,
      isVariableFrameRate: Boolean(
        averageFps && containerFps && Math.abs(averageFps - containerFps) / averageFps > 0.01
      ),
      videoCodec: videoStream?.codec_name,
      audioCodec: audioStream?.codec_name,
      pixelFormat: videoStream?.pix_fmt,
      bitDepth: Number(videoStream?.bits_per_raw_sample) || undefined,
      colorPrimaries,
      colorTransfer,
      colorSpace: videoStream?.color_space || undefined,
      colorRange: videoStream?.color_range || undefined,
      isHdr,
      bitrate: parseInt(format.bit_rate) || undefined,
      sampleRate: audioStream ? parseInt(audioStream.sample_rate) : undefined,
      channels: audioStream?.channels,
      hasVideo: Boolean(videoStream),
      hasAudio: Boolean(audioStream),
    };
  } catch (err: any) {
    logger.warn({ err: err.message }, "ffprobe failed -- ffmpeg may not be installed");
    return { duration: 0 };
  }
}

export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  time: number = 1
): Promise<boolean> {
  try {
    await exec("ffmpeg", [
      "-y", "-ss", String(time),
      "-i", inputPath,
      "-vframes", "1",
      "-vf", "scale=320:-1",
      "-q:v", "5",
      outputPath,
    ]);
    return true;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Thumbnail generation failed");
    return false;
  }
}

/**
 * Lightweight H.264/AAC editorial proxy. It deliberately preserves timeline
 * duration and audio so the browser can substitute it without changing edits.
 */
export async function generateEditorialProxy(
  inputPath: string,
  outputPath: string,
  maxLongEdge = 1280
): Promise<boolean> {
  try {
    const edge = Math.max(480, Math.round(maxLongEdge));
    await exec("ffmpeg", [
      "-y", "-i", inputPath,
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", `scale=w='if(gte(iw,ih),min(${edge},iw),-2)':h='if(gte(iw,ih),-2,min(${edge},ih))':flags=lanczos+accurate_rnd+full_chroma_int`,
      "-c:v", "libx264", "-preset", "faster", "-crf", "22",
      // Browser-compatible editing proxy: one-second forced keyframes make
      // seeks/scrubs bounded even when the source is long-GOP or VFR.
      "-profile:v", "high", "-g", "60", "-keyint_min", "1", "-sc_threshold", "0",
      "-force_key_frames", "expr:gte(t,n_forced*1)",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "aac", "-b:a", "128k",
      outputPath,
    ], { maxBuffer: 100 * 1024 * 1024 });
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, inputPath }, "Editorial proxy generation failed");
    return false;
  }
}

export const ANALYSIS_PROXY_TARGET_BYTES = 10 * 1024 * 1024;

/**
 * Calculate a bounded analysis bitrate while reserving room for low-bitrate
 * audio and MP4 container overhead. The result is intentionally conservative:
 * the encoded bytes are base64-expanded again when sent inline to Gemini.
 */
export function analysisProxyVideoBitrateKbps(
  duration: number,
  targetBytes = ANALYSIS_PROXY_TARGET_BYTES
): number {
  const safeDuration = Math.max(0.1, Number(duration) || 0.1);
  const usableTotalKbps = Math.floor((Math.max(1024, targetBytes) * 8 * 0.86) / safeDuration / 1000);
  return Math.max(96, Math.min(2500, usableTotalKbps - 48));
}

/**
 * Size-bounded H.264/AAC proxy for inline multimodal analysis. Unlike the
 * browser editorial proxy, this optimizes for temporal evidence per request
 * byte and retains mono audio so the model can verify audible events.
 */
export async function generateAnalysisVideoProxy(
  inputPath: string,
  outputPath: string,
  duration: number,
  options: { targetBytes?: number; signal?: AbortSignal } = {}
): Promise<boolean> {
  try {
    const targetBytes = options.targetBytes || ANALYSIS_PROXY_TARGET_BYTES;
    const videoKbps = analysisProxyVideoBitrateKbps(duration, targetBytes);
    const fps = duration > 180 ? 12 : duration > 60 ? 18 : 24;
    const edge = duration > 180 ? 854 : 1280;
    await exec("ffmpeg", [
      "-y", "-i", inputPath,
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", `scale=w='if(gte(iw,ih),min(${edge},iw),-2)':h='if(gte(iw,ih),-2,min(${edge},ih))':flags=lanczos,fps=${fps}`,
      "-c:v", "libx264", "-preset", "faster",
      "-b:v", `${videoKbps}k`,
      "-maxrate", `${Math.ceil(videoKbps * 1.15)}k`,
      "-bufsize", `${videoKbps * 2}k`,
      "-profile:v", "high", "-g", String(fps), "-keyint_min", "1", "-sc_threshold", "0",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "aac", "-ac", "1", "-ar", "32000", "-b:a", "48k",
      outputPath,
    ], { maxBuffer: 100 * 1024 * 1024, signal: options.signal });
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, inputPath }, "Analysis video proxy generation failed");
    return false;
  }
}

/** Extract a single JPEG frame for vision analysis (~480px wide). */
export async function extractAnalysisFrame(
  inputPath: string,
  outputPath: string,
  time: number
): Promise<boolean> {
  try {
    await exec("ffmpeg", [
      "-y",
      "-ss",
      String(Math.max(0, time)),
      "-i",
      inputPath,
      "-vframes",
      "1",
      "-vf",
      "scale=480:-1",
      "-q:v",
      "4",
      outputPath,
    ]);
    return true;
  } catch (err: any) {
    logger.warn({ err: err.message, time }, "Analysis frame extraction failed");
    return false;
  }
}

export async function extractAudio(
  inputPath: string,
  outputPath: string
): Promise<boolean> {
  try {
    await exec("ffmpeg", [
      "-y", "-i", inputPath,
      "-vn", "-acodec", "pcm_s16le",
      "-ar", "44100", "-ac", "2",
      outputPath,
    ]);
    return true;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Audio extraction failed");
    return false;
  }
}

/**
 * Compress audio/video soundtrack to mono 16 kHz MP3 for OpenAI Whisper (~25MB limit).
 * ~0.5 MB/min → ~40+ minutes fits under the cap (vs a few minutes of PCM WAV).
 */
export async function compressAudioForAsr(
  inputPath: string,
  outputPath: string
): Promise<boolean> {
  try {
    await exec("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      "-c:a",
      "libmp3lame",
      outputPath,
    ]);
    return true;
  } catch (err: any) {
    logger.warn({ err: err.message }, "ASR audio compress failed");
    return false;
  }
}

export async function generateWaveform(
  inputPath: string,
  outputPath: string,
  samplesPerSecond: number = 10
): Promise<boolean> {
  try {
    const probeResult = await probe(inputPath);
    const duration = probeResult.duration || 60;
    const totalSamples = Math.ceil(duration * samplesPerSecond);

    const { stdout } = await exec("ffmpeg", [
      "-i", inputPath,
      "-af", `aresample=8000,astats=metadata=1:reset=${Math.ceil(8000 / samplesPerSecond)}`,
      "-f", "null", "-",
    ], { maxBuffer: 50 * 1024 * 1024 });

    const peaks: number[] = new Array(totalSamples).fill(0);
    const lines = stdout.split("\n");
    let sampleIdx = 0;
    for (const line of lines) {
      const match = line.match(/RMS_level=(-?\d+\.?\d*)/);
      if (match && sampleIdx < totalSamples) {
        const db = parseFloat(match[1]!);
        peaks[sampleIdx] = Math.max(0, Math.min(1, (db + 60) / 60));
        sampleIdx++;
      }
    }

    const { writeFile } = await import("fs/promises");
    await writeFile(outputPath, JSON.stringify({ peaks, sampleRate: samplesPerSecond, duration }));
    return true;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Waveform generation failed");
    return false;
  }
}

export interface RenderInputFile {
  path: string;
  /** In-point within the source media, in seconds. Kept for API compatibility. */
  startTime: number;
  /** Start time on the output timeline, in seconds. */
  timelineStart?: number;
  /** Timeline duration of the clip, in seconds. */
  duration: number;
  /** Source playback rate (2 = twice as fast). */
  speed?: number;
  volume?: number;
  /** Dynamic volume expression (clip-local t) — overrides constant volume when set. */
  volumeExpr?: string;
  /** Dynamic stereo balance expression (clip-local t, -1 left through 1 right). */
  panExpr?: string;
  /** Extra audio filters (e.g. equalizer) applied after volume/afade. */
  audioFilters?: string[];
  fadeInSec?: number;
  fadeOutSec?: number;
  audioFadeCurve?: "linear" | "equal-power";
  /** Helps choose video/image/audio behavior without probing when known. */
  mediaType?: "video" | "audio" | "image";
  /** Absolute timeline fade-out (crossfade / dip-black outgoing). */
  videoFadeOut?: { start: number; duration: number };
  /** Absolute timeline fade-in (crossfade / dip-black incoming). */
  videoFadeIn?: { start: number; duration: number };
  /** Clip id for attaching transition fades in the worker. */
  clipId?: string;
  /**
   * Per-clip visual effects (approx FFmpeg mapping).
   * Glow/grain are weak approximations until frame-path export.
   */
  effects?: Array<{
    type: string;
    enabled?: boolean;
    params?: Record<string, EffectParamValue>;
  }>;
  /** Absolute path to a .cube file when a lut effect is present. */
  lutCubePath?: string;
  /** Freeze-hold: mute audio during hold window (matches preview). */
  hold?: { at: "in" | "out"; durationSec: number };
  /** Mixer role — used for FFmpeg sidechaincompress path. */
  audioRole?: "music" | "voice" | "other";
  /**
   * When true, skip this clip's audio in the FFmpeg mix
   * (speed ramp / reverse — matches preview mute until variable-rate audio ships).
   */
  muteAudio?: boolean;
}

export interface RenderOptions {
  inputFiles: RenderInputFile[];
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate?: string;
  audioBitrate?: string;
  codec?: "libx264" | "libx265";
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  colorSpace?: ExportColorSpace;
  bitDepth?: ExportBitDepth;
  hdrMetadata?: HdrMasteringMetadata;
  qualityPreset?: QualityPreset;
  /** Explicit output duration; useful for text-only timelines and trailing captions. */
  duration?: number;
  backgroundColor?: string;
  masterVolume?: number;
  /** ASS subtitle file rendered after all visual layers have been composed. */
  subtitlePath?: string;
  /** Directory of font files for libass (`fontsdir=`). */
  fontsDir?: string;
  /** Duck music from voice via sidechaincompress (export audio mix). */
  sidechainDuck?: { level: number; attackSec: number; releaseSec: number };
  /** Final master-bus filters (e.g. loudnorm/alimiter). */
  masteringFilters?: string[];
  onProgress?: (percent: number) => void;
}

function videoQualityArgs(codec: "libx264" | "libx265", quality: QualityPreset = "high", bitDepth: ExportBitDepth = 8): string[] {
  const table: Record<QualityPreset, { h264: number; h265: number; preset: string }> = {
    draft: { h264: 26, h265: 28, preset: "veryfast" },
    standard: { h264: 20, h265: 22, preset: "medium" },
    high: { h264: 17, h265: 19, preset: "slow" },
    ultra: { h264: 14, h265: 16, preset: "slower" },
  };
  const selected = table[quality];
  return [
    "-preset", selected.preset,
    "-crf", String(codec === "libx265" ? selected.h265 : selected.h264),
    ...(codec === "libx264" ? ["-profile:v", "high"] : ["-profile:v", bitDepth === 10 ? "main10" : "main"]),
  ];
}

const DEFAULT_HDR_METADATA: HdrMasteringMetadata = {
  maxLuminance: 1000,
  minLuminance: 0.0001,
  maxCll: 1000,
  maxFall: 400,
};

function x265MasterDisplay(metadata: HdrMasteringMetadata): string {
  // Display P3-D65 mastering primaries inside a Rec.2020 container. x265 uses
  // chromaticity coordinates in 0.00002 units and luminance in 0.0001 nit.
  const max = Math.max(100, Math.min(10_000, metadata.maxLuminance));
  const min = Math.max(0.00001, Math.min(5, metadata.minLuminance));
  return `G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(${Math.round(max * 10_000)},${Math.round(min * 10_000)})`;
}

export interface VideoEncodingProfile {
  args: string[];
  pixelFormat: string;
  extension: "mp4" | "mov";
  audioCodec: AudioCodec;
  colorSpace: ExportColorSpace;
  bitDepth: ExportBitDepth;
}

/** Resolve one validated, fully tagged delivery/master encoding profile. */
export function resolveVideoEncodingProfile(options: {
  videoCodec: VideoCodec;
  qualityPreset?: QualityPreset;
  colorSpace?: ExportColorSpace;
  bitDepth?: ExportBitDepth;
  hdrMetadata?: HdrMasteringMetadata;
}): VideoEncodingProfile {
  const videoCodec = options.videoCodec;
  const colorSpace = options.colorSpace || "rec709";
  const master = videoCodec.startsWith("prores-") || videoCodec.startsWith("dnxhr-");
  const bitDepth: ExportBitDepth = videoCodec === "h264" ? 8 : 10;
  if (colorSpace !== "rec709" && videoCodec === "h264") {
    throw new Error("H.264 cannot encode Tempo HDR delivery profiles");
  }

  const pixelFormat = videoCodec === "prores-4444"
    ? "yuv444p10le"
    : videoCodec === "dnxhr-444"
      ? "yuv444p10le"
      : master
        ? "yuv422p10le"
        : bitDepth === 10 ? "yuv420p10le" : "yuv420p";

  const colorArgs = colorSpace === "rec709"
    ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]
    : [
        "-color_primaries", "bt2020",
        "-color_trc", colorSpace === "rec2100-pq" ? "smpte2084" : "arib-std-b67",
        "-colorspace", "bt2020nc",
        "-color_range", "tv",
      ];

  let codecArgs: string[];
  if (videoCodec === "h264") {
    codecArgs = ["-c:v", "libx264", ...videoQualityArgs("libx264", options.qualityPreset, 8)];
  } else if (videoCodec === "h265") {
    const metadata = { ...DEFAULT_HDR_METADATA, ...(options.hdrMetadata || {}) };
    const x265Params = ["repeat-headers=1"];
    if (colorSpace === "rec709") {
      x265Params.push("colorprim=1", "transfer=1", "colormatrix=1");
    } else {
      x265Params.push(
        "colorprim=9",
        colorSpace === "rec2100-pq" ? "transfer=16" : "transfer=18",
        "colormatrix=9"
      );
      if (colorSpace === "rec2100-pq") {
        x265Params.push(
          "hdr-opt=1",
          `master-display=${x265MasterDisplay(metadata)}`,
          `max-cll=${Math.round(metadata.maxCll)},${Math.round(metadata.maxFall)}`
        );
      }
    }
    codecArgs = [
      "-c:v", "libx265",
      ...videoQualityArgs("libx265", options.qualityPreset, 10),
      "-x265-params", x265Params.join(":"),
      "-tag:v", "hvc1",
    ];
  } else if (videoCodec === "prores-422-hq" || videoCodec === "prores-4444") {
    codecArgs = [
      "-c:v", "prores_ks",
      "-profile:v", videoCodec === "prores-4444" ? "4" : "3",
      "-vendor", "apl0",
    ];
  } else if (videoCodec === "dnxhr-hqx" || videoCodec === "dnxhr-444") {
    codecArgs = [
      "-c:v", "dnxhd",
      "-profile:v", videoCodec === "dnxhr-444" ? "dnxhr_444" : "dnxhr_hqx",
    ];
  } else {
    throw new Error(`Export codec ${videoCodec} is not enabled by the render worker`);
  }

  return {
    args: [...codecArgs, "-pix_fmt", pixelFormat, ...colorArgs],
    pixelFormat,
    extension: master ? "mov" : "mp4",
    audioCodec: master ? "pcm-s24le" : "aac",
    colorSpace,
    bitDepth,
  };
}

function audioEncodingArgs(codec: AudioCodec = "aac", bitrate = "192k"): string[] {
  if (codec === "pcm-s24le") return ["-c:a", "pcm_s24le", "-ar", "48000"];
  if (codec === "opus") return ["-c:a", "libopus", "-b:a", bitrate];
  if (codec === "mp3") return ["-c:a", "libmp3lame", "-b:a", bitrate];
  return ["-c:a", "aac", "-b:a", bitrate];
}

export interface AssSubtitleClip {
  startTime: number;
  duration: number;
  layer?: number;
  opacity?: number;
  transform?: {
    x?: number;
    y?: number;
    scaleX?: number;
    scaleY?: number;
    rotation?: number;
  };
  textParams?: {
    text?: string;
    fontId?: string;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: string;
    color?: string;
    textAlign?: "left" | "center" | "right";
    stroke?: string;
    strokeWidth?: number;
    shadow?: string;
    backgroundColor?: string;
    letterSpacing?: number;
    karaokeWords?: Array<{ text: string; start: number; end: number }>;
    karaokeActiveColor?: string;
    karaokeInactiveColor?: string;
  };
}

export interface RenderFilterGraphOptions {
  inputFiles: RenderInputFile[];
  width: number;
  height: number;
  fps: number;
  duration?: number;
  backgroundColor?: string;
  masterVolume?: number;
  subtitlePath?: string;
  /** Directory of font files for libass (`fontsdir=`). */
  fontsDir?: string;
  /** Parallel to inputFiles. renderVideo fills this from ffprobe. */
  inputHasAudio?: readonly boolean[];
  /** Parallel to inputFiles; HDR inputs are tone-mapped before SDR composition. */
  inputIsHdr?: readonly boolean[];
  inputColorTransfer?: readonly (string | undefined)[];
  outputColorSpace?: ExportColorSpace;
  outputBitDepth?: ExportBitDepth;
  sidechainDuck?: { level: number; attackSec: number; releaseSec: number };
  masteringFilters?: string[];
}

export interface RenderFilterGraph {
  filterComplex: string;
  duration: number;
  videoOutputLabel: "outv";
  audioOutputLabel: "outa";
}

function isImageInput(file: RenderInputFile): boolean {
  if (file.mediaType === "image") return true;
  if (file.mediaType === "video" || file.mediaType === "audio") return false;
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file.path);
}

function isAudioOnlyInput(file: RenderInputFile): boolean {
  if (file.mediaType === "audio") return true;
  if (file.mediaType === "video" || file.mediaType === "image") return false;
  return /\.(mp3|wav|aac|m4a|flac|ogg|opus)$/i.test(file.path);
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function ffNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}

function atempoChain(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 0.000001 || filters.length === 0) {
    filters.push(`atempo=${ffNumber(remaining)}`);
  }
  return filters;
}

/**
 * Map clip effects to FFmpeg filter fragments (best-effort).
 * Order mirrors preview: color → blur → lut → vignette.
 * Glow/grain use the Chromium frame path when present (`needsFrameExport`).
 */
export function buildEffectFilterChain(file: RenderInputFile): string[] {
  const effects = (file.effects || []).filter((e) => e.enabled !== false);
  const parts: string[] = [];

  let brightness = 0;
  let contrast = 1;
  let saturation = 1;
  let hueDeg = 0;
  let blur = 0;
  let grayscale = 0;
  let sepia = 0;
  let invert = 0;
  let vignetteAmount = 0;
  let vignetteSoftness = 0.5;
  let grainAmount = 0;
  let grainSize = 1;
  let glowIntensity = 0;
  let lutIntensity = 0;

  for (const fx of effects) {
    const p = fx.params || {};
    switch (fx.type) {
      case "brightness":
        brightness = Number(p.value ?? 1) - 1;
        break;
      case "contrast":
        contrast = Number(p.value ?? 1);
        break;
      case "saturate":
        saturation = Number(p.value ?? 1);
        break;
      case "hue-rotate":
        hueDeg = Number(p.value ?? 0);
        break;
      case "blur":
        blur = Number(p.value ?? 0);
        break;
      case "grayscale":
        grayscale = Number(p.value ?? 0) / 100;
        break;
      case "sepia":
        sepia = Number(p.value ?? 0) / 100;
        break;
      case "invert":
        invert = Number(p.value ?? 0) / 100;
        break;
      case "vignette":
        vignetteAmount = Number(p.amount ?? 0);
        vignetteSoftness = Number(p.softness ?? 0.5);
        break;
      case "grain":
        grainAmount = Number(p.amount ?? 0);
        grainSize = Number(p.size ?? 1);
        break;
      case "glow":
        glowIntensity = Number(p.intensity ?? 0);
        break;
      case "lut":
        lutIntensity = Number(p.intensity ?? 1);
        break;
    }
  }

  if (
    Math.abs(brightness) > 0.001 ||
    Math.abs(contrast - 1) > 0.001 ||
    Math.abs(saturation - 1) > 0.001
  ) {
    parts.push(
      `eq=brightness=${ffNumber(brightness)}:contrast=${ffNumber(contrast)}:saturation=${ffNumber(saturation)}`
    );
  }
  if (Math.abs(hueDeg) > 0.001) {
    parts.push(`hue=h=${ffNumber(hueDeg)}`);
  }
  if (grayscale > 0.001) {
    parts.push(`hue=s=${ffNumber(Math.max(0, 1 - grayscale))}`);
  }
  if (sepia > 0.001) {
    parts.push(
      `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131`
    );
  }
  if (invert > 0.5) {
    parts.push("negate");
  }
  if (blur > 0.01) {
    parts.push(`gblur=sigma=${ffNumber(Math.min(blur, 24) * 0.5)}`);
  }
  // Soft glow: skipped on export (preview-only until headless WebGPU frames).
  if (glowIntensity > 0.01) {
    // no-op — exportBackend: approx
  }
  // Intensity baked into cube file by render worker via blendCubeLut.
  if (file.lutCubePath && lutIntensity > 0.001) {
    parts.push(`lut3d=file=${escapeFfmpegFilterValue(file.lutCubePath)}`);
  }
  if (vignetteAmount > 0.001) {
    // Softness widens the falloff (lower angle = softer edge transition).
    const soft = Math.min(1, Math.max(0, vignetteSoftness));
    const angle =
      (Math.PI / 5 + vignetteAmount * (Math.PI / 4)) * (0.55 + soft * 0.45);
    parts.push(`vignette=angle=${ffNumber(angle)}:mode=forward`);
  }
  if (grainAmount > 0.001) {
    // Weak noise approx — size nudges strength (not true film grain).
    const sizeFactor = Math.min(3, Math.max(0.5, grainSize));
    const alls = Math.max(1, Math.round(grainAmount * 20 * (0.7 + sizeFactor * 0.3)));
    parts.push(`noise=alls=${alls}:allf=t`);
  }

  return parts;
}

function parseCssColor(value: unknown): { r: number; g: number; b: number; a: number } {
  const text = String(value || "").trim();
  const shortHex = text.match(/^#([0-9a-f]{3,4})$/i)?.[1];
  if (shortHex) {
    return {
      r: parseInt(shortHex[0]! + shortHex[0]!, 16),
      g: parseInt(shortHex[1]! + shortHex[1]!, 16),
      b: parseInt(shortHex[2]! + shortHex[2]!, 16),
      a: shortHex[3] ? parseInt(shortHex[3] + shortHex[3], 16) / 255 : 1,
    };
  }
  const hex = text.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) {
    return {
      r: parseInt(hex[1]!.slice(0, 2), 16),
      g: parseInt(hex[1]!.slice(2, 4), 16),
      b: parseInt(hex[1]!.slice(4, 6), 16),
      a: hex[2] ? parseInt(hex[2], 16) / 255 : 1,
    };
  }
  const rgba = text.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d+(?:\.\d+)?)\s*)?\)$/i
  );
  if (rgba) {
    return {
      r: Math.max(0, Math.min(255, Number(rgba[1]))),
      g: Math.max(0, Math.min(255, Number(rgba[2]))),
      b: Math.max(0, Math.min(255, Number(rgba[3]))),
      a: Math.max(0, Math.min(1, rgba[4] === undefined ? 1 : Number(rgba[4]))),
    };
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

function hexByte(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function assColor(value: unknown, opacity = 1): string {
  const color = parseCssColor(value);
  const alpha = 255 - color.a * Math.max(0, Math.min(1, opacity)) * 255;
  return `&H${hexByte(alpha)}${hexByte(color.b)}${hexByte(color.g)}${hexByte(color.r)}`;
}

function ffmpegCanvasColor(value: unknown): string {
  const color = parseCssColor(value || "#000000");
  return `0x${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

/** Escape dialogue text so it cannot inject ASS override blocks. */
export function escapeAssText(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r\n|\r|\n/g, "\\N");
}

function assFontFamily(value: unknown): string {
  const family = String(value || "Arial").split(",")[0]!.replace(/["'\\{}\r\n]/g, "").trim();
  return family || "Arial";
}

function isBoldFontWeight(value: unknown): boolean {
  const weight = String(value || "").toLowerCase();
  return weight === "bold" || weight === "bolder" || finiteNumber(weight, 400) >= 600;
}

function karaokeText(clip: AssSubtitleClip): string | null {
  const clipDurationCs = Math.max(1, Math.round(positiveNumber(clip.duration, 0.01) * 100));
  const words = (clip.textParams?.karaokeWords || [])
    .filter((word) => word && String(word.text || "").trim())
    .map((word) => ({
      text: String(word.text).trim(),
      start: Math.max(0, finiteNumber(word.start, 0)),
      end: Math.max(0, finiteNumber(word.end, 0)),
    }))
    .sort((a, b) => a.start - b.start);
  if (words.length === 0) return null;

  let cursorCs = 0;
  let output = "";
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const startCs = Math.max(cursorCs, Math.min(clipDurationCs, Math.round(word.start * 100)));
    const endCs = Math.max(startCs + 1, Math.min(clipDurationCs, Math.round(word.end * 100)));
    if (startCs > cursorCs) {
      output += `{\\k${startCs - cursorCs}}\\h`;
    }
    const needsSpace = index > 0 && !/^[,.;:!?%)}\]]/.test(word.text);
    output += `{\\k${Math.max(1, endCs - startCs)}}${needsSpace ? " " : ""}${escapeAssText(word.text)}`;
    cursorCs = endCs;
  }
  return output;
}

/** Build a complete ASS document for timeline text clips. */
export function generateAssSubtitles(
  clips: readonly AssSubtitleClip[],
  width: number,
  height: number,
  /** Optional fontId → CSS family name for uploaded fonts */
  fontFamilyById?: ReadonlyMap<string, string>
): string {
  const playResX = Math.max(1, Math.round(positiveNumber(width, 1920)));
  const playResY = Math.max(1, Math.round(positiveNumber(height, 1080)));
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,5,20,20,20,1",
    "Style: Text,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,5,20,20,20,1",
    "Style: Karaoke,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,5,20,20,20,1",
  ];

  const styleLines: string[] = [];
  const eventLines: string[] = [];
  clips.forEach((clip, index) => {
    const params = clip.textParams;
    const text = params?.text ?? "";
    const karaoke = karaokeText(clip);
    if (!text && !karaoke) return;

    const opacity = Math.max(0, Math.min(1, finiteNumber(clip.opacity, 1)));
    const activeColor = karaoke ? params?.karaokeActiveColor || params?.color : params?.color;
    const inactiveColor = karaoke
      ? params?.karaokeInactiveColor || params?.color
      : params?.color;
    const outlineColor = params?.backgroundColor || params?.stroke || "#000000";
    const shadowColor = params?.shadow?.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i)?.[1] || "rgba(0,0,0,0.5)";
    const hasBackground = Boolean(params?.backgroundColor);
    const styleName = `Clip${index}`;
    const fontSize = positiveNumber(params?.fontSize, 48);
    const scaleX = Math.max(1, positiveNumber(clip.transform?.scaleX, 1) * 100);
    const scaleY = Math.max(1, positiveNumber(clip.transform?.scaleY, 1) * 100);
    const outline = hasBackground
      ? Math.max(4, positiveNumber(params?.strokeWidth, 2) + 4)
      : Math.max(0, finiteNumber(params?.strokeWidth, 2));
    const shadow = params?.shadow ? 2 : 0;
    const alignment = params?.textAlign === "left" ? 4 : params?.textAlign === "right" ? 6 : 5;

    const resolvedFamily =
      (params?.fontId && fontFamilyById?.get(params.fontId)) ||
      params?.fontFamily;

    styleLines.push(
      [
        `Style: ${styleName}`,
        assFontFamily(resolvedFamily),
        ffNumber(fontSize),
        assColor(activeColor || "#ffffff", opacity),
        assColor(inactiveColor || activeColor || "#ffffff", opacity),
        assColor(outlineColor, opacity),
        assColor(shadowColor, opacity),
        isBoldFontWeight(params?.fontWeight) ? "-1" : "0",
        "0",
        "0",
        "0",
        ffNumber(scaleX),
        ffNumber(scaleY),
        ffNumber(finiteNumber(params?.letterSpacing, 0)),
        "0",
        hasBackground ? "3" : "1",
        ffNumber(outline),
        ffNumber(shadow),
        String(alignment),
        "20",
        "20",
        "20",
        "1",
      ].join(",")
    );

    const baseX = params?.textAlign === "left" ? 20 : params?.textAlign === "right" ? playResX - 20 : playResX / 2;
    const x = baseX + finiteNumber(clip.transform?.x, 0);
    const y = playResY / 2 + finiteNumber(clip.transform?.y, 0);
    const rotation = finiteNumber(clip.transform?.rotation, 0);
    const overrides = `{\\pos(${ffNumber(x)},${ffNumber(y)})\\frz${ffNumber(rotation)}}`;
    const start = Math.max(0, finiteNumber(clip.startTime, 0));
    const end = start + positiveNumber(clip.duration, 0.01);
    const layer = Math.max(0, Math.round(finiteNumber(clip.layer, index)));
    eventLines.push(
      `Dialogue: ${layer},${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${overrides}${karaoke || escapeAssText(text)}`
    );
  });

  return [
    ...header,
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...eventLines,
    "",
  ].join("\n");
}

/** Quote a value embedded in an FFmpeg filter option (not a shell argument). */
export function escapeFfmpegFilterValue(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\\\''");
  return `'${escaped}'`;
}

/**
 * Build a timeline-aware graph. Visual clips are layered over a base canvas,
 * while source audio is independently time-shifted and mixed.
 */
function holdAudioTiming(file: RenderInputFile): {
  sourceOffset: number;
  sourceEnd: number;
  audioDuration: number;
  delayMs: number;
} | null {
  const sourceOffset = Math.max(0, finiteNumber(file.startTime, 0));
  const timelineStart = Math.max(0, finiteNumber(file.timelineStart, 0));
  const clipDuration = positiveNumber(file.duration, 0.1);
  const speed = positiveNumber(file.speed, 1);
  const hold = file.hold;
  if (!hold || !(hold.durationSec > 0) || (hold.at !== "in" && hold.at !== "out")) {
    return {
      sourceOffset,
      sourceEnd: sourceOffset + clipDuration * speed,
      audioDuration: clipDuration,
      delayMs: timelineStart * 1000,
    };
  }
  const holdDur = Math.min(hold.durationSec, clipDuration);
  const motionDur = Math.max(0, clipDuration - holdDur);
  if (motionDur <= 0) return null;
  if (hold.at === "in") {
    return {
      sourceOffset,
      sourceEnd: sourceOffset + motionDur * speed,
      audioDuration: motionDur,
      delayMs: (timelineStart + holdDur) * 1000,
    };
  }
  return {
    sourceOffset,
    sourceEnd: sourceOffset + motionDur * speed,
    audioDuration: motionDur,
    delayMs: timelineStart * 1000,
  };
}

function buildClipAudioFilters(file: RenderInputFile, audioDuration?: number): string {
  const clipDuration = positiveNumber(audioDuration ?? file.duration, 0.1);
  const volume = Math.max(0, finiteNumber(file.volume, 1));
  const parts: string[] = [];
  if (file.volumeExpr) {
    parts.push(`volume='${file.volumeExpr}':eval=frame`);
  } else {
    parts.push(`volume=${ffNumber(volume)}`);
  }
  let fadeIn = Math.max(0, finiteNumber(file.fadeInSec, 0));
  let fadeOut = Math.max(0, finiteNumber(file.fadeOutSec, 0));
  if (fadeIn + fadeOut > clipDuration && clipDuration > 0) {
    const scale = clipDuration / (fadeIn + fadeOut);
    fadeIn *= scale;
    fadeOut *= scale;
  }
  const fadeCurve = file.audioFadeCurve === "equal-power" ? ":curve=qsin" : "";
  if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${ffNumber(fadeIn)}${fadeCurve}`);
  if (fadeOut > 0) {
    parts.push(
      `afade=t=out:st=${ffNumber(Math.max(0, clipDuration - fadeOut))}:d=${ffNumber(fadeOut)}${fadeCurve}`
    );
  }
  if (file.audioFilters?.length) {
    parts.push(...file.audioFilters.filter(Boolean));
  }
  if (file.panExpr) {
    // Equal-power stereo pan. aeval has the same clip-local `t` clock as the
    // preceding volume filter and retains a centred mono/stereo signal safely.
    parts.push(
      `aeval=exprs='val(0)*sqrt((1-(${file.panExpr}))/2)|val(1)*sqrt((1+(${file.panExpr}))/2)':c=stereo`
    );
  }
  return parts.join(",");
}

export function buildRenderFilterGraph(options: RenderFilterGraphOptions): RenderFilterGraph {
  const width = Math.max(1, Math.round(positiveNumber(options.width, 1920)));
  const height = Math.max(1, Math.round(positiveNumber(options.height, 1080)));
  const fps = positiveNumber(options.fps, 30);
  const inputDuration = options.inputFiles.reduce((maximum, file) => {
    const timelineStart = Math.max(0, finiteNumber(file.timelineStart, 0));
    const duration = positiveNumber(file.duration, 0.1);
    return Math.max(maximum, timelineStart + duration);
  }, 0);
  const duration = Math.max(0.1, finiteNumber(options.duration, 0), inputDuration);
  const outputColorSpace = options.outputColorSpace || "rec709";
  const highDepth = options.outputBitDepth === 10;
  const compositingFormat = highDepth ? "gbrap16le" : "rgba";
  const finalFormat = highDepth ? "yuv444p10le" : "yuv420p";
  const finalColorTransform = highDepth
    ? outputColorSpace === "rec709"
      ? `format=${compositingFormat},zscale=pin=bt709:tin=bt709:min=gbr:rin=full:p=bt709:t=bt709:m=bt709:r=tv,`
      : `format=${compositingFormat},zscale=pin=bt2020:tin=${outputColorSpace === "rec2100-pq" ? "smpte2084" : "arib-std-b67"}:min=gbr:rin=full:p=bt2020:t=${outputColorSpace === "rec2100-pq" ? "smpte2084" : "arib-std-b67"}:m=bt2020nc:r=tv,`
    : "";
  const filterParts: string[] = [
    `color=c=${ffmpegCanvasColor(options.backgroundColor || "#000000")}:s=${width}x${height}:r=${ffNumber(fps)}:d=${ffNumber(duration)},format=${compositingFormat}[basev]`,
    `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${ffNumber(duration)},asetpts=PTS-STARTPTS[basea]`,
  ];

  let composedVideo = "basev";
  const musicLabels: string[] = [];
  const voiceLabels: string[] = [];
  const otherLabels: string[] = [];

  options.inputFiles.forEach((file, index) => {
    const sourceOffset = Math.max(0, finiteNumber(file.startTime, 0));
    const timelineStart = Math.max(0, finiteNumber(file.timelineStart, 0));
    const clipDuration = positiveNumber(file.duration, 0.1);
    const speed = positiveNumber(file.speed, 1);
    const sourceEnd = sourceOffset + clipDuration * speed;

    if (!isAudioOnlyInput(file)) {
      const inputVideo = `vin${index}`;
      const inputIsHdr = options.inputIsHdr?.[index] === true;
      const sourceTransfer = options.inputColorTransfer?.[index] === "arib-std-b67"
        ? "arib-std-b67"
        : "smpte2084";
      let colorTransform = "";
      if (outputColorSpace === "rec709" && inputIsHdr) {
        colorTransform = ",zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv";
      } else if (outputColorSpace !== "rec709") {
        const targetTransfer = outputColorSpace === "rec2100-pq" ? "smpte2084" : "arib-std-b67";
        const inputPrimaries = inputIsHdr ? "bt2020" : "bt709";
        const inputMatrix = inputIsHdr ? "bt2020nc" : "bt709";
        const inputTransfer = inputIsHdr ? sourceTransfer : "bt709";
        const nominalPeak = inputIsHdr ? 1000 : 100;
        colorTransform = `,setparams=color_primaries=${inputPrimaries}:color_trc=${inputTransfer}:colorspace=${inputMatrix}:range=limited,zscale=t=linear:npl=${nominalPeak},format=gbrpf32le,zscale=pin=${inputPrimaries}:tin=linear:min=gbr:rin=full:p=bt2020:t=${targetTransfer}:m=gbr:r=full:npl=1000`;
      }
      let videoChain = `[${index}:v]trim=start=${ffNumber(sourceOffset)}:end=${ffNumber(sourceEnd)},setpts=(PTS-STARTPTS)/${ffNumber(speed)}+${ffNumber(timelineStart)}/TB${colorTransform},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${ffNumber(fps)},format=${compositingFormat}`;
      const fxParts = buildEffectFilterChain(file);
      if (fxParts.length > 0) {
        videoChain += `,${fxParts.join(",")}`;
      }
      if (file.videoFadeOut) {
        videoChain += `,fade=t=out:st=${ffNumber(file.videoFadeOut.start)}:d=${ffNumber(file.videoFadeOut.duration)}:alpha=1`;
      }
      if (file.videoFadeIn) {
        videoChain += `,fade=t=in:st=${ffNumber(file.videoFadeIn.start)}:d=${ffNumber(file.videoFadeIn.duration)}:alpha=1`;
      }
      videoChain += `[${inputVideo}]`;
      filterParts.push(videoChain);
      const nextVideo = `vcomp${index}`;
      filterParts.push(
        `[${composedVideo}][${inputVideo}]overlay=x=(W-w)/2:y=(H-h)/2:shortest=0:eof_action=pass:enable='between(t,${ffNumber(timelineStart)},${ffNumber(timelineStart + clipDuration)})',format=${compositingFormat}[${nextVideo}]`
      );
      composedVideo = nextVideo;
    }

    const defaultHasAudio = isAudioOnlyInput(file) || (!isImageInput(file) && file.mediaType === "video");
    if (!file.muteAudio && (options.inputHasAudio?.[index] ?? defaultHasAudio)) {
      const timing = holdAudioTiming(file);
      if (timing && timing.audioDuration > 0) {
        const audioLabel = `ain${index}`;
        filterParts.push(
          `[${index}:a]atrim=start=${ffNumber(timing.sourceOffset)}:end=${ffNumber(timing.sourceEnd)},asetpts=PTS-STARTPTS,${atempoChain(speed).join(",")},atrim=duration=${ffNumber(timing.audioDuration)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,${buildClipAudioFilters(file, timing.audioDuration)},adelay=${ffNumber(timing.delayMs)}:all=1[${audioLabel}]`
        );
        const role = file.audioRole || "other";
        if (role === "music") musicLabels.push(audioLabel);
        else if (role === "voice") voiceLabels.push(audioLabel);
        else otherLabels.push(audioLabel);
      }
    }
  });

  if (options.subtitlePath) {
    let sub = `subtitles=filename=${escapeFfmpegFilterValue(options.subtitlePath)}`;
    if (options.fontsDir) {
      sub += `:fontsdir=${escapeFfmpegFilterValue(options.fontsDir)}`;
    }
    filterParts.push(`[${composedVideo}]${sub},${finalColorTransform}format=${finalFormat}[outv]`);
  } else {
    filterParts.push(`[${composedVideo}]${finalColorTransform}format=${finalFormat}[outv]`);
  }

  const masterVolume = Math.max(0, finiteNumber(options.masterVolume, 1));
  const masterChain = `atrim=duration=${ffNumber(duration)},volume=${ffNumber(masterVolume)}${options.masteringFilters?.length ? `,${options.masteringFilters.filter(Boolean).join(",")}` : ""}`;
  const useSidechain =
    Boolean(options.sidechainDuck) &&
    musicLabels.length > 0 &&
    voiceLabels.length > 0;

  if (useSidechain && options.sidechainDuck) {
    const sc = ffmpegSidechainCompressOpts({
      enabled: true,
      mode: "sidechain",
      level: options.sidechainDuck.level,
      attackSec: options.sidechainDuck.attackSec,
      releaseSec: options.sidechainDuck.releaseSec,
    });
    const mixBus = (labels: string[], out: string) => {
      if (labels.length === 1) {
        filterParts.push(`[${labels[0]}]anull[${out}]`);
      } else {
        const inputs = labels.map((l) => `[${l}]`).join("");
        filterParts.push(
          `${inputs}amix=inputs=${labels.length}:duration=longest:dropout_transition=0[${out}]`
        );
      }
    };
    mixBus(voiceLabels, "voicebus");
    mixBus(musicLabels, "musicraw");
    // FFmpeg pads are single-consumer; split voice for sidechain + audible mix.
    filterParts.push(`[voicebus]asplit=2[voice_sc][voice_mix]`);
    filterParts.push(`[musicraw][voice_sc]sidechaincompress=${sc}[musicducked]`);
    const finalLabels = ["basea", "voice_mix", "musicducked", ...otherLabels];
    const audioInputs = finalLabels.map((label) => `[${label}]`).join("");
    filterParts.push(
      `${audioInputs}amix=inputs=${finalLabels.length}:duration=longest:dropout_transition=0,${masterChain}[outa]`
    );
  } else {
    const audioLabels = [...musicLabels, ...voiceLabels, ...otherLabels];
    const audioInputs = ["basea", ...audioLabels].map((label) => `[${label}]`).join("");
    filterParts.push(
      `${audioInputs}amix=inputs=${audioLabels.length + 1}:duration=longest:dropout_transition=0,${masterChain}[outa]`
    );
  }

  return {
    filterComplex: filterParts.join(";"),
    duration,
    videoOutputLabel: "outv",
    audioOutputLabel: "outa",
  };
}

/**
 * Audio-only mix for muxing with a PNG frame sequence (no video filter chain).
 */
export function buildAudioMixFilterGraph(options: {
  inputFiles: RenderInputFile[];
  duration: number;
  masterVolume?: number;
  inputHasAudio?: readonly boolean[];
  /** When set, duck music stems from voice via FFmpeg sidechaincompress. */
  sidechainDuck?: { level: number; attackSec: number; releaseSec: number };
  masteringFilters?: string[];
}): { filterComplex: string; duration: number; audioOutputLabel: "outa" } {
  const inputDuration = options.inputFiles.reduce((maximum, file) => {
    const timelineStart = Math.max(0, finiteNumber(file.timelineStart, 0));
    const duration = positiveNumber(file.duration, 0.1);
    return Math.max(maximum, timelineStart + duration);
  }, 0);
  const duration = Math.max(0.1, finiteNumber(options.duration, 0), inputDuration);
  const filterParts: string[] = [
    `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${ffNumber(duration)},asetpts=PTS-STARTPTS[basea]`,
  ];
  const musicLabels: string[] = [];
  const voiceLabels: string[] = [];
  const otherLabels: string[] = [];

  options.inputFiles.forEach((file, index) => {
    if (isImageInput(file)) return;
    const speed = positiveNumber(file.speed, 1);
    const defaultHasAudio =
      isAudioOnlyInput(file) || (!isImageInput(file) && file.mediaType === "video");
    if (file.muteAudio) return;
    if (!(options.inputHasAudio?.[index] ?? defaultHasAudio)) return;

    const timing = holdAudioTiming(file);
    if (!timing || timing.audioDuration <= 0) return;

    const audioLabel = `ain${index}`;
    filterParts.push(
      `[${index}:a]atrim=start=${ffNumber(timing.sourceOffset)}:end=${ffNumber(timing.sourceEnd)},asetpts=PTS-STARTPTS,${atempoChain(speed).join(",")},atrim=duration=${ffNumber(timing.audioDuration)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,${buildClipAudioFilters(file, timing.audioDuration)},adelay=${ffNumber(timing.delayMs)}:all=1[${audioLabel}]`
    );
    const role = file.audioRole || "other";
    if (role === "music") musicLabels.push(audioLabel);
    else if (role === "voice") voiceLabels.push(audioLabel);
    else otherLabels.push(audioLabel);
  });

  const masterVolume = Math.max(0, finiteNumber(options.masterVolume, 1));
  const masterChain = `atrim=duration=${ffNumber(duration)},volume=${ffNumber(masterVolume)}${options.masteringFilters?.length ? `,${options.masteringFilters.filter(Boolean).join(",")}` : ""}`;
  const useSidechain =
    Boolean(options.sidechainDuck) &&
    musicLabels.length > 0 &&
    voiceLabels.length > 0;

  if (useSidechain && options.sidechainDuck) {
    const sc = ffmpegSidechainCompressOpts({
      enabled: true,
      mode: "sidechain",
      level: options.sidechainDuck.level,
      attackSec: options.sidechainDuck.attackSec,
      releaseSec: options.sidechainDuck.releaseSec,
    });
    const mixBus = (labels: string[], out: string) => {
      if (labels.length === 1) {
        filterParts.push(`[${labels[0]}]anull[${out}]`);
      } else {
        const inputs = labels.map((l) => `[${l}]`).join("");
        filterParts.push(
          `${inputs}amix=inputs=${labels.length}:duration=longest:dropout_transition=0[${out}]`
        );
      }
    };
    mixBus(voiceLabels, "voicebus");
    mixBus(musicLabels, "musicraw");
    // FFmpeg pads are single-consumer; split voice for sidechain + audible mix.
    filterParts.push(`[voicebus]asplit=2[voice_sc][voice_mix]`);
    filterParts.push(`[musicraw][voice_sc]sidechaincompress=${sc}[musicducked]`);
    const finalLabels = ["basea", "voice_mix", "musicducked", ...otherLabels];
    const audioInputs = finalLabels.map((label) => `[${label}]`).join("");
    filterParts.push(
      `${audioInputs}amix=inputs=${finalLabels.length}:duration=longest:dropout_transition=0,${masterChain}[outa]`
    );
  } else {
    const audioLabels = [...musicLabels, ...voiceLabels, ...otherLabels];
    const audioInputs = ["basea", ...audioLabels].map((label) => `[${label}]`).join("");
    filterParts.push(
      `${audioInputs}amix=inputs=${audioLabels.length + 1}:duration=longest:dropout_transition=0,${masterChain}[outa]`
    );
  }

  return {
    filterComplex: filterParts.join(";"),
    duration,
    audioOutputLabel: "outa",
  };
}

export async function renderVideo(options: RenderOptions): Promise<boolean> {
  const {
    inputFiles,
    outputPath,
    width,
    height,
    fps,
    videoBitrate = "5000k",
    audioBitrate = "192k",
    codec = "libx264",
  } = options;
  const videoCodec: VideoCodec = options.videoCodec || (codec === "libx265" ? "h265" : "h264");
  const profile = resolveVideoEncodingProfile({
    videoCodec,
    qualityPreset: options.qualityPreset,
    colorSpace: options.colorSpace,
    bitDepth: options.bitDepth,
    hdrMetadata: options.hdrMetadata,
  });

  if (inputFiles.length === 0 && !positiveNumber(options.duration, 0)) return false;

  const args: string[] = ["-y", "-sws_flags", "lanczos+accurate_rnd+full_chroma_int"];
  for (const file of inputFiles) {
    if (isImageInput(file)) args.push("-loop", "1");
    args.push("-i", file.path);
  }

  const probeResults = await Promise.all(
    inputFiles.map(async (file) => {
      if (isImageInput(file)) return { hasAudio: false, isHdr: false, colorTransfer: undefined };
      if (isAudioOnlyInput(file)) return { hasAudio: true, isHdr: false, colorTransfer: undefined };
      const info = await probe(file.path);
      return {
        hasAudio: Boolean(info.hasAudio ?? info.audioCodec),
        isHdr: Boolean(info.isHdr),
        colorTransfer: info.colorTransfer,
      };
    })
  );
  const graph = buildRenderFilterGraph({
    inputFiles,
    width,
    height,
    fps,
    duration: options.duration,
    backgroundColor: options.backgroundColor,
    masterVolume: options.masterVolume,
    subtitlePath: options.subtitlePath,
    fontsDir: options.fontsDir,
    inputHasAudio: probeResults.map((result) => result.hasAudio),
    inputIsHdr: probeResults.map((result) => result.isHdr),
    inputColorTransfer: probeResults.map((result) => result.colorTransfer),
    outputColorSpace: profile.colorSpace,
    outputBitDepth: profile.bitDepth,
    sidechainDuck: options.sidechainDuck,
    masteringFilters: options.masteringFilters,
  });

  args.push(
    "-filter_complex",
    graph.filterComplex,
    "-map",
    `[${graph.videoOutputLabel}]`,
    "-map",
    `[${graph.audioOutputLabel}]`,
    ...profile.args,
    ...audioEncodingArgs(options.audioCodec || profile.audioCodec, audioBitrate),
    "-r",
    String(fps),
    "-t",
    ffNumber(graph.duration),
    "-movflags",
    "+faststart+write_colr",
    outputPath
  );

  try {
    await exec("ffmpeg", args, { maxBuffer: 100 * 1024 * 1024 });
    return true;
  } catch (err: any) {
    logger.error({ err: err.message }, "FFmpeg render failed");
    return false;
  }
}

/**
 * Mix timeline audio only (no video layers) for muxing with a PNG frame sequence.
 */
export async function renderTimelineAudio(options: {
  inputFiles: RenderInputFile[];
  outputPath: string;
  duration: number;
  masterVolume?: number;
  audioBitrate?: string;
  audioCodec?: AudioCodec;
  sidechainDuck?: { level: number; attackSec: number; releaseSec: number };
  masteringFilters?: string[];
}): Promise<boolean> {
  const inputFiles = options.inputFiles;
  if (inputFiles.length === 0) {
    // Silent audio bed
    try {
      await exec("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `anullsrc=channel_layout=stereo:sample_rate=44100`,
        "-t",
        ffNumber(Math.max(0.1, options.duration)),
        ...audioEncodingArgs(options.audioCodec, options.audioBitrate || "192k"),
        options.outputPath,
      ]);
      return true;
    } catch (err: any) {
      logger.error({ err: err.message }, "Silent audio render failed");
      return false;
    }
  }

  const args: string[] = ["-y"];
  for (const file of inputFiles) {
    if (isImageInput(file)) args.push("-loop", "1");
    args.push("-i", file.path);
  }

  const hasAudio = await Promise.all(
    inputFiles.map(async (file) => {
      if (isImageInput(file)) return false;
      if (isAudioOnlyInput(file)) return true;
      const info = await probe(file.path);
      return Boolean(info.hasAudio ?? info.audioCodec);
    })
  );

  const graph = buildAudioMixFilterGraph({
    inputFiles,
    duration: options.duration,
    masterVolume: options.masterVolume,
    inputHasAudio: hasAudio,
    sidechainDuck: options.sidechainDuck,
    masteringFilters: options.masteringFilters,
  });

  args.push(
    "-filter_complex",
    graph.filterComplex,
    "-map",
    `[${graph.audioOutputLabel}]`,
    ...audioEncodingArgs(options.audioCodec, options.audioBitrate || "192k"),
    "-t",
    ffNumber(graph.duration),
    options.outputPath
  );

  try {
    await exec("ffmpeg", args, { maxBuffer: 100 * 1024 * 1024 });
    return true;
  } catch (err: any) {
    logger.error({ err: err.message }, "Timeline audio render failed");
    return false;
  }
}

/** Encode a PNG frame sequence + audio AAC into the final MP4. */
export async function encodeFramesWithAudio(options: {
  framesDir: string;
  /** frame pattern relative to framesDir, default frame-%06d.png */
  framePattern?: string;
  audioPath: string;
  outputPath: string;
  fps: number;
  videoBitrate?: string;
  audioBitrate?: string;
  codec?: "libx264" | "libx265";
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  colorSpace?: ExportColorSpace;
  bitDepth?: ExportBitDepth;
  hdrMetadata?: HdrMasteringMetadata;
  qualityPreset?: QualityPreset;
  duration: number;
  outputWidth?: number;
  outputHeight?: number;
  /** Lossless 16-bit FFV1 cache produced by the float compositor. */
  intermediateVideoPath?: string;
}): Promise<boolean> {
  const pattern = options.framePattern || "frame-%06d.png";
  const frameGlob = `${options.framesDir.replace(/\\/g, "/")}/${pattern}`;
  const videoCodec: VideoCodec = options.videoCodec || (options.codec === "libx265" ? "h265" : "h264");
  const profile = resolveVideoEncodingProfile({
    videoCodec,
    qualityPreset: options.qualityPreset,
    colorSpace: options.colorSpace,
    bitDepth: options.bitDepth,
    hdrMetadata: options.hdrMetadata,
  });
  const videoFilters: string[] = [];
  if (options.outputWidth && options.outputHeight) {
    videoFilters.push(`scale=${Math.round(options.outputWidth)}:${Math.round(options.outputHeight)}:flags=lanczos+accurate_rnd+full_chroma_int`, "setsar=1");
  }
  if (profile.colorSpace !== "rec709") {
    const transfer = profile.colorSpace === "rec2100-pq" ? "smpte2084" : "arib-std-b67";
    // Canvas frames are display-referred sRGB/Rec.709. Expand them into a
    // scene-light float working stage before encoding the requested HDR EOTF.
    videoFilters.push(
      "format=gbrpf32le",
      "zscale=pin=bt709:tin=bt709:min=gbr:rin=full:p=bt2020:t=linear:m=gbr:r=full:npl=100",
      `zscale=pin=bt2020:tin=linear:min=gbr:rin=full:p=bt2020:t=${transfer}:m=bt2020nc:r=tv:npl=1000`
    );
  } else {
    // Browser/FFV1 RGB frames have no YUV matrix. Make the Rec.709 full-RGB
    // to limited-YUV conversion explicit instead of accepting swscale's guess.
    videoFilters.push(
      "format=gbrp16le",
      "zscale=pin=bt709:tin=bt709:min=gbr:rin=full:p=bt709:t=bt709:m=bt709:r=tv"
    );
  }
  const frameInputArgs = options.intermediateVideoPath
    ? ["-i", options.intermediateVideoPath]
    : ["-framerate", String(options.fps), "-i", frameGlob];
  const args = [
    "-y",
    "-sws_flags",
    "lanczos+accurate_rnd+full_chroma_int",
    ...frameInputArgs,
    "-i",
    options.audioPath,
    ...(videoFilters.length ? ["-vf", videoFilters.join(",")] : []),
    ...profile.args,
    ...audioEncodingArgs(options.audioCodec || profile.audioCodec, options.audioBitrate || "192k"),
    "-t",
    ffNumber(Math.max(0.1, options.duration)),
    "-movflags",
    "+faststart+write_colr",
    "-shortest",
    options.outputPath,
  ];

  try {
    await exec("ffmpeg", args, { maxBuffer: 100 * 1024 * 1024 });
    return true;
  } catch (err: any) {
    logger.error({ err: err.message }, "Frame sequence encode failed");
    return false;
  }
}
