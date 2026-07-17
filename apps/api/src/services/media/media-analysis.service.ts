import { readFile, mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { eq } from "drizzle-orm";
import { GoogleGenAI } from "@google/genai";
import { db, mediaAssets } from "@tempo/db";
import type { ColorStatistics, MediaAnalysis, MediaAnalysisStatus, MediaMetadata, ShotIndex } from "@tempo/types";
import { env } from "../../config/env.js";
import { storageConfig } from "../../config/storage.js";
import { extractAnalysisFrame } from "../../utils/ffmpeg.js";
import { logger } from "../../utils/logger.js";
import {
  analyzeMediaAudio,
  resolveLocalMediaPath,
} from "./audio-understanding.service.js";
import {
  buildImageShotIndex,
  buildVideoShotIndex,
} from "./shot-index.service.js";
import { mediaDisplayGeometry } from "@tempo/editor-core";
import { analyzeColorStatistics } from "./color-analysis.service.js";

const FRAME_FRACTIONS = [0.1, 0.35, 0.6, 0.85];

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function analysisPrompt(kind: "image" | "video" | "audio", name: string, duration?: number | null) {
  if (kind === "audio") {
    return `You classify audio for a video editor media library.
File name: "${name}"${duration ? `, duration: ${duration.toFixed(1)}s` : ""}.
Return ONLY valid JSON (no markdown) with this shape:
{
  "summary": "1-2 sentence description of likely content from the name",
  "tags": ["tag1","tag2"],
  "subjects": [],
  "mood": "optional mood",
  "bestFor": ["e.g. background music","sfx"],
  "moments": []
}`;
  }

  return `You are a media librarian for a professional video editor.
Classify this ${kind} for editing decisions. File name: "${name}"${
    duration ? `, duration ~${duration.toFixed(1)}s` : ""
  }.
${kind === "video" ? "You are given several frames sampled across the clip (in order)." : "You are given the image."}

Return ONLY valid JSON (no markdown fences) with this exact shape:
{
  "summary": "1-2 sentence description of what is shown",
  "tags": ["3-8 short tags"],
  "subjects": ["main subjects/people/objects"],
  "shotType": "close-up|medium|wide|extreme-close-up|bird-eye|other",
  "cameraMotion": "static|pan|zoom-in|zoom-out|tracking|handheld|other",
  "mood": "short mood word/phrase",
  "setting": "indoor|outdoor|studio|nature|urban|other short phrase",
  "colorPalette": ["#hex or color names, 3-5"],
  "textInFrame": ["any readable text, else []"],
  "bestFor": ["how an editor might use this, e.g. hero open, B-roll, title card"],
  "moments": [{"t": 0.0, "label": "what happens"}]
}
For images, moments should be []. For video, include 0-4 moments with approximate times in seconds.`;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fence ? fence[1]!.trim() : trimmed;
}

function normalizeAnalysis(raw: any, model: string): MediaAnalysis {
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 12) : [];
  const subjects = Array.isArray(raw.subjects) ? raw.subjects.map(String).slice(0, 12) : [];
  const colorPalette = Array.isArray(raw.colorPalette)
    ? raw.colorPalette.map(String).slice(0, 8)
    : [];
  const textInFrame = Array.isArray(raw.textInFrame)
    ? raw.textInFrame.map(String).slice(0, 12)
    : [];
  const bestFor = Array.isArray(raw.bestFor) ? raw.bestFor.map(String).slice(0, 8) : [];
  const moments = Array.isArray(raw.moments)
    ? raw.moments
        .map((m: any) => ({
          t: Number(m.t) || 0,
          label: String(m.label || ""),
        }))
        .filter((m: { label: string }) => m.label)
        .slice(0, 8)
    : [];

  return {
    summary: String(raw.summary || "No description").slice(0, 500),
    tags,
    subjects,
    shotType: raw.shotType ? String(raw.shotType) : undefined,
    cameraMotion: raw.cameraMotion ? String(raw.cameraMotion) : undefined,
    mood: raw.mood ? String(raw.mood) : undefined,
    setting: raw.setting ? String(raw.setting) : undefined,
    colorPalette,
    textInFrame,
    bestFor,
    moments,
    model,
    analyzedAt: new Date().toISOString(),
  };
}

