import express, { type Express } from "express";
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler, apiLimiter } from "./middleware/index.js";
import { logger } from "./utils/logger.js";
import authRoutes from "./routes/auth.routes.js";
import projectRoutes from "./routes/project.routes.js";
import mediaRoutes from "./routes/media.routes.js";
import fontsRoutes from "./routes/fonts.routes.js";
import lutsRoutes from "./routes/luts.routes.js";
import packsRoutes from "./routes/packs.routes.js";
import renderRoutes from "./routes/render.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import type { TokenPayload } from "@tempo/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();
const httpServer = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const CORS_ORIGINS = Array.from(
  new Set([
    FRONTEND_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ])
);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return CORS_ORIGINS.includes(origin);
}

// ─── Socket.io ───────────────────────────────────────────
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
  },
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token as string | undefined;
  if (!token) return next(new Error("Authentication required"));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    (socket.data as { user: TokenPayload }).user = payload;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

const editorNs = io.of("/editor");
editorNs.on("connection", (socket) => {
  logger.debug({ socketId: socket.id }, "editor socket connected");

  socket.on("join-project", (projectId: string) => {
    socket.join(`project:${projectId}`);
    logger.debug({ socketId: socket.id, projectId }, "joined project room");
  });

  socket.on("leave-project", (projectId: string) => {
    socket.leave(`project:${projectId}`);
  });

  socket.on("disconnect", () => {
    logger.debug({ socketId: socket.id }, "editor socket disconnected");
  });
});

// ─── Middleware ──────────────────────────────────────────
// Allow the Next.js app (different port/origin) to load /uploads images & media
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(
  cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve local uploads
app.use(
  "/uploads",
  express.static(path.resolve(__dirname, "../../uploads"), {
    setHeaders: (res, filePath) => {
      // Render links are downloads, while source media must remain inline for
      // HTMLVideoElement/ImageBitmap preview and headless frame export.
      if (filePath.includes(`${path.sep}renders${path.sep}`)) {
        const fileName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      }
    },
  })
);

app.use("/api", apiLimiter);

app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, "incoming request");
  next();
});

// ─── Health Check ────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    success: true,
    message: "Tempo API is running",
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
  });
});

// ─── Routes ─────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/projects", mediaRoutes);
app.use("/api/projects/:projectId/fonts", fontsRoutes);
app.use("/api/projects/:projectId/luts", lutsRoutes);
app.use("/api/projects/:projectId/packs", packsRoutes);
app.use("/api/projects", renderRoutes);
app.use("/api/projects", aiRoutes);

// ─── Error Handling ─────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start Render Worker ─────────────────────────────────
import { startRenderWorker } from "./workers/render.worker.js";
startRenderWorker();

// ─── Start Server ───────────────────────────────────────
httpServer.listen(env.API_PORT, () => {
  logger.info(
    `Tempo API running on http://localhost:${env.API_PORT} [${env.NODE_ENV}]`
  );
});

export { io, editorNs };
export default app;
