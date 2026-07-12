import multer from "multer";
import type { RequestHandler } from "express";
import path from "path";
import { AppError } from "./error.middleware.js";

const FONT_MIME_TYPES = new Set([
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/x-font-truetype",
  "application/x-font-opentype",
  "application/octet-stream", // browsers often send this for .ttf/.otf
]);

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".woff", ".woff2"]);

const MAX_FONT_SIZE = 10 * 1024 * 1024; // 10MB

function isAllowedFont(file: Express.Multer.File): boolean {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!FONT_EXTENSIONS.has(ext)) return false;
  // octet-stream only OK with a known extension
  if (file.mimetype === "application/octet-stream") return true;
  return FONT_MIME_TYPES.has(file.mimetype);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FONT_SIZE },
  fileFilter: (_req, file, cb) => {
    if (isAllowedFont(file)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          400,
          `Font type not supported. Use .ttf, .otf, .woff, or .woff2 (got ${file.mimetype} / ${file.originalname})`
        )
      );
    }
  },
});

export const uploadFont: RequestHandler = upload.single("file");

export function detectFontFormat(
  fileName: string
): "truetype" | "opentype" | "woff" | "woff2" {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".woff2") return "woff2";
  if (ext === ".woff") return "woff";
  if (ext === ".otf") return "opentype";
  return "truetype";
}

/** Sanitize a CSS family name from filename or user input */
export function sanitizeFamilyName(raw: string): string {
  const base = raw.replace(/\.[^.]+$/, "").trim();
  const cleaned = base
    .replace(/[^a-zA-Z0-9\s\-_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned || "CustomFont";
}
