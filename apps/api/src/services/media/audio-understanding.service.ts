import { createReadStream } from "fs";
import { mkdir, rm, stat } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { eq } from "drizzle-orm";
import OpenAI, { toFile } from "openai";
import { db, mediaAssets } from "@tempo/db";
import type {
  MediaAudioRhythm,
  MediaAudioTranscript,
  MediaAnalysisStatus,
  MediaMetadata,
  TranscriptKind,
  TranscriptSegment,
  TranscriptWord,
} from "@tempo/types";
import { env } from "../../config/env.js";
import { storageConfig } from "../../config/storage.js";
import { compressAudioForAsr } from "../../utils/ffmpeg.js";
import { analyzeAudio } from "../reference/audio-analysis.service.js";
import { logger } from "../../utils/logger.js";

/** OpenAI transcription hard limit is 25MB; stay under with headroom. */
const OPENAI_ASR_MAX_BYTES = 24 * 1024 * 1024;

const HALLUCINATION_LINE =
  /^(thank you\.?|thanks for watching\.?|thanks\.?|thank you for watching\.?|you\.?|subscribe\.?|please subscribe\.?|bye\.?|goodbye\.?|see you\.?)$/i;

function localPathFromUploadUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith("/uploads/")) return null;
  const key = url.replace(/^\/uploads\//, "");
  return path.join(storageConfig.local.uploadDir, key);
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== "string") return NaN;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, parseFloat(s));
  const parts = s.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return NaN;
}

/** Whisper often invents short boilerplate on silence / instrumentals. */
function isWhisperHallucination(
  fullText: string,
  segments: Array<{ text?: string }>
): boolean {
  const text = fullText.trim();
  if (!text) return true;
  if (HALLUCINATION_LINE.test(text)) return true;

  const lines = segments
    .map((s) => String(s.text || "").trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  if (lines.every((line) => HALLUCINATION_LINE.test(line))) return true;
  if (HALLUCINATION_LINE.test(lines.join(" "))) return true;
  return false;
}

async function mergeAudioMeta(
  assetId: string,
  patch: Partial<
    Pick<MediaMetadata, "audioRhythm" | "audioTranscript" | "audioAnalysisStatus">
  >
) {
  const fresh = await db.query.mediaAssets.findFirst({
    where: eq(mediaAssets.id, assetId),
  });
  if (!fresh) return;
  const existing = (fresh.metadata || {}) as Record<string, any>;
  const metadata: MediaMetadata = {
    ...(existing as MediaMetadata),
    fileSize: existing.fileSize ?? 0,
    mimeType: existing.mimeType ?? "application/octet-stream",
    ...patch,
  };
  await db.update(mediaAssets).set({ metadata }).where(eq(mediaAssets.id, assetId));
}

function confidenceFromLogprob(value: unknown): number | undefined {
  const logprob = Number(value);
  if (!Number.isFinite(logprob)) return undefined;
  return Math.max(0, Math.min(1, Math.exp(logprob)));
}

function normalizeSegmentList(
  rawSegments: Array<{
    start?: unknown;
    end?: unknown;
    text?: unknown;
    avg_logprob?: unknown;
  }>,
  opts: {
    language?: string;
    fullText?: string;
    model: string;
    kind?: TranscriptKind;
    sourceDuration?: number;
    rawWords?: Array<{ start?: unknown; end?: unknown; word?: unknown; text?: unknown }>;
  }
): MediaAudioTranscript {
  const words: TranscriptWord[] = (opts.rawWords || [])
    .map((w, index) => {
      const start = parseTimestamp(w.start);
      const end = parseTimestamp(w.end);
      const text = String(w.word ?? w.text ?? "").trim();
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
      }
      return { id: `word-${index}`, start, end, text };
    })
    .filter(Boolean) as TranscriptWord[];
  words.sort((a, b) => a.start - b.start || a.end - b.end);

  const parsed = rawSegments
    .map((s) => {
      const start = parseTimestamp(s.start);
      const end = parseTimestamp(s.end);
      const text = String(s.text || "").trim();
      if (!text || !Number.isFinite(start)) return null;
      return { start, end, text, confidence: confidenceFromLogprob(s.avg_logprob) };
    })
    .filter(Boolean) as Array<{
      start: number;
      end: number;
      text: string;
      confidence?: number;
    }>;

  parsed.sort((a, b) => a.start - b.start);

  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i]!;
    let end = cur.end;
    if (!Number.isFinite(end) || end <= cur.start) {
      const next = parsed[i + 1];
      if (next && next.start > cur.start) end = next.start;
      else continue;
    }
    const wordIds = words
      .filter((word) => word.start < end && word.end > cur.start)
      .map((word) => word.id);
    segments.push({
      id: `segment-${i}`,
      start: cur.start,
      end,
      text: cur.text,
      wordIds,
      confidence: cur.confidence,
    });
  }

  const fullText = (opts.fullText || segments.map((s) => s.text).join(" ")).trim();
  if (segments.length === 0 && words.length > 0) {
    segments.push({
      id: "segment-0",
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text: fullText || words.map((word) => word.text).join(" "),
      wordIds: words.map((word) => word.id),
    });
  }

  let kind: TranscriptKind = opts.kind || "unknown";
  if (!opts.kind) {
    if (segments.length === 0 && !fullText) kind = "music_instrumental";
    else if (segments.length > 0) kind = "speech";
  }

  return {
    schemaVersion: 2,
    revision: randomUUID(),
    pipeline: kind === "singing" || kind === "mixed" ? "lyrics" : "speech",
    language: opts.language,
    kind,
    summary:
      kind === "music_instrumental"
        ? "No intelligible speech/lyrics detected (likely instrumental)"
        : fullText.slice(0, 400) || "Audio transcript",
    words,
    segments,
    sourceDuration: opts.sourceDuration,
    model: opts.model,
    analyzedAt: new Date().toISOString(),
    warnings:
      segments.length > 0 && words.length === 0
        ? ["Word timestamps unavailable; cue timing is segment-level."]
        : undefined,
  };
}

