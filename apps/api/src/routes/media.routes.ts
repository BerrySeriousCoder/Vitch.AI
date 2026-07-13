import { Router, type Request, type Response, type Router as RouterType } from "express";
import { eq, and } from "drizzle-orm";
import { db, projects, mediaAssets } from "@tempo/db";
import { authMiddleware, AppError } from "../middleware/index.js";
import { uploadSingle } from "../middleware/upload.middleware.js";
import { uploadFile, deleteFile, storageUrlToKey } from "../services/storage.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import { probe, generateThumbnail } from "../utils/ffmpeg.js";
import { storageConfig } from "../config/storage.js";
import fs from "fs/promises";
import os from "os";
import {
  classifyMediaAsset,
  classifyProjectMedia,
  enqueueMediaAnalysis,
} from "../services/media/media-analysis.service.js";
import { clearEditorialProxy, requestEditorialProxy } from "../services/media/proxy.service.js";
import path from "path";
import { orientationFromDimensions } from "@tempo/editor-core";

const router: RouterType = Router();

router.use(authMiddleware);

function detectMediaType(mimeType: string): "video" | "audio" | "image" {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "image";
}

function svgDimensions(source: Buffer): { width?: number; height?: number } {
  const head = source.subarray(0, 16_384).toString("utf8");
  const svg = head.match(/<svg\b[^>]*>/i)?.[0] || "";
  const numeric = (name: string) => Number(svg.match(new RegExp(`\\b${name}=["']([\\d.]+)`, "i"))?.[1]);
  const width = numeric("width");
  const height = numeric("height");
  if (Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0) return { width, height };
  const viewBox = svg.match(/\bviewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
  return viewBox ? { width: Number(viewBox[1]), height: Number(viewBox[2]) } : {};
}

function probedMetadata(info: Awaited<ReturnType<typeof probe>>): Record<string, unknown> {
  return {
    duration: info.duration || undefined,
    width: info.width,
    height: info.height,
    displayWidth: info.displayWidth,
    displayHeight: info.displayHeight,
    sampleAspectRatio: info.sampleAspectRatio,
    displayAspectRatio: info.displayAspectRatio,
    orientation: orientationFromDimensions(info.displayWidth, info.displayHeight),
    rotation: info.rotation,
    fps: info.fps,
    isVariableFrameRate: info.isVariableFrameRate,
    codec: info.videoCodec || info.audioCodec,
    pixelFormat: info.pixelFormat,
    bitDepth: info.bitDepth,
    colorPrimaries: info.colorPrimaries,
    colorTransfer: info.colorTransfer,
    colorSpace: info.colorSpace,
    colorRange: info.colorRange,
    isHdr: info.isHdr,
    bitrate: info.bitrate,
    sampleRate: info.sampleRate,
    channels: info.channels,
  };
}

async function inspectionSource(file: Express.Multer.File, storageKey: string) {
  if (storageConfig.provider === "local") {
    return {
      sourcePath: path.join(storageConfig.local.uploadDir, storageKey),
      cleanup: async () => undefined,
    };
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "tempo-probe-"));
  const sourcePath = path.join(workDir, `source${path.extname(file.originalname) || ".bin"}`);
  await fs.writeFile(sourcePath, file.buffer);
  return {
    sourcePath,
    cleanup: () => fs.rm(workDir, { recursive: true, force: true }),
  };
}

async function createVideoThumbnail(
  sourcePath: string,
  storageKey: string,
  originalName: string,
  seek: number
): Promise<string | null> {
  if (storageConfig.provider === "local") {
    const thumbKey = `thumbnails/${storageKey.replace(/\.[^.]+$/, ".jpg")}`;
    const thumbPath = path.join(storageConfig.local.uploadDir, thumbKey);
    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    return await generateThumbnail(sourcePath, thumbPath, seek) ? `/uploads/${thumbKey}` : null;
  }
  const thumbPath = path.join(path.dirname(sourcePath), "thumbnail.jpg");
  if (!(await generateThumbnail(sourcePath, thumbPath, seek))) return null;
  const uploaded = await uploadFile(
    await fs.readFile(thumbPath),
    `${path.basename(originalName, path.extname(originalName)) || "video"}-thumbnail.jpg`,
    "image/jpeg",
    "thumbnails"
  );
  return uploaded.url;
}

