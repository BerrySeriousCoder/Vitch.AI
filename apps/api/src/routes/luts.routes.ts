import { Router, type Request, type Response, type Router as RouterType } from "express";
import { eq, and } from "drizzle-orm";
import { db, projects, lutAssets } from "@tempo/db";
import type { LutAsset } from "@tempo/types";
import { parseCubeLut } from "@tempo/editor-core";
import { authMiddleware, AppError } from "../middleware/index.js";
import { uploadLut, sanitizeLutName } from "../middleware/upload-lut.middleware.js";
import { uploadFile, deleteFile, storageUrlToKey } from "../services/storage.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";

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

function toLutAsset(row: typeof lutAssets.$inferSelect): LutAsset {
  return {
    id: row.id,
    name: row.name,
    fileName: row.fileName,
    url: row.url,
    format: "cube",
    size: row.size,
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
  };
}

// GET /api/projects/:projectId/luts
router.get("/", async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  await assertProjectAccess(projectId, req.user!.userId);

  const rows = await db.query.lutAssets.findMany({
    where: eq(lutAssets.projectId, projectId),
  });

  sendSuccess(
    res,
    rows.map(toLutAsset)
  );
});

// POST /api/projects/:projectId/luts
router.post("/", uploadLut, async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  await assertProjectAccess(projectId, req.user!.userId);

  const file = req.file;
  if (!file) throw new AppError(400, "No LUT file uploaded");

  let size: number | null = null;
  try {
    const parsed = parseCubeLut(file.buffer.toString("utf8"));
    size = parsed.size;
  } catch (err: any) {
    throw new AppError(400, err?.message || "Invalid .cube LUT file");
  }

  const nameFromBody = typeof req.body?.name === "string" ? req.body.name : "";
  const name = sanitizeLutName(nameFromBody || file.originalname);

  const { url } = await uploadFile(
    file.buffer,
    file.originalname,
    "application/octet-stream",
    "luts"
  );

  const [row] = await db
    .insert(lutAssets)
    .values({
      projectId,
      userId: req.user!.userId,
      name,
      fileName: file.originalname,
      url,
      format: "cube",
      size,
    })
    .returning();

  if (!row) throw new AppError(500, "Failed to save LUT");

  logger.info({ lutId: row.id, projectId, name, size }, "lut uploaded");

  sendSuccess(res, toLutAsset(row), 201);
});

// DELETE /api/projects/:projectId/luts/:lutId
router.delete("/:lutId", async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  const lutId = req.params.lutId as string;
  await assertProjectAccess(projectId, req.user!.userId);

  const row = await db.query.lutAssets.findFirst({
    where: and(eq(lutAssets.id, lutId), eq(lutAssets.projectId, projectId)),
  });
  if (!row) throw new AppError(404, "LUT not found");

  const key = storageUrlToKey(row.url);
  await deleteFile(key).catch(() => undefined);

  await db.delete(lutAssets).where(eq(lutAssets.id, lutId));

  logger.info({ lutId, projectId }, "lut deleted");
  sendSuccess(res, { id: lutId });
});

export default router;
