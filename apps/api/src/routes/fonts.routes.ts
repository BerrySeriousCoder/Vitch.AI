import { Router, type Request, type Response, type Router as RouterType } from "express";
import { eq, and } from "drizzle-orm";
import { db, projects, fontAssets } from "@tempo/db";
import type { FontAsset } from "@tempo/types";
import { authMiddleware, AppError } from "../middleware/index.js";
import {
  uploadFont,
  detectFontFormat,
  sanitizeFamilyName,
} from "../middleware/upload-font.middleware.js";
import { uploadFile, deleteFile, storageUrlToKey } from "../services/storage.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import { getGoogleFontCatalog } from "../services/google-fonts.service.js";

const router: RouterType = Router({ mergeParams: true });

router.use(authMiddleware);

async function assertProjectAccess(projectId: string, userId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== userId) throw new AppError(403, "Access denied");
  return project;
}

// GET /api/projects/:projectId/fonts/google-catalog
router.get("/google-catalog", async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  await assertProjectAccess(projectId, req.user!.userId);
  sendSuccess(res, await getGoogleFontCatalog());
});

function toFontAsset(row: typeof fontAssets.$inferSelect): FontAsset {
  return {
    id: row.id,
    familyName: row.familyName,
    fileName: row.fileName,
    url: row.url,
    format: row.format as FontAsset["format"],
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
  };
}

// GET /api/projects/:projectId/fonts
router.get("/", async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  await assertProjectAccess(projectId, req.user!.userId);

  const rows = await db.query.fontAssets.findMany({
    where: eq(fontAssets.projectId, projectId),
  });

  sendSuccess(
    res,
    rows.map(toFontAsset)
  );
});

// POST /api/projects/:projectId/fonts
router.post("/", uploadFont, async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  await assertProjectAccess(projectId, req.user!.userId);

  const file = req.file;
  if (!file) throw new AppError(400, "No font file uploaded");

  const familyFromBody =
    typeof req.body?.familyName === "string" ? req.body.familyName : "";
  const familyName = sanitizeFamilyName(
    familyFromBody || file.originalname
  );
  const format = detectFontFormat(file.originalname);

  const { url } = await uploadFile(
    file.buffer,
    file.originalname,
    file.mimetype,
    "fonts"
  );

  const [row] = await db
    .insert(fontAssets)
    .values({
      projectId,
      userId: req.user!.userId,
      familyName,
      fileName: file.originalname,
      url,
      format,
    })
    .returning();

  if (!row) throw new AppError(500, "Failed to save font");

  logger.info(
    { fontId: row.id, projectId, familyName },
    "font uploaded"
  );

  sendSuccess(res, toFontAsset(row), 201);
});

// DELETE /api/projects/:projectId/fonts/:fontId
router.delete("/:fontId", async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  const fontId = req.params.fontId as string;
  await assertProjectAccess(projectId, req.user!.userId);

  const row = await db.query.fontAssets.findFirst({
    where: and(eq(fontAssets.id, fontId), eq(fontAssets.projectId, projectId)),
  });
  if (!row) throw new AppError(404, "Font not found");

  const key = storageUrlToKey(row.url);
  await deleteFile(key).catch(() => undefined);

  await db.delete(fontAssets).where(eq(fontAssets.id, fontId));

  logger.info({ fontId, projectId }, "font deleted");
  sendSuccess(res, { id: fontId });
});

export default router;