async function assertProjectAccess(projectId: string, userId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== userId) throw new AppError(403, "Access denied");
  return project;
}

// ─── Upload Media ─────────────────────────────────────────
router.post("/:projectId/media", uploadSingle, async (req: Request, res: Response) => {
  const { projectId } = req.params;

  await assertProjectAccess(projectId as string, req.user!.userId);

  const file = req.file;
  if (!file) throw new AppError(400, "No file uploaded");

  const mediaType = detectMediaType(file.mimetype);
  const isLottie = (file.mimetype === "application/json" || file.mimetype === "application/zip") && /\.(json|lottie)$/i.test(file.originalname);

  const { key, url } = await uploadFile(file.buffer, file.originalname, file.mimetype);

  let enrichedMetadata: Record<string, any> = {
    mimeType: file.mimetype,
    fileSize: file.size,
    analysisStatus: "pending",
    ...(mediaType === "video" ? { proxyStatus: "processing" } : {}),
  };
  let mediaDuration: number | null = null;
  let thumbnailUrl: string | null = null;

  const inspection = await inspectionSource(file, key);
  try {
    if (mediaType === "image") {
      thumbnailUrl = url;
      const isSvg = file.mimetype === "image/svg+xml" || /\.svg$/i.test(file.originalname);
      const probeResult = isSvg ? svgDimensions(file.buffer) : isLottie ? {} : await probe(inspection.sourcePath);
      if (probeResult.width || probeResult.height) {
        enrichedMetadata = {
          ...enrichedMetadata,
          width: probeResult.width,
          height: probeResult.height,
          displayWidth: probeResult.width,
          displayHeight: probeResult.height,
          orientation: orientationFromDimensions(probeResult.width, probeResult.height),
        };
      }
      if (isLottie) enrichedMetadata = { ...enrichedMetadata, graphicFormat: "lottie" };
    } else if (mediaType === "video" || mediaType === "audio") {
      const probeResult = await probe(inspection.sourcePath);
      enrichedMetadata = {
        ...enrichedMetadata,
        ...probedMetadata(probeResult),
      };
      if (probeResult.duration > 0) {
        mediaDuration = probeResult.duration;
      }

      if (mediaType === "video") {
        const seek =
          probeResult.duration > 0 ? Math.min(1, probeResult.duration / 2) : 0;
        thumbnailUrl = await createVideoThumbnail(inspection.sourcePath, key, file.originalname, seek);
      }
    }
  } finally {
    await inspection.cleanup().catch(() => undefined);
  }

  const [asset] = await db
    .insert(mediaAssets)
    .values({
      projectId: projectId as string,
      userId: req.user!.userId,
      name: file.originalname,
      type: mediaType,
      url,
      fileSize: file.size,
      duration: mediaDuration,
      thumbnailUrl,
      status: "ready",
      metadata: enrichedMetadata,
    })
    .returning();

  logger.info(
    { assetId: asset?.id, projectId, type: mediaType, duration: mediaDuration },
    "media uploaded"
  );

  if (asset?.id) {
    enqueueMediaAnalysis(asset.id);
    if (mediaType === "video") {
      void requestEditorialProxy(asset.id).catch((err) =>
        logger.error({ err: err?.message, assetId: asset.id }, "Could not start automatic editorial proxy")
      );
    }
  }

  sendSuccess(res, asset, 201);
});

// ─── List Media ───────────────────────────────────────────
router.get("/:projectId/media", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  await assertProjectAccess(projectId as string, req.user!.userId);

  const assets = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, projectId as string),
  });

  sendSuccess(res, assets);
});