async function patchAnalysis(
  assetId: string,
  status: MediaAnalysisStatus,
  analysis?: MediaAnalysis,
  shotIndex?: ShotIndex,
  colorStatistics?: ColorStatistics
) {
  // Re-read so concurrent technical updates aren't clobbered; refuse to
  // overwrite a newer ready analysis with an older error from a stale run.
  const fresh = await db.query.mediaAssets.findFirst({
    where: eq(mediaAssets.id, assetId),
  });
  if (!fresh) return;

  const existingMeta = (fresh.metadata || {}) as Record<string, any>;
  const prev = existingMeta.analysis as MediaAnalysis | undefined;
  if (
    status === "error" &&
    existingMeta.analysisStatus === "ready" &&
    prev?.analyzedAt &&
    analysis?.analyzedAt &&
    prev.analyzedAt > analysis.analyzedAt
  ) {
    return;
  }
  if (
    status !== "ready" &&
    existingMeta.analysisStatus === "ready" &&
    status === "pending"
  ) {
    // Another run already finished — don't flip ready back to pending
    // unless this is a deliberate re-analyze that just started under lock.
  }

  const metadata: MediaMetadata = {
    ...(existingMeta as MediaMetadata),
    fileSize: existingMeta.fileSize ?? 0,
    mimeType: existingMeta.mimeType ?? "application/octet-stream",
    analysisStatus: status,
    analysis: analysis ?? existingMeta.analysis,
    shotIndex: shotIndex ?? existingMeta.shotIndex,
    colorStatistics: colorStatistics ?? existingMeta.colorStatistics,
    orientation: mediaDisplayGeometry(existingMeta).orientation,
  };

  await db
    .update(mediaAssets)
    .set({ metadata })
    .where(eq(mediaAssets.id, assetId));
}

async function buildImageParts(
  filePath: string
): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
  const data = await readFile(filePath);
  return [
    {
      inlineData: {
        mimeType: mimeFromPath(filePath),
        data: data.toString("base64"),
      },
    },
  ];
}

async function buildVideoFrameParts(
  videoPath: string,
  duration: number,
  workDir: string
): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
  const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  const times =
    duration > 0
      ? FRAME_FRACTIONS.map((f) =>
          Math.min(Math.max(duration * f, 0), Math.max(duration - 0.05, 0))
        )
      : [0];

  const uniqueTimes = [...new Set(times.map((t) => Math.round(t * 10) / 10))];

  for (let i = 0; i < uniqueTimes.length; i++) {
    const t = uniqueTimes[i]!;
    const out = path.join(workDir, `frame-${i}.jpg`);
    const ok = await extractAnalysisFrame(videoPath, out, t);
    if (!ok) continue;
    const data = await readFile(out);
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: data.toString("base64") },
    });
  }
  return parts;
}

const inFlight = new Map<string, Promise<MediaAnalysis | null>>();

/**
 * Classify a single media asset with Flash-Lite vision (or text stub for audio).
 * Updates media_assets.metadata.analysis* in place.
 * Concurrent callers for the same id await the same in-flight promise.
 */
export async function classifyMediaAsset(assetId: string): Promise<MediaAnalysis | null> {
  const existing = inFlight.get(assetId);
  if (existing) {
    logger.info({ assetId }, "classifyMediaAsset: already in flight, awaiting");
    return existing;
  }

  const run = (async (): Promise<MediaAnalysis | null> => {
    try {
      return await classifyMediaAssetInner(assetId);
    } finally {
      inFlight.delete(assetId);
    }
  })();

  inFlight.set(assetId, run);
  return run;
}