/**
 * OpenAI Whisper / gpt-4o-*-transcribe → timed segments.
 * Streams the file after a size check (no full-buffer read).
 */
async function transcribeAudioFile(
  audioPath: string,
  mimeType: string,
  durationSec?: number
): Promise<MediaAudioTranscript> {
  const model = env.OPENAI_ASR_MODEL || "whisper-1";

  if (!env.OPENAI_API_KEY) {
    return {
      kind: "unknown",
      summary: "ASR skipped — no OPENAI_API_KEY",
      segments: [],
      model: "none",
      analyzedAt: new Date().toISOString(),
      error: "OPENAI_API_KEY not configured",
    };
  }

  let fileSize = 0;
  try {
    fileSize = (await stat(audioPath)).size;
  } catch (err: any) {
    return {
      kind: "unknown",
      summary: "ASR failed — could not read audio file",
      segments: [],
      model,
      analyzedAt: new Date().toISOString(),
      error: err?.message || "stat_failed",
    };
  }

  if (fileSize > OPENAI_ASR_MAX_BYTES) {
    return {
      kind: "unknown",
      summary: "Audio too large for OpenAI transcription (max ~25MB)",
      segments: [],
      model,
      analyzedAt: new Date().toISOString(),
      error: "audio_too_large",
    };
  }

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const filename = path.basename(audioPath) || "audio.mp3";
  const file = await toFile(createReadStream(audioPath), filename, { type: mimeType });
  const fallbackEnd =
    durationSec && durationSec > 0 ? durationSec : Number.NaN;

  if (model !== "whisper-1") {
    return {
      schemaVersion: 2,
      revision: randomUUID(),
      pipeline: "speech",
      kind: "unknown",
      summary: `ASR model ${model} does not provide the required timed transcript contract`,
      words: [],
      segments: [],
      sourceDuration: durationSec,
      model,
      analyzedAt: new Date().toISOString(),
      error: "timed_asr_model_unsupported",
    };
  }

  try {
    const result = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
    });

    const segments = Array.isArray((result as any).segments)
      ? (result as any).segments.map((s: any) => ({
          start: s.start,
          end: s.end,
          text: s.text,
          avg_logprob: s.avg_logprob,
        }))
      : [];
    const words = Array.isArray((result as any).words)
      ? (result as any).words
      : [];
    const text = String((result as any).text || "").trim();

    if (isWhisperHallucination(text, segments)) {
      const transcript = normalizeSegmentList([], {
        language: (result as any).language,
        fullText: "",
        model,
        kind: "music_instrumental",
        sourceDuration: durationSec,
        rawWords: [],
      });
      transcript.usage = transcriptionUsage(durationSec);
      return transcript;
    }

    if (segments.length > 0 || words.length > 0) {
      const transcript = normalizeSegmentList(segments, {
        language: (result as any).language,
        fullText: text,
        model,
        sourceDuration: durationSec,
        rawWords: words,
      });
      transcript.usage = transcriptionUsage(durationSec);
      return transcript;
    }

    const transcript = normalizeSegmentList([{ start: 0, end: fallbackEnd, text }], {
      language: (result as any).language,
      fullText: text,
      model,
      sourceDuration: durationSec,
    });
    transcript.usage = transcriptionUsage(durationSec);
    return transcript;
  } catch (err: any) {
    logger.error({ err: err?.message, model }, "OpenAI ASR failed");
    return {
      kind: "unknown",
      summary: "ASR failed",
      segments: [],
      model,
      analyzedAt: new Date().toISOString(),
      error: err?.message || "asr_failed",
    };
  }
}

function transcriptionUsage(durationSec?: number) {
  const seconds = Math.max(0, Number(durationSec) || 0);
  return {
    durationSeconds: seconds,
    // whisper-1 is billed per started/processed minute. This estimate keeps
    // the exact duration visible while using the published $0.006/min rate.
    estimatedCostUsd: Number(((seconds / 60) * 0.006).toFixed(6)),
  };
}

/**
 * Transcribe an arbitrary local audio/video path without requiring a media DB
 * row. Reference analysis uses this before the durable asset is committed.
 */