// ─── Analyze all (backfill) — before :mediaId routes ──────
router.post("/:projectId/media/analyze-all", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  await assertProjectAccess(projectId as string, req.user!.userId);

  const onlyMissing = req.body?.onlyMissing !== false;
  void classifyProjectMedia(projectId as string, { onlyMissing, concurrency: 2 }).catch(
    (err) => logger.error({ err: err?.message, projectId }, "analyze-all failed")
  );

  sendSuccess(res, {
    started: true,
    onlyMissing,
    message: "Media analysis started in background",
  });
});

// Backfill older projects created before automatic ingest proxies existed.
router.post("/:projectId/media/proxy-all", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  await assertProjectAccess(projectId as string, req.user!.userId);
  const assets = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, projectId as string),
  });
  const candidates = assets.filter((asset) => {
    const meta = (asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {}) as Record<string, unknown>;
    return asset.type === "video" && !asset.proxyUrl && meta.proxyStatus !== "processing" && meta.proxyStatus !== "error";
  });
  await Promise.all(candidates.map((asset) => requestEditorialProxy(asset.id)));
  sendSuccess(res, { started: candidates.length, assetIds: candidates.map((asset) => asset.id) }, 202);
});

// ─── Get Single Media ─────────────────────────────────────
router.get("/:projectId/media/:mediaId", async (req: Request, res: Response) => {
  const { projectId, mediaId } = req.params;

  await assertProjectAccess(projectId as string, req.user!.userId);

  const asset = await db.query.mediaAssets.findFirst({
    where: and(
      eq(mediaAssets.id, mediaId as string),
      eq(mediaAssets.projectId, projectId as string)
    ),
  });
  if (!asset) throw new AppError(404, "Media asset not found");

  sendSuccess(res, asset);
});

// ─── Re-analyze one asset ─────────────────────────────────
router.post(
  "/:projectId/media/:mediaId/analyze",
  async (req: Request, res: Response) => {
    const { projectId, mediaId } = req.params;
    await assertProjectAccess(projectId as string, req.user!.userId);

    const asset = await db.query.mediaAssets.findFirst({
      where: and(
        eq(mediaAssets.id, mediaId as string),
        eq(mediaAssets.projectId, projectId as string)
      ),
    });
    if (!asset) throw new AppError(404, "Media asset not found");

    const analysis = await classifyMediaAsset(mediaId as string);
    const updated = await db.query.mediaAssets.findFirst({
      where: eq(mediaAssets.id, mediaId as string),
    });

    sendSuccess(res, { asset: updated, analysis });
  }
);

// ─── Editorial proxy ─────────────────────────────────────
router.post("/:projectId/media/:mediaId/proxy", async (req: Request, res: Response) => {
  const { projectId, mediaId } = req.params;
  await assertProjectAccess(projectId as string, req.user!.userId);
  const asset = await db.query.mediaAssets.findFirst({
    where: and(eq(mediaAssets.id, mediaId as string), eq(mediaAssets.projectId, projectId as string)),
  });
  if (!asset) throw new AppError(404, "Media asset not found");
  if (asset.type !== "video") throw new AppError(400, "Editorial proxies are available for video assets only");
  await requestEditorialProxy(asset.id);
  sendSuccess(res, { started: true, assetId: asset.id, message: "Editorial proxy generation started" }, 202);
});

router.delete("/:projectId/media/:mediaId/proxy", async (req: Request, res: Response) => {
  const { projectId, mediaId } = req.params;
  await assertProjectAccess(projectId as string, req.user!.userId);
  const asset = await db.query.mediaAssets.findFirst({
    where: and(eq(mediaAssets.id, mediaId as string), eq(mediaAssets.projectId, projectId as string)),
  });
  if (!asset) throw new AppError(404, "Media asset not found");
  if (asset.proxyUrl) await deleteFile(storageUrlToKey(asset.proxyUrl)).catch(() => undefined);
  await clearEditorialProxy(asset.id);
  sendSuccess(res, { cleared: true, assetId: asset.id });
});

