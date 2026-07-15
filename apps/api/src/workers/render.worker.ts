import { UnrecoverableError, Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import {
  db,
  projects,
  renderJobs,
  mediaAssets,
  lutAssets,
  fontAssets,
} from "@tempo/db";
import {
  getBuiltinLut,
  serializeCubeLut,
  blendCubeLut,
  parseCubeLut,
  needsFrameExport,
  getTransitionType,
  normalizeDuckSettings,
  voiceActivityWindows,
  musicDuckBreakpoints,
  ffmpegVolumeExprFromBreakpoints,
  ffmpegAudioAutomationExpr,
  multiplyAudioAutomationBreakpoints,
  resolveAudioAutomationBreakpoints,
  ffmpegEqFilters,
  normalizeTrackEq,
  normalizeTrackAudioPost,
  ffmpegAudioPostFilters,
  ffmpegMasteringFilters,
  getTrackRole,
  isNestClip,
  validateSequences,
} from "@tempo/editor-core";
import type { Track, Transition, AudioMixer, Sequence, MediaMetadata } from "@tempo/types";
import { getRedisConnection } from "../config/redis.js";
import { RENDER_QUEUE_NAME, type RenderJobData } from "../services/render.service.js";
import {
  generateAssSubtitles,
  renderVideo,
  renderTimelineAudio,
  encodeFramesWithAudio,
  type AssSubtitleClip,
  type RenderInputFile,
} from "../utils/ffmpeg.js";
import { storageConfig } from "../config/storage.js";
import {
  downloadFileToPath,
  storageUrlToKey,
} from "../services/storage.service.js";
import { stageProjectFonts } from "../services/export-fonts.service.js";
import {
  renderFramesWithChromium,
  type FrameExportPayload,
} from "../services/frame-export.service.js";
import { logger } from "../utils/logger.js";
import { editorNs } from "../index.js";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { internalApiBaseUrl } from "../utils/internal-api-url.js";
import { env } from "../config/env.js";

async function resolveLutCubePath(
  lutId: string,
  projectId: string,
  tempDir: string,
  intensity = 1
): Promise<string | undefined> {
  const outName = `${lutId.replace(/[^a-z0-9_-]/gi, "_")}_i${Math.round(intensity * 100)}.cube`;
  const out = path.join(tempDir, outName);

  let lut = getBuiltinLut(lutId);
  if (!lut) {
    const row = await db.query.lutAssets.findFirst({
      where: eq(lutAssets.id, lutId),
    });
    if (!row || row.projectId !== projectId) return undefined;

    const key = storageUrlToKey(row.url);
    const localCopy = path.join(tempDir, path.basename(key) || "upload.cube");
    try {
      if (storageConfig.provider === "local") {
        const filePath = path.join(storageConfig.local.uploadDir, key);
        const text = await fs.readFile(filePath, "utf8");
        lut = parseCubeLut(text);
      } else {
        await downloadFileToPath(key, localCopy);
        const text = await fs.readFile(localCopy, "utf8");
        lut = parseCubeLut(text);
      }
    } catch (err: any) {
      logger.warn(
        { lutId, err: err?.message },
        "Failed to load LUT for export"
      );
      return undefined;
    }
  }

  const blended = blendCubeLut(lut, intensity);
  await fs.writeFile(out, serializeCubeLut(blended), "utf8");
  return out;
}

function emitProgress(projectId: string, jobId: string, progress: number, status: string) {
  editorNs.to(`project:${projectId}`).emit("render:progress", {
    jobId,
    progress: Math.round(progress),
    status,
  });
}

function webBaseUrl(): string {
  return process.env.FRONTEND_URL || process.env.WEB_URL || "http://localhost:3000";
}

async function processRenderJob(job: Job<RenderJobData>): Promise<void> {
  const { projectId, jobId, settings } = job.data;
  // Backward-compatible defaults for jobs queued before color-managed export.
  const colorSpace = settings.colorSpace || "rec709";
  const isMasterCodec = settings.videoCodec.startsWith("prores-") || settings.videoCodec.startsWith("dnxhr-");
  const bitDepth = settings.videoCodec === "h264" ? 8 : (settings.bitDepth || 10);
  const audioCodec = isMasterCodec ? "pcm-s24le" : (settings.audioCodec || "aac");

  logger.info({ jobId, projectId }, "Render job started");

  await db
    .update(renderJobs)
    .set({ status: "processing", progress: 0, startedAt: new Date() })
    .where(eq(renderJobs.id, jobId));

  emitProgress(projectId, jobId, 0, "processing");

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const projectData = project.data as any;
  const tracks = (projectData?.tracks || []) as Track[];
  const transitions = (projectData?.transitions || []) as Transition[];
  const sequences = (projectData?.sequences || []) as Sequence[];
  const seqIssues = validateSequences({ tracks, transitions, sequences });
  const fatalSeq = seqIssues.find(
    (i) =>
      i.code === "missing_sequence" ||
      i.code === "nested_depth" ||
      i.code === "nest_xor_media" ||
      i.code === "nest_xor_content"
  );
  if (fatalSeq) {
    throw new Error(`Export failed: ${fatalSeq.message}`);
  }
  const visibleTracks = tracks.filter((track: any) => track.visible !== false);
  const hasSoloTrack = visibleTracks.some((track: any) => track.solo === true);
  const renderTracks = visibleTracks
    .filter((track: any) => !hasSoloTrack || track.solo === true)
    .sort((a: any, b: any) => (Number(a.order) || 0) - (Number(b.order) || 0));
  const audioMixer = (projectData?.audioMixer || {}) as AudioMixer;
  const duck = normalizeDuckSettings(audioMixer.duck);
  const masteringFilters = ffmpegMasteringFilters(audioMixer.mastering);
  const voiceWindows = duck.enabled
    ? voiceActivityWindows(visibleTracks, audioMixer, { honorSolo: true })
    : [];

  const assets = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, projectId),
  });

  emitProgress(projectId, jobId, 10, "processing");

  await db
    .update(renderJobs)
    .set({ status: "encoding", progress: 20 })
    .where(eq(renderJobs.id, jobId));
  emitProgress(projectId, jobId, 20, "encoding");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tempo-render-"));

  try {
    const stagedFonts = await stageProjectFonts(projectId, tempDir);

    const inputFiles: RenderInputFile[] = [];
    const textClips: AssSubtitleClip[] = [];
    let timelineDuration = Math.max(0, Number((project.settings as any)?.duration) || 0);

    for (let trackIndex = 0; trackIndex < renderTracks.length; trackIndex++) {
      const track = renderTracks[trackIndex]!;
      const clips = track.clips || [];
      for (const clip of clips) {
        const timelineStart = Math.max(0, Number(clip.startTime) || 0);
        const duration = Math.max(0, Number(clip.duration) || 0);
        if (duration <= 0) continue;
        timelineDuration = Math.max(timelineDuration, timelineStart + duration);

        // Nest clips force frame path — skip FFmpeg media inputs for them
        if (isNestClip(clip)) continue;

        if (track.type === "text" && clip.textParams) {
          textClips.push({
            startTime: timelineStart,
            duration,
            layer: trackIndex,
            opacity: clip.opacity,
            transform: clip.transform,
            textParams: clip.textParams,
          });
          continue;
        }

        if (track.type !== "video" && track.type !== "audio") continue;
        if (!clip.sourceMediaId) continue;
        const asset = assets.find((candidate: any) => candidate.id === clip.sourceMediaId);
        if (!asset) continue;

        let filePath: string;
        if (storageConfig.provider === "local") {
          const key = asset.url.replace(/^\/uploads\//, "");
          filePath = path.join(storageConfig.local.uploadDir, key);
        } else {
          const key = storageUrlToKey(asset.url);
          const ext = path.extname(key) || "";
          filePath = path.join(tempDir, `media-${asset.id}${ext}`);
          try {
            await downloadFileToPath(key, filePath);
          } catch (err: any) {
            logger.warn(
              { jobId, assetId: asset.id, err: err?.message },
              "Failed to download media for export; skipping clip"
            );
            continue;
          }
        }

        const mediaType =
          asset.type === "image" || asset.type === "video" || asset.type === "audio"
            ? asset.type
            : undefined;
        const trackMuted = audioMixer.trackMutes?.[track.id] === true;
        const trackVolume = Math.max(0, Number(audioMixer.trackVolumes?.[track.id] ?? 1) || 0);
        const clipVolume = Math.max(0, Number(clip.volume ?? 1) || 0);
        const baseVol = clip.muted || trackMuted ? 0 : clipVolume * trackVolume;
        const isMusic = getTrackRole(audioMixer, track.id) === "music";
        let volumeExpr: string | undefined;
        let panExpr: string | undefined;
        const volumeAutomation = resolveAudioAutomationBreakpoints(clip, audioMixer, track.id, "volume");
        const hasVolumeAutomation = Boolean(
          clip.audioAutomation?.volume?.length || audioMixer.trackAutomation?.[track.id]?.volume?.length
        );
        const panAutomation = resolveAudioAutomationBreakpoints(clip, audioMixer, track.id, "pan");
        const hasPanAutomation = Boolean(
          clip.audioAutomation?.pan?.length || audioMixer.trackAutomation?.[track.id]?.pan?.length
        );
        const hasStaticPan =
          Math.abs(Number(clip.pan ?? 0) || 0) > 1e-4 ||
          Math.abs(Number(audioMixer.trackPans?.[track.id] ?? 0) || 0) > 1e-4;
        let duckBreakpoints: Array<{ t: number; value: number }> | undefined;
        // Rule mode: offline volume envelope. Sidechain mode uses FFmpeg sidechaincompress in the mix graph.
        if (baseVol > 0 && isMusic && duck.enabled && duck.mode !== "sidechain") {
          const bp = musicDuckBreakpoints(
            timelineStart,
            duration,
            voiceWindows,
            duck
          );
          duckBreakpoints = bp.map((point) => ({ t: point.t, value: point.gain }));
        }
        if (baseVol > 0 && (hasVolumeAutomation || duckBreakpoints)) {
          const gainBreakpoints = multiplyAudioAutomationBreakpoints(
            duration,
            volumeAutomation,
            duckBreakpoints
          ).map((point) => ({ t: point.t, gain: point.value }));
          volumeExpr = ffmpegVolumeExprFromBreakpoints(gainBreakpoints, baseVol);
        }
        if (hasPanAutomation || hasStaticPan) {
          panExpr = ffmpegAudioAutomationExpr(panAutomation, 0);
        }
        const audioFilters = [
          ...ffmpegEqFilters(normalizeTrackEq(audioMixer.trackEq?.[track.id])),
          ...ffmpegAudioPostFilters(normalizeTrackAudioPost(audioMixer.trackPost?.[track.id])),
        ];

        const effects = Array.isArray(clip.effects) ? clip.effects : [];
        let lutCubePath: string | undefined;
        const lutFx = effects.find(
          (e: any) => e?.enabled !== false && e?.type === "lut" && e?.params?.lutId
        );
        if (lutFx) {
          const intensity = Number(lutFx.params?.intensity ?? 1);
          lutCubePath = await resolveLutCubePath(
            String(lutFx.params.lutId),
            projectId,
            tempDir,
            intensity
          );
          if (!lutCubePath) {
            logger.warn(
              { jobId, lutId: lutFx.params.lutId },
              "LUT file missing for export; skipping lut3d"
            );
          }
        }

        inputFiles.push({
          path: filePath,
          startTime: Math.max(0, Number(clip.sourceOffset) || 0),
          timelineStart,
          duration,
          speed: Math.max(0.000001, Math.abs(Number(clip.speed) || 1)),
          volume: baseVol,
          volumeExpr,
          panExpr,
          audioFilters: audioFilters.length ? audioFilters : undefined,
          fadeInSec: Math.max(0, Number(clip.fadeInSec) || 0),
          fadeOutSec: Math.max(0, Number(clip.fadeOutSec) || 0),
          audioFadeCurve: clip.audioFadeCurve,
          mediaType,
          clipId: clip.id,
          audioRole: getTrackRole(audioMixer, track.id),
          muteAudio:
            clip.reversed === true ||
            (Number(clip.speed) || 1) < 0 ||
            (Array.isArray(clip.speedRamp) && clip.speedRamp.length >= 2),
          hold:
            clip.hold?.at === "in" || clip.hold?.at === "out"
              ? {
                  at: clip.hold.at,
                  durationSec: Math.max(0, Number(clip.hold.durationSec) || 0),
                }
              : undefined,
          effects: effects.map((e: any) => ({
            type: String(e.type),
            enabled: e.enabled !== false,
            params: e.params || {},
          })),
          lutCubePath,
        });
      }
    }

    const projectTransitions = transitions;

    for (const tr of projectTransitions) {
      const a = inputFiles.find((f) => f.clipId === tr.clipAId);
      const b = inputFiles.find((f) => f.clipId === tr.clipBId);
      if (!a || !b) continue;
      // Geometric transitions (wipe/push) render via frame path — skip FFmpeg fades
      const def = getTransitionType(tr.type);
      if (def?.exportBackend === "frame" || def?.mixFamily === "geometric") continue;

      const aEnd = (a.timelineStart || 0) + a.duration;
      const overlapStart = aEnd - tr.duration;
      if (tr.type === "dip-black") {
        const half = tr.duration / 2;
        a.videoFadeOut = { start: overlapStart, duration: half };
        b.videoFadeIn = { start: overlapStart + half, duration: half };
      } else {
        a.videoFadeOut = { start: overlapStart, duration: tr.duration };
        b.videoFadeIn = { start: overlapStart, duration: tr.duration };
      }
    }

    let subtitlePath: string | undefined;
    if (textClips.length > 0) {
      subtitlePath = path.join(tempDir, "timeline.ass");
      await fs.writeFile(
        subtitlePath,
        generateAssSubtitles(
          textClips,
          settings.width,
          settings.height,
          stagedFonts.familyByFontId
        ),
        "utf8"
      );
    }

    const outputExtension = isMasterCodec ? "mov" : "mp4";
    const outputFilename = `render-${jobId}.${outputExtension}`;
    const outputPath = path.join(tempDir, outputFilename);

    if (inputFiles.length === 0 && textClips.length === 0 && !needsFrameExport(renderTracks, transitions, sequences)) {
      throw new Error("No visible timeline clips to render");
    }

    const logicalWidth = Math.max(2, Number((project.settings as any)?.width) || settings.width);
    const logicalHeight = Math.max(2, Number((project.settings as any)?.height) || settings.height);
    const outputSizeDiffers = logicalWidth !== settings.width || logicalHeight !== settings.height;
    const useFramePath = outputSizeDiffers || needsFrameExport(renderTracks, transitions, sequences);

    let ok = false;

    if (useFramePath) {
      logger.info({ jobId }, "Using Chromium frame export path");
      emitProgress(projectId, jobId, 25, "encoding");

      const fontRows = await db.query.fontAssets.findMany({
        where: eq(fontAssets.projectId, projectId),
      });
      const lutRows = await db.query.lutAssets.findMany({
        where: eq(lutAssets.projectId, projectId),
      });

      const payload: FrameExportPayload = {
        jobId,
        width: logicalWidth,
        height: logicalHeight,
        fps: settings.fps,
        duration: timelineDuration,
        backgroundColor: (project.settings as any)?.backgroundColor,
        deliveryProfile: (project.settings as any)?.deliveryProfile,
        exportBitDepth: bitDepth,
        allowSoftwareWebGpu: env.OFFLINE_WEBGPU_MODE === "auto",
        apiBaseUrl: internalApiBaseUrl(),
        tracks: renderTracks,
        transitions,
        sequences,
        cameras: Array.isArray((projectData as any).cameras) ? (projectData as any).cameras : [],
        lights: Array.isArray((projectData as any).lights) ? (projectData as any).lights : [],
        mediaAssets: assets.map((a) => ({
          id: a.id,
          type: a.type,
          url: a.url,
          name: a.name,
          duration: a.duration,
          metadata: a.metadata as MediaMetadata,
        })),
        fonts: fontRows.map((f) => ({
          id: f.id,
          familyName: f.familyName,
          url: f.url,
          format: f.format,
        })),
        luts: lutRows.map((l) => ({
          id: l.id,
          name: l.name,
          url: l.url,
          format: l.format,
        })),
      };

      const framesDir = path.join(tempDir, "frames");
      let intermediateVideoPath: string | undefined;
      try {
        const frameResult = await renderFramesWithChromium({
          webBaseUrl: webBaseUrl(),
          payload,
          framesDir,
          onProgress: async (ratio) => {
            const progress = Math.round(30 + ratio * 45);
            await db
              .update(renderJobs)
              .set({ status: "encoding", progress })
              .where(eq(renderJobs.id, jobId));
            emitProgress(projectId, jobId, progress, "encoding");
          },
        });
        // Float-compositor frames are cached with lossless FFV1 for the final
        // delivery encode, avoiding both PNG quantization and a huge raw spool.
        intermediateVideoPath = frameResult.intermediateVideoPath;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.startsWith("Export media preflight failed:") ||
          message.includes("WebGPU adapter unavailable") ||
          message.includes("Chromium executable missing")
        ) {
          throw new UnrecoverableError(message);
        }
        throw error;
      }

      const sidechainDuck =
        duck.enabled && duck.mode === "sidechain"
          ? {
              level: duck.level,
              attackSec: duck.attackSec,
              releaseSec: duck.releaseSec,
            }
          : undefined;

      const audioPath = path.join(tempDir, audioCodec === "pcm-s24le" ? "mix.wav" : "mix.m4a");
      const audioOk = await renderTimelineAudio({
        inputFiles,
        outputPath: audioPath,
        duration: timelineDuration,
        masterVolume: Math.max(0, Number(audioMixer.masterVolume ?? 1) || 0),
        audioBitrate: settings.audioBitrate,
        audioCodec,
        sidechainDuck,
        masteringFilters,
      });
      if (!audioOk) throw new Error("Failed to render timeline audio for frame export");

      emitProgress(projectId, jobId, 80, "encoding");
      ok = await encodeFramesWithAudio({
        framesDir,
        audioPath,
        outputPath,
        fps: settings.fps,
        videoBitrate: settings.videoBitrate,
        audioBitrate: settings.audioBitrate,
        videoCodec: settings.videoCodec,
        audioCodec,
        colorSpace,
        bitDepth,
        hdrMetadata: settings.hdrMetadata,
        qualityPreset: settings.qualityPreset,
        duration: timelineDuration,
        outputWidth: settings.width,
        outputHeight: settings.height,
        intermediateVideoPath,
      });
    } else {
      emitProgress(projectId, jobId, 30, "encoding");
      const sidechainDuck =
        duck.enabled && duck.mode === "sidechain"
          ? {
              level: duck.level,
              attackSec: duck.attackSec,
              releaseSec: duck.releaseSec,
            }
          : undefined;
      ok = await renderVideo({
        inputFiles,
        outputPath,
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        videoBitrate: settings.videoBitrate,
        audioBitrate: settings.audioBitrate,
        videoCodec: settings.videoCodec,
        audioCodec,
        colorSpace,
        bitDepth,
        hdrMetadata: settings.hdrMetadata,
        qualityPreset: settings.qualityPreset,
        duration: timelineDuration,
        backgroundColor: (project.settings as any)?.backgroundColor,
        masterVolume: Math.max(0, Number(audioMixer.masterVolume ?? 1) || 0),
        subtitlePath,
        fontsDir: stagedFonts.fontsDir,
        sidechainDuck,
        masteringFilters,
      });
    }

    if (!ok) throw new Error(useFramePath ? "Frame export encode failed" : "FFmpeg render failed");

    emitProgress(projectId, jobId, 85, "uploading");
    await db
      .update(renderJobs)
      .set({ status: "uploading", progress: 85 })
      .where(eq(renderJobs.id, jobId));

    let outputUrl: string;
    if (storageConfig.provider === "local") {
      const destKey = `renders/${outputFilename}`;
      const destPath = path.join(storageConfig.local.uploadDir, destKey);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(outputPath, destPath);
      outputUrl = `/uploads/${destKey}`;
    } else {
      outputUrl = `/uploads/renders/${outputFilename}`;
    }

    await db
      .update(renderJobs)
      .set({
        status: "completed",
        progress: 100,
        outputUrl,
        completedAt: new Date(),
      })
      .where(eq(renderJobs.id, jobId));

    emitProgress(projectId, jobId, 100, "completed");
    editorNs.to(`project:${projectId}`).emit("render:complete", {
      jobId,
      outputUrl,
    });

    logger.info({ jobId, outputUrl, useFramePath }, "Render job completed");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

let _worker: Worker | null = null;

export function startRenderWorker(): void {
  if (_worker) return;

  _worker = new Worker(RENDER_QUEUE_NAME, processRenderJob, {
    connection: getRedisConnection(),
    concurrency: 1,
  });

  _worker.on("failed", async (job, err) => {
    if (!job) return;
    const { projectId, jobId } = job.data as RenderJobData;
    logger.error({ jobId, err: err.message }, "Render job failed");

    await db
      .update(renderJobs)
      .set({ status: "failed", error: err.message })
      .where(eq(renderJobs.id, jobId));

    emitProgress(projectId, jobId, 0, "failed");
    editorNs.to(`project:${projectId}`).emit("render:failed", {
      jobId,
      error: err.message,
    });
  });

  logger.info("Render worker started");
}