async function classifyMediaAssetInner(assetId: string): Promise<MediaAnalysis | null> {
  const asset = await db.query.mediaAssets.findFirst({
    where: eq(mediaAssets.id, assetId),
  });
  if (!asset) {
    logger.warn({ assetId }, "classifyMediaAsset: asset not found");
    return null;
  }

  const existingMeta = (asset.metadata || {}) as Record<string, any>;
  const model = env.GEMINI_METADATA_MODEL || "gemini-3.1-flash-lite";

  await patchAnalysis(assetId, "pending");

  if (!env.GEMINI_API_KEY) {
    const skipped: MediaAnalysis = {
      summary: `${asset.type} "${asset.name}" (analysis skipped — no GEMINI_API_KEY)`,
      tags: [asset.type],
      subjects: [],
      model: "none",
      analyzedAt: new Date().toISOString(),
      error: "GEMINI_API_KEY not configured",
    };
    await patchAnalysis(assetId, "skipped", skipped);
    return skipped;
  }

  const workDir = path.join(
    storageConfig.local.uploadDir,
    "tmp",
    "analysis",
    assetId
  );

  // Keep a handle so the catch path can wait for audio before patching vision error
  let audioWait: Promise<unknown> = Promise.resolve(null);

  try {
    await mkdir(workDir, { recursive: true });

    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const duration = asset.duration ?? existingMeta.duration ?? null;
    const sourcePath = resolveLocalMediaPath(asset.url);

    // Same upload pipeline, separate model calls:
    // - image: vision only
    // - audio: rhythm + ASR (no frames)
    // - video: vision frames || rhythm+ASR in parallel (shared extract inside audio job)
    const audioJob =
      (asset.type === "audio" || asset.type === "video") && sourcePath
        ? analyzeMediaAudio(assetId, {
            sourcePath,
            isVideo: asset.type === "video",
            duration: Number(duration) || 0,
          })
        : Promise.resolve(null);
    audioWait = audioJob;

    let analysis: MediaAnalysis;

    if (asset.type === "audio") {
      if (!sourcePath) {
        analysis = normalizeAnalysis(
          {
            summary: `Audio "${asset.name}" (file path unavailable for analysis)`,
            tags: ["audio"],
            subjects: [],
            bestFor: ["voiceover", "music"],
          },
          model
        );
        analysis.error = "source_path_missing";
      } else {
        const audioResult = await audioJob;
        const transcript = audioResult?.transcript;
        const rhythm = audioResult?.rhythm;
        analysis = normalizeAnalysis(
          {
            summary:
              transcript?.summary ||
              `Audio "${asset.name}"${rhythm ? ` · ${rhythm.bpm} BPM` : ""}`,
            tags: [
              asset.type,
              transcript?.kind,
              rhythm?.genre,
              rhythm?.mood,
            ].filter(Boolean),
            subjects: [],
            mood: rhythm?.mood || transcript?.kind,
            bestFor:
              transcript?.kind === "music_instrumental"
                ? ["background music", "bed"]
                : transcript?.kind === "singing"
                  ? ["lyrics captions", "karaoke"]
                  : ["voiceover", "captions"],
            moments: (transcript?.segments || []).slice(0, 4).map((s) => ({
              t: s.start,
              label: s.text.slice(0, 60),
            })),
          },
          model
        );
        if (transcript?.error && !transcript.segments.length) {
          analysis.error = transcript.error;
        }
      }
    } else if (storageConfig.provider !== "local") {
      throw new Error("Media analysis currently requires local storage");
    } else if (asset.type === "image") {
      const imgPath =
        resolveLocalMediaPath(asset.url) ||
        resolveLocalMediaPath(asset.thumbnailUrl);
      if (!imgPath) throw new Error("Image file path not found");
      const imageParts = await buildImageParts(imgPath);
      const prompt = analysisPrompt("image", asset.name, duration);
      const result = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
        config: { temperature: 0.2, responseMimeType: "application/json" },
      });
      const text = result.text || "";
      let parsed: any;
      try {
        parsed = JSON.parse(stripJsonFence(text));
      } catch {
        await writeFile(path.join(workDir, "raw-response.txt"), text, "utf8").catch(
          () => undefined
        );
        throw new Error("Model returned invalid JSON");
      }
      analysis = normalizeAnalysis(parsed, model);
    } else {
      // video: always await both so a vision failure cannot race-clobber audio metadata
      const visionPromise = (async () => {
        const videoPath = sourcePath;
        if (!videoPath) throw new Error("Video file path not found");
        let imageParts = await buildVideoFrameParts(
          videoPath,
          Number(duration) || 0,
          workDir
        );
        if (imageParts.length === 0) {
          const thumb = resolveLocalMediaPath(asset.thumbnailUrl);
          if (thumb) imageParts = await buildImageParts(thumb);
        }
        if (imageParts.length === 0) throw new Error("Could not extract video frames");
        const prompt = analysisPrompt("video", asset.name, duration);
        const result = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
          config: { temperature: 0.2, responseMimeType: "application/json" },
        });
        const text = result.text || "";
        try {
          return normalizeAnalysis(JSON.parse(stripJsonFence(text)), model);
        } catch {
          await writeFile(path.join(workDir, "raw-response.txt"), text, "utf8").catch(
            () => undefined
          );
          throw new Error("Model returned invalid JSON");
        }
      })();

      const [visionSettled] = await Promise.allSettled([visionPromise, audioJob]);
      if (visionSettled.status === "rejected") {
        throw visionSettled.reason instanceof Error
          ? visionSettled.reason
          : new Error(String(visionSettled.reason));
      }
      analysis = visionSettled.value;
    }

    let shotIndex: ShotIndex | undefined;
    try {
      if (asset.type === "image") {
        shotIndex = await buildImageShotIndex(
          assetId,
          analysis,
          model,
          Number(duration) || 5
        );
      } else if (asset.type === "video" && sourcePath) {
        shotIndex = await buildVideoShotIndex({
          assetId,
          assetName: asset.name,
          videoPath: sourcePath,
          duration: Number(duration) || 0,
          workDir,
          model,
        });
      }
    } catch (err: any) {
      logger.warn(
        { err: err?.message, assetId },
        "Shot index build failed; continuing with clip analysis"
      );
    }

    let colorStatistics: ColorStatistics | undefined;
    if (sourcePath && asset.type !== "audio") {
      try {
        colorStatistics = await analyzeColorStatistics(sourcePath, Number(duration) || 0) || undefined;
      } catch (err: any) {
        logger.warn({ err: err?.message, assetId }, "Decoded color analysis failed; keeping palette fallback");
      }
    }

    await patchAnalysis(assetId, "ready", analysis, shotIndex, colorStatistics);
    logger.info(
      {
        assetId,
        model,
        tags: analysis.tags.length,
        shots: shotIndex?.shots.length ?? 0,
      },
      "media analysis ready"
    );
    return analysis;
  } catch (err: any) {
    // Let audio merge finish first so patchAnalysis re-read keeps audioRhythm/transcript
    await audioWait.catch(() => undefined);
    logger.error({ err: err.message, assetId }, "media analysis failed");
    const failed: MediaAnalysis = {
      summary: `Analysis failed for "${asset.name}"`,
      tags: [],
      subjects: [],
      model,
      analyzedAt: new Date().toISOString(),
      error: err.message || "analysis failed",
    };
    await patchAnalysis(assetId, "error", failed);
    return failed;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Fire-and-forget wrapper for upload hooks. */
export function enqueueMediaAnalysis(assetId: string): void {
  void classifyMediaAsset(assetId).catch((err) => {
    logger.error({ err: err?.message, assetId }, "enqueueMediaAnalysis failed");
  });
}

/** Classify many assets with limited concurrency. */
export async function classifyProjectMedia(
  projectId: string,
  opts: { onlyMissing?: boolean; concurrency?: number } = {}
): Promise<{ queued: number; ids: string[] }> {
  const onlyMissing = opts.onlyMissing !== false;
  const concurrency = opts.concurrency ?? 2;

  const assets = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, projectId),
  });

  const targets = assets.filter((a) => {
    if (!onlyMissing) return true;
    const meta = (a.metadata || {}) as Record<string, any>;
    const status = meta.analysisStatus as string | undefined;
    const audioStatus = meta.audioAnalysisStatus as string | undefined;
    const needsAudioBackfill =
      (a.type === "audio" || a.type === "video") &&
      audioStatus !== "ready" &&
      audioStatus !== "pending";
    if (needsAudioBackfill) return true;
    const needsShotIndex =
      (a.type === "video" || a.type === "image") &&
      status === "ready" &&
      !(meta.shotIndex?.shots?.length > 0);
    if (needsShotIndex) return true;
    // Skip ready and already-in-flight pending; re-run none/error/skipped
    if (status === "ready" || status === "pending") return false;
    return true;
  });

  const ids = targets.map((a) => a.id);
  let idx = 0;

  async function worker() {
    while (idx < ids.length) {
      const id = ids[idx++]!;
      await classifyMediaAsset(id);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ids.length || 1) }, () =>
    worker()
  );
  await Promise.all(workers);

  return { queued: ids.length, ids };
}