// ─── Relink missing/replaced source while retaining every timeline clip ID ──
router.post("/:projectId/media/:mediaId/relink", uploadSingle, async (req: Request, res: Response) => {
  const { projectId, mediaId } = req.params;
  await assertProjectAccess(projectId as string, req.user!.userId);
  const asset = await db.query.mediaAssets.findFirst({
    where: and(eq(mediaAssets.id, mediaId as string), eq(mediaAssets.projectId, projectId as string)),
  });
  if (!asset) throw new AppError(404, "Media asset not found");
  const file = req.file;
  if (!file) throw new AppError(400, "No replacement file supplied");
  if (detectMediaType(file.mimetype) !== asset.type) throw new AppError(400, `Replacement must be ${asset.type} media`);

  const previousUrl = asset.url;
  const previousThumbnail = asset.thumbnailUrl;
  const previousProxy = asset.proxyUrl;
  // Invalidates an in-flight proxy before the source URL changes.
  await clearEditorialProxy(asset.id);
  const { key, url } = await uploadFile(file.buffer, file.originalname, file.mimetype);
  let duration: number | null = null;
  let thumbnailUrl: string | null = asset.type === "image" ? url : null;
  let nextMetadata: Record<string, any> = {
    mimeType: file.mimetype,
    fileSize: file.size,
    analysisStatus: "pending",
    proxyStatus: asset.type === "video" ? "processing" : "none",
  };
  if (asset.type === "video" || asset.type === "audio") {
    const inspection = await inspectionSource(file, key);
    try {
      const info = await probe(inspection.sourcePath);
      duration = info.duration || null;
      nextMetadata = { ...nextMetadata, ...probedMetadata(info), ...(asset.type === "video" ? { audioAnalysisStatus: "pending" } : {}) };
      if (asset.type === "video") {
        thumbnailUrl = await createVideoThumbnail(
          inspection.sourcePath,
          key,
          file.originalname,
          info.duration > 0 ? Math.min(1, info.duration / 2) : 0
        );
      }
    } finally {
      await inspection.cleanup().catch(() => undefined);
    }
  }
  const [updated] = await db.update(mediaAssets).set({
    name: file.originalname,
    url,
    thumbnailUrl,
    proxyUrl: null,
    fileSize: file.size,
    duration,
    metadata: nextMetadata,
    status: "ready",
  }).where(eq(mediaAssets.id, asset.id)).returning();
  await deleteFile(storageUrlToKey(previousUrl)).catch(() => undefined);
  if (previousThumbnail && previousThumbnail !== previousUrl) await deleteFile(storageUrlToKey(previousThumbnail)).catch(() => undefined);
  if (previousProxy) await deleteFile(storageUrlToKey(previousProxy)).catch(() => undefined);
  enqueueMediaAnalysis(asset.id);
  if (asset.type === "video") {
    void requestEditorialProxy(asset.id).catch((err) =>
      logger.error({ err: err?.message, assetId: asset.id }, "Could not rebuild editorial proxy after relink")
    );
  }
  sendSuccess(res, updated);
});

// ─── Delete Media ─────────────────────────────────────────
router.delete("/:projectId/media/:mediaId", async (req: Request, res: Response) => {
  const { projectId, mediaId } = req.params;

  const asset = await db.query.mediaAssets.findFirst({
    where: and(
      eq(mediaAssets.id, mediaId as string),
      eq(mediaAssets.projectId, projectId as string)
    ),
  });
  if (!asset) throw new AppError(404, "Media asset not found");

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId as string),
  });
  if (project?.userId !== req.user!.userId) throw new AppError(403, "Access denied");

  await deleteFile(storageUrlToKey(asset.url));
  if (asset.thumbnailUrl && asset.thumbnailUrl !== asset.url) {
    await deleteFile(storageUrlToKey(asset.thumbnailUrl)).catch(() => undefined);
  }
  if (asset.proxyUrl) await deleteFile(storageUrlToKey(asset.proxyUrl)).catch(() => undefined);

  await db.delete(mediaAssets).where(eq(mediaAssets.id, mediaId as string));

  logger.info({ assetId: mediaId, projectId }, "media deleted");

  sendSuccess(res, { message: "Media deleted" });
});

export default router;
