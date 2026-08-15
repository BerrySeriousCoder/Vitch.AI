import express, { type Express } from "express";
import { errorHandler } from "../../src/middleware/index.js";
import authRoutes from "../../src/routes/auth.routes.js";
import projectRoutes from "../../src/routes/project.routes.js";
import mediaRoutes from "../../src/routes/media.routes.js";
import fontsRoutes from "../../src/routes/fonts.routes.js";
import lutsRoutes from "../../src/routes/luts.routes.js";

/**
 * Minimal Express app for integration tests (no Socket.io / workers / listen).
 */
export function createTestApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/projects", mediaRoutes);
  app.use("/api/projects/:projectId/fonts", fontsRoutes);
  app.use("/api/projects/:projectId/luts", lutsRoutes);
  app.use(errorHandler);
  return app;
}
