import { Router, type Request, type Response } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, projects, renderJobs } from "@tempo/db";
import { authMiddleware, AppError } from "../middleware/index.js";
import { sendSuccess } from "../utils/response.js";
import { enqueueRenderJob, getRenderQueue } from "../services/render.service.js";
import { logger } from "../utils/logger.js";
import type { ExportSettings, HdrMasteringMetadata, VideoCodec } from "@tempo/types";

const router: Router = Router();

router.use(authMiddleware);

// ─── Create Render Job ───────────────────────────────────
router.post("/:projectId/render", async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId as string),
  });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== req.user!.userId) throw new AppError(403, "Access denied");

  // Idempotent submission: a project can have only one live render. This also
  // prevents a missed early socket event from turning a second click into a
  // hidden duplicate job behind the first one.
  const liveRows = await db.query.renderJobs.findMany({
    where: and(
      eq(renderJobs.projectId, projectId as string),
      inArray(renderJobs.status, ["queued", "processing", "encoding", "uploading"])
    ),
    orderBy: [desc(renderJobs.createdAt)],
  });
  const queue = getRenderQueue();
  for (const liveRow of liveRows) {
    const queuedJob = await queue.getJob(liveRow.id);
    const queueState = queuedJob ? await queuedJob.getState() : "unknown";
    if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(queueState)) {
      sendSuccess(res, liveRow, 200);
      return;
    }
    await db
      .update(renderJobs)
      .set({
        status: "failed",
        error: "Render worker lost this job before completion. Start the export again.",
      })
      .where(eq(renderJobs.id, liveRow.id));
  }

  const projectSettings = project.settings as { width?: number; height?: number; fps?: number };
  const width = Number(req.body.width || projectSettings.width || 1920);
  const height = Number(req.body.height || projectSettings.height || 1080);
  const fps = Number(req.body.fps || projectSettings.fps || 30);
  if (![width, height, fps].every(Number.isFinite)) throw new AppError(400, "Export dimensions and FPS must be finite numbers");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 7680 || height > 7680) {
    throw new AppError(400, "Export dimensions must be integers between 2 and 7680");
  }
  if (width % 2 || height % 2) throw new AppError(400, "Export dimensions must be even for professional YUV codecs");
  if (fps < 1 || fps > 120) throw new AppError(400, "Export FPS must be between 1 and 120");
  const projectRatio = Number(projectSettings.width || 1920) / Number(projectSettings.height || 1080);
  const exportRatio = width / height;
  if (Math.abs(projectRatio - exportRatio) / projectRatio > 0.001) {
    throw new AppError(400, "Export aspect ratio must match the project. Create or reflow a delivery variant before changing aspect ratio.");
  }
  const supportedCodecs = new Set<VideoCodec>([
    "h264",
    "h265",
    "prores-422-hq",
    "prores-4444",
    "dnxhr-hqx",
    "dnxhr-444",
  ]);
  const requestedCodec = String(req.body.videoCodec || "h264") as VideoCodec;
  if (!supportedCodecs.has(requestedCodec)) {
    throw new AppError(400, "Unsupported export codec");
  }
  const videoCodec = requestedCodec;

  const validColorSpaces = ["rec709", "rec2100-pq", "rec2100-hlg"];
  if (req.body.colorSpace !== undefined && !validColorSpaces.includes(String(req.body.colorSpace))) {
    throw new AppError(400, "Unsupported export color space");
  }
  const colorSpace = validColorSpaces.includes(String(req.body.colorSpace))
    ? req.body.colorSpace as ExportSettings["colorSpace"]
    : "rec709";
  const isHdr = colorSpace !== "rec709";
  const isMezzanine = videoCodec.startsWith("prores-") || videoCodec.startsWith("dnxhr-");
  if (videoCodec === "h264" && isHdr) {
    throw new AppError(400, "HDR requires HEVC Main10, ProRes, or DNxHR. H.264 export is Rec.709 only.");
  }
  const bitDepth: ExportSettings["bitDepth"] = videoCodec === "h264" ? 8 : 10;

  const finiteInRange = (value: unknown, fallback: number, minimum: number, maximum: number) => {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
      throw new AppError(400, `HDR metadata values must be between ${minimum} and ${maximum} nits`);
    }
    return parsed;
  };
  const rawHdr = req.body.hdrMetadata || {};
  const hdrMetadata: HdrMasteringMetadata | undefined = colorSpace === "rec2100-pq"
    ? {
        maxLuminance: finiteInRange(rawHdr.maxLuminance, 1000, 100, 10_000),
        minLuminance: finiteInRange(rawHdr.minLuminance, 0.0001, 0.00001, 5),
        maxCll: finiteInRange(rawHdr.maxCll, 1000, 100, 10_000),
        maxFall: finiteInRange(rawHdr.maxFall, 400, 50, 10_000),
      }
    : undefined;
  if (hdrMetadata && hdrMetadata.maxFall > hdrMetadata.maxCll) {
    throw new AppError(400, "HDR MaxFALL cannot exceed MaxCLL");
  }

  const qualityPreset = ["draft", "standard", "high", "ultra"].includes(String(req.body.qualityPreset))
    ? req.body.qualityPreset as ExportSettings["qualityPreset"]
    : "high";
  const settings: ExportSettings = {
    format: isMezzanine ? "mov" : "mp4",
    videoCodec,
    audioCodec: isMezzanine ? "pcm-s24le" : "aac",
    width,
    height,
    fps,
    videoBitrate: req.body.videoBitrate || "5000k",
    audioBitrate: req.body.audioBitrate || "192k",
    qualityPreset,
    colorSpace,
    bitDepth,
    ...(hdrMetadata ? { hdrMetadata } : {}),
  };

  const [job] = await db
    .insert(renderJobs)
    .values({
      projectId: projectId as string,
      userId: req.user!.userId,
      settings,
      status: "queued",
      progress: 0,
    })
    .returning();

  if (!job) throw new AppError(500, "Failed to create render job");

  await enqueueRenderJob({
    projectId: projectId as string,
    userId: req.user!.userId,
    jobId: job.id,
    settings,
  });

  logger.info({ jobId: job.id, projectId }, "Render job created");

  sendSuccess(res, job, 201);
});

// ─── List Render Jobs ────────────────────────────────────
router.get("/:projectId/render", async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId as string),
  });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== req.user!.userId) throw new AppError(403, "Access denied");

  const jobs = await db.query.renderJobs.findMany({
    where: eq(renderJobs.projectId, projectId as string),
    orderBy: [desc(renderJobs.createdAt)],
  });

  sendSuccess(res, jobs);
});

// ─── Get Single Render Job ───────────────────────────────
router.get("/:projectId/render/:jobId", async (req: Request, res: Response) => {
  const { projectId, jobId } = req.params;

  const job = await db.query.renderJobs.findFirst({
    where: and(
      eq(renderJobs.id, jobId as string),
      eq(renderJobs.projectId, projectId as string),
    ),
  });
  if (!job) throw new AppError(404, "Render job not found");

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId as string),
  });
  if (project?.userId !== req.user!.userId) throw new AppError(403, "Access denied");

  sendSuccess(res, job);
});

export default router;
