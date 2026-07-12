import multer from "multer";
import type { RequestHandler } from "express";
import path from "path";
import { AppError } from "./error.middleware.js";

const MAX_LUT_SIZE = 10 * 1024 * 1024; // 10MB

function isAllowedCube(file: Express.Multer.File): boolean {
  const ext = path.extname(file.originalname).toLowerCase();
  return ext === ".cube";
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LUT_SIZE },
  fileFilter: (_req, file, cb) => {
    if (isAllowedCube(file)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          400,
          `LUT type not supported. Use .cube (got ${file.mimetype} / ${file.originalname})`
        )
      );
    }
  },
});

export const uploadLut: RequestHandler = upload.single("file");

export function sanitizeLutName(raw: string): string {
  const base = raw.replace(/\.[^.]+$/, "").trim();
  const cleaned = base
    .replace(/[^a-zA-Z0-9\s\-_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned || "Custom LUT";
}
