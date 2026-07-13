import { Router, type Request, type Response, type Router as RouterType } from "express";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import fs from "fs/promises";
import path from "path";
import { db, projects } from "@tempo/db";
import {
  listTempoPacks,
  registerTempoPack,
  validateTempoPackManifest,
  safePackPath,
  type TempoPackManifest,
} from "@tempo/editor-core";
import { authMiddleware, AppError } from "../middleware/index.js";
import { uploadPackZip } from "../middleware/upload-pack.middleware.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import { storageConfig } from "../config/storage.js";
import { ensureProjectPacksLoaded } from "../services/packs/load-project-packs.js";

const router: RouterType = Router({ mergeParams: true });
router.use(authMiddleware);

const uploadsRoot = storageConfig.local.uploadDir;

async function assertProjectAccess(projectId: string, userId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== userId) throw new AppError(403, "Access denied");
  return project;
}

function sanitizePackDirName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

async function extractPackZip(
  projectId: string,
  zipBuffer: Buffer
): Promise<{ packId: string; rootPath: string; manifest: TempoPackManifest }> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer));
  } catch {
    throw new AppError(400, "Invalid zip / .tempo-pack archive");
  }

  const names = Object.keys(entries);
  if (names.length === 0) throw new AppError(400, "Empty pack archive");
  if (names.length > 200) throw new AppError(400, "Pack has too many files");

  const manifestKey =
    names.find((n) => n.replace(/\\/g, "/") === "manifest.json") ||
    names.find((n) => n.replace(/\\/g, "/").endsWith("/manifest.json"));
  if (!manifestKey) throw new AppError(400, "Pack must contain manifest.json");

  const manifestBytes = entries[manifestKey];
  if (!manifestBytes) throw new AppError(400, "Missing manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new AppError(400, "manifest.json is not valid JSON");
  }
  const validated = validateTempoPackManifest(raw);
  if (!validated.ok) throw new AppError(400, validated.message);
  if (validated.value.id.startsWith("builtin:")) {
    throw new AppError(400, "Cannot overwrite builtin packs");
  }

  const dirName = sanitizePackDirName(validated.value.id);
  const projectRoot = path.join(uploadsRoot, "packs", projectId);
  const packDir = safePackPath(projectRoot, dirName);
  if (!packDir) throw new AppError(400, "Invalid pack id path");

  await fs.rm(packDir, { recursive: true, force: true });
  await fs.mkdir(packDir, { recursive: true });

  const zipRoot = manifestKey.includes("/")
    ? manifestKey.replace(/\\/g, "/").slice(0, manifestKey.lastIndexOf("/"))
    : "";

  const MAX_UNCOMPRESSED_TOTAL = 200 * 1024 * 1024;
  const MAX_UNCOMPRESSED_FILE = 50 * 1024 * 1024;
  let totalUncompressed = 0;

  for (const [entryName, data] of Object.entries(entries)) {
    const norm = entryName.replace(/\\/g, "/");
    if (norm.endsWith("/")) continue;
    let rel = norm;
    if (zipRoot && (rel === zipRoot || rel.startsWith(zipRoot + "/"))) {
      rel = rel.slice(zipRoot.length).replace(/^\//, "");
    }
    if (!rel || rel.includes("\0")) continue;
    if (data.byteLength > MAX_UNCOMPRESSED_FILE) {
      throw new AppError(400, `Pack entry too large: ${rel}`);
    }
    totalUncompressed += data.byteLength;
    if (totalUncompressed > MAX_UNCOMPRESSED_TOTAL) {
      throw new AppError(400, "Pack uncompressed size exceeds limit");
    }
    const dest = safePackPath(packDir, rel);
    if (!dest) {
      logger.warn({ entryName }, "Rejected zip-slip pack entry");
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.from(data));
  }

  return { packId: validated.value.id, rootPath: packDir, manifest: validated.value };
}

/** GET /api/projects/:projectId/packs — list builtin + this project's packs */
router.get("/", async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  await assertProjectAccess(projectId, req.user!.userId);
  await ensureProjectPacksLoaded(projectId);
  sendSuccess(res, { packs: listTempoPacks(projectId) });
});

/**
 * POST /api/projects/:projectId/packs
 * - multipart `file`: .zip / .tempo-pack (manifest.json + optional assets/)
 * - JSON body: { manifest } — register manifest-only pack
 */
router.post("/", (req: Request, res: Response, next) => {
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("multipart/form-data")) {
    return uploadPackZip(req, res, (err) => {
      if (err) return next(err);
      void (async () => {
        try {
          const projectId = req.params.projectId as string;
          await assertProjectAccess(projectId, req.user!.userId);
          const file = req.file;
          if (!file?.buffer?.length) throw new AppError(400, "No pack file uploaded");
          const { manifest, rootPath } = await extractPackZip(projectId, file.buffer);
          registerTempoPack({ manifest, rootPath }, projectId);
          logger.info({ projectId, packId: manifest.id }, "Pack zip registered");
          sendSuccess(res, { pack: manifest }, 201);
        } catch (e) {
          next(e);
        }
      })();
    });
  }

  void (async () => {
    try {
      const projectId = req.params.projectId as string;
      await assertProjectAccess(projectId, req.user!.userId);
      const validated = validateTempoPackManifest(req.body?.manifest ?? req.body);
      if (!validated.ok) throw new AppError(400, validated.message);
      if (validated.value.id.startsWith("builtin:")) {
        throw new AppError(400, "Cannot overwrite builtin packs");
      }

      const dirName = sanitizePackDirName(validated.value.id);
      const projectRoot = path.join(uploadsRoot, "packs", projectId);
      const packDir = safePackPath(projectRoot, dirName);
      if (!packDir) throw new AppError(400, "Invalid pack id path");

      await fs.mkdir(packDir, { recursive: true });
      await fs.writeFile(
        path.join(packDir, "manifest.json"),
        JSON.stringify(validated.value, null, 2),
        "utf8"
      );

      registerTempoPack({ manifest: validated.value, rootPath: packDir }, projectId);
      logger.info({ projectId, packId: validated.value.id }, "Pack registered");
      sendSuccess(res, { pack: validated.value }, 201);
    } catch (e) {
      next(e);
    }
  })();
});

export default router;
