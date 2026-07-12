import { Router, type Request, type Response, type Router as RouterType } from "express";
import { eq, desc } from "drizzle-orm";
import { db, projects } from "@tempo/db";
import { createProjectSchema, updateProjectSchema } from "@tempo/validators";
import { resolveDeliveryProfile } from "@tempo/editor-core";
import { authMiddleware, validate, AppError } from "../middleware/index.js";

const router: RouterType = Router();

// All project routes require authentication
router.use(authMiddleware);

// ─── List Projects ───────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  const userProjects = await db.query.projects.findMany({
    where: eq(projects.userId, req.user!.userId),
    orderBy: desc(projects.updatedAt),
    columns: {
      id: true,
      name: true,
      thumbnailUrl: true,
      duration: true,
      settings: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  res.json({ success: true, data: userProjects });
});

// ─── Create Project ──────────────────────────────────────
router.post(
  "/",
  validate(createProjectSchema),
  async (req: Request, res: Response) => {
    const { name, settings } = req.body;

    const baseSettings = {
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 0,
      backgroundColor: "#000000",
      sampleRate: 44100,
      ...settings,
    };
    const defaultSettings = {
      ...baseSettings,
      deliveryProfile: resolveDeliveryProfile(baseSettings),
    };

    const [project] = await db
      .insert(projects)
      .values({
        userId: req.user!.userId,
        name,
        settings: defaultSettings,
        data: {
          tracks: [],
          audioMixer: {
            masterVolume: 1,
            trackVolumes: {},
            trackPans: {},
            trackMutes: {},
            trackAutomation: {},
            trackRoles: {},
          },
        },
      })
      .returning();

    if (!project) throw new AppError(500, "Failed to create project");

    res.status(201).json({ success: true, data: project });
  }
);

// ─── Get Project ─────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, req.params.id as string),
  });

  if (!project) {
    throw new AppError(404, "Project not found");
  }

  if (project.userId !== req.user!.userId) {
    throw new AppError(403, "Access denied");
  }

  res.json({ success: true, data: project });
});

// ─── Update Project ──────────────────────────────────────
router.patch(
  "/:id",
  validate(updateProjectSchema),
  async (req: Request, res: Response) => {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, req.params.id as string),
    });

    if (!project) throw new AppError(404, "Project not found");
    if (project.userId !== req.user!.userId)
      throw new AppError(403, "Access denied");

    const body = req.body as Record<string, any>;
    const patch: Record<string, any> = { ...body };

    // Merge JSONB data so autosave of tracks/mixer does not wipe aiConversation / aiMessages
    if (body.data && typeof body.data === "object") {
      const existing = (project.data || {}) as Record<string, any>;
      patch.data = { ...existing, ...body.data };
    }

    const [updated] = await db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, req.params.id as string))
      .returning();

    res.json({ success: true, data: updated });
  }
);

// ─── Delete Project ──────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, req.params.id as string),
  });

  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== req.user!.userId)
    throw new AppError(403, "Access denied");

  await db.delete(projects).where(eq(projects.id, req.params.id as string));

  res.json({ success: true, message: "Project deleted" });
});

export default router;