/** Compact one-line summary for agent prompts. */
export function formatMediaForPrompt(asset: {
  id: string;
  name: string;
  type: string;
  duration: number | null;
  metadata?: Record<string, any> | null;
  url?: string;
}): string {
  const meta = (asset.metadata || {}) as Record<string, any>;
  const dur = asset.duration ?? meta.duration;
  const analysis = meta.analysis as MediaAnalysis | undefined;
  const status = meta.analysisStatus as string | undefined;
  const geometry = mediaDisplayGeometry(meta);

  const bits = [
    `id: "${asset.id}"`,
    `name: "${asset.name}"`,
    `type: ${asset.type}`,
    `duration: ${dur != null ? `${dur}s` : "unknown"}`,
  ];
  if (asset.url) bits.push(`url: "${asset.url}"`);
  if (geometry.width && geometry.height) {
    bits.push(`dimensions: ${geometry.width}x${geometry.height}`);
  }
  bits.push(`orientation: ${geometry.orientation}`);

  if (status === "ready" && analysis) {
    bits.push(`summary: "${analysis.summary.replace(/"/g, "'")}"`);
    if (analysis.tags?.length) bits.push(`tags: [${analysis.tags.join(", ")}]`);
    if (analysis.shotType) bits.push(`shot: ${analysis.shotType}`);
    if (analysis.mood) bits.push(`mood: ${analysis.mood}`);
    if (analysis.bestFor?.length) bits.push(`bestFor: [${analysis.bestFor.join(", ")}]`);
    const shotCount = meta.shotIndex?.shots?.length;
    if (shotCount) bits.push(`shots: ${shotCount}`);
  } else if (status === "skipped" && analysis) {
    bits.push(`summary: "${analysis.summary.replace(/"/g, "'")}"`);
    bits.push("analysis: skipped");
  } else if (status === "pending") {
    bits.push("analysis: pending");
  } else if (status === "error") {
    bits.push("analysis: error");
  } else {
    bits.push("analysis: none");
  }

  const audioStatus = meta.audioAnalysisStatus as string | undefined;
  const rhythm = meta.audioRhythm;
  const transcript = meta.audioTranscript;
  if (asset.type === "audio" || asset.type === "video") {
    if (audioStatus === "ready" && rhythm) {
      bits.push(`bpm: ${rhythm.bpm}`);
      bits.push(`beats: ${rhythm.beats?.length ?? 0}`);
    }
    if (audioStatus === "ready" && transcript) {
      bits.push(`transcript: ${transcript.kind} (${transcript.segments?.length ?? 0} segs)`);
    } else if (audioStatus === "pending") {
      bits.push("audioAnalysis: pending");
    } else if (audioStatus === "error") {
      bits.push("audioAnalysis: error");
    }
  }

  return `  - ${bits.join(", ")}`;
}