export async function transcribeLocalMedia(
  sourcePath: string,
  durationSec: number
): Promise<MediaAudioTranscript> {
  const workDir = path.join(
    storageConfig.local.uploadDir,
    "tmp",
    "reference-asr",
    randomUUID()
  );
  await mkdir(workDir, { recursive: true });
  try {
    const asrPath = path.join(workDir, "asr.mp3");
    const compressed = await compressAudioForAsr(sourcePath, asrPath);
    if (!compressed) {
      return {
        kind: "unknown",
        summary: "Could not prepare reference audio for transcription",
        segments: [],
        model: "none",
        analyzedAt: new Date().toISOString(),
        error: "compress_failed",
      };
    }
    return transcribeAudioFile(asrPath, "audio/mpeg", durationSec);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Run rhythm + ASR for an audio file or video soundtrack.
 * Rhythm uses the source file; ASR gets a compressed mono MP3 under OpenAI's size limit.
 */
export async function analyzeMediaAudio(
  assetId: string,
  opts: { sourcePath: string; isVideo: boolean; duration: number }
): Promise<{
  rhythm?: MediaAudioRhythm;
  transcript?: MediaAudioTranscript;
  status: MediaAnalysisStatus;
}> {
  await mergeAudioMeta(assetId, { audioAnalysisStatus: "pending" });

  const workDir = path.join(
    storageConfig.local.uploadDir,
    "tmp",
    "audio-analysis",
    assetId
  );
  await mkdir(workDir, { recursive: true });

  try {
    const duration = opts.duration > 0 ? opts.duration : 30;
    const asrModel = env.OPENAI_ASR_MODEL || "whisper-1";

    // Always compress for ASR (video PCM WAV blew past 25MB in ~2–3 min)
    const asrPath = path.join(workDir, "asr.mp3");
    const compressed = await compressAudioForAsr(opts.sourcePath, asrPath);
    if (!compressed) {
      const failed: MediaAudioTranscript = {
        kind: "unknown",
        summary: "Could not prepare audio for transcription",
        segments: [],
        model: "none",
        analyzedAt: new Date().toISOString(),
        error: "compress_failed",
      };
      await mergeAudioMeta(assetId, {
        audioAnalysisStatus: "error",
        audioTranscript: failed,
      });
      return { transcript: failed, status: "error" };
    }

    const [rhythmResult, transcript] = await Promise.all([
      // Onset analysis re-decodes via ffmpeg — pass original source (better fidelity)
      analyzeAudio(opts.sourcePath, duration)
        .then((a): MediaAudioRhythm => ({
          bpm: a.bpm,
          beats: a.beats.map((b) => ({
            time: b.time,
            strength: b.strength,
            isDownbeat: b.isDownbeat,
          })),
          energyCurve: a.energyCurve,
          mood: a.mood,
          genre: a.genre,
          analyzedAt: new Date().toISOString(),
          model: "tempo-onset-v1",
        }))
        .catch((err: any): MediaAudioRhythm => ({
          // Never manufacture a metronome when onset analysis failed. Consumers
          // treat bpm=0 + empty beats as an unavailable rhythm grid.
          bpm: 0,
          beats: [],
          energyCurve: [],
          analyzedAt: new Date().toISOString(),
          model: "tempo-onset-v1",
          error: err.message || "rhythm_failed",
        })),
      transcribeAudioFile(asrPath, "audio/mpeg", duration).catch(
        (err: any): MediaAudioTranscript => ({
          kind: "unknown",
          summary: "ASR failed",
          segments: [],
          model: asrModel,
          analyzedAt: new Date().toISOString(),
          error: err.message || "asr_failed",
        })
      ),
    ]);

    const asrHardFail = Boolean(transcript.error) && transcript.segments.length === 0;
    const bothFailed = Boolean(transcript.error) && Boolean(rhythmResult.error);
    const status: MediaAnalysisStatus =
      asrHardFail || bothFailed ? "error" : "ready";

    await mergeAudioMeta(assetId, {
      audioAnalysisStatus: status,
      audioRhythm: rhythmResult,
      audioTranscript: transcript,
    });

    logger.info(
      {
        assetId,
        bpm: rhythmResult.bpm,
        beats: rhythmResult.beats.length,
        segments: transcript.segments.length,
        kind: transcript.kind,
        asrModel: transcript.model,
      },
      "media audio analysis ready"
    );

    return { rhythm: rhythmResult, transcript, status };
  } catch (err: any) {
    logger.error({ err: err.message, assetId }, "analyzeMediaAudio failed");
    const failed: MediaAudioTranscript = {
      kind: "unknown",
      summary: "Audio analysis failed",
      segments: [],
      model: "none",
      analyzedAt: new Date().toISOString(),
      error: err.message,
    };
    await mergeAudioMeta(assetId, {
      audioAnalysisStatus: "error",
      audioTranscript: failed,
    });
    return { transcript: failed, status: "error" };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function resolveLocalMediaPath(url: string | null | undefined): string | null {
  return localPathFromUploadUrl(url);
}
