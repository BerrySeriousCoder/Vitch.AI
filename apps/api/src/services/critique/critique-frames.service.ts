import path from "path";
import fs from "fs/promises";
import os from "os";
import { eq } from "drizzle-orm";
import { db, mediaAssets, fontAssets, lutAssets, projects } from "@tempo/db";
import type { Track, Transition, Sequence, MediaMetadata } from "@tempo/types";
import {
  renderFramesAtTimesWithChromium,
  type FrameExportPayload,
} from "../frame-export.service.js";
import { logger } from "../../utils/logger.js";
import { internalApiBaseUrl } from "../../utils/internal-api-url.js";
import { env } from "../../config/env.js";

function webBaseUrl(): string {
  return process.env.FRONTEND_URL || process.env.WEB_URL || "http://localhost:3000";
}

export interface CritiqueFrame {
  time: number;
  /** PNG bytes — prefer over path so temp dirs can be deleted immediately. */
  data: Buffer;
  path?: string;
}

/**
 * Capture composed WebGPU frames at specific times for the vision critic.
 * Temp files are always removed before return (success or failure).
 */
export async function sampleCritiqueFrames(options: {
  projectId: string;
  tracks: Track[];
  transitions: Transition[];
  sequences?: Sequence[];
  times: number[];
  settings?: {
    width?: number;
    height?: number;
    fps?: number;
    backgroundColor?: string;
    deliveryProfile?: import("@tempo/types").DeliveryProfile;
  };
  onProgress?: (captured: number, total: number) => void | Promise<void>;
}): Promise<CritiqueFrame[]> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, options.projectId),
  });
  if (!project) throw new Error(`Project ${options.projectId} not found`);

  const persistedSettings = (project.settings || {}) as {
    width?: number;
    height?: number;
    fps?: number;
    backgroundColor?: string;
    deliveryProfile?: import("@tempo/types").DeliveryProfile;
  };
  // Edit Like This verifies the not-yet-persisted draft. Its delivery contract
  // must win over the previous database snapshot or portrait edits can be
  // compared through a stale landscape render.
  const settings = { ...persistedSettings, ...(options.settings || {}) };
  const width = Math.max(64, Number(settings.width) || 1280);
  const height = Math.max(64, Number(settings.height) || 720);
  const fps = Math.max(1, Number(settings.fps) || 30);

  const assets = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, options.projectId),
  });
  const fontRows = await db.query.fontAssets.findMany({
    where: eq(fontAssets.projectId, options.projectId),
  });
  const lutRows = await db.query.lutAssets.findMany({
    where: eq(lutAssets.projectId, options.projectId),
  });

  let duration = 0.1;
  for (const track of options.tracks) {
    for (const clip of track.clips || []) {
      duration = Math.max(duration, clip.startTime + clip.duration);
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tempo-critique-"));
  const framesDir = path.join(tempDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });

  const payload: FrameExportPayload = {
    jobId: `critique-${options.projectId.slice(0, 8)}`,
    width,
    height,
    fps,
    duration,
    backgroundColor: settings.backgroundColor,
    deliveryProfile: settings.deliveryProfile,
    allowSoftwareWebGpu: env.OFFLINE_WEBGPU_MODE === "auto",
    apiBaseUrl: internalApiBaseUrl(),
    tracks: options.tracks,
    transitions: options.transitions,
    sequences: options.sequences || [],
    cameras: Array.isArray((project.data as any)?.cameras) ? (project.data as any).cameras : [],
    lights: Array.isArray((project.data as any)?.lights) ? (project.data as any).lights : [],
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

  const times = options.times.map((t) =>
    Math.max(0, Math.min(duration - 1 / fps, t))
  );

  try {
    const result = await renderFramesAtTimesWithChromium({
      webBaseUrl: webBaseUrl(),
      payload,
      framesDir,
      times,
      onProgress: async (ratio) => {
        const captured = Math.min(times.length, Math.max(0, Math.round(ratio * times.length)));
        await options.onProgress?.(captured, times.length);
      },
    });
    const frames: CritiqueFrame[] = [];
    for (const f of result.frames) {
      const data = await fs.readFile(f.path);
      frames.push({ time: f.time, data, path: f.path });
    }
    logger.info(
      { count: frames.length, projectId: options.projectId },
      "Critique frames captured"
    );
    return frames;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
