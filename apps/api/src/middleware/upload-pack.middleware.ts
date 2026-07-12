import multer from "multer";
import path from "path";
import type { RequestHandler } from "express";
import { AppError } from "./error.middleware.js";

const MAX_PACK_SIZE = 50 * 1024 * 1024; // 50MB

function isAllowedPack(file: Express.Multer.File): boolean {
  const ext = path.extname(file.originalname).toLowerCase();
  return ext === ".zip" || ext === ".tempo-pack";
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PACK_SIZE },
  fileFilter: (_req, file, cb) => {
    if (isAllowedPack(file)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          400,
          `Pack type not supported. Use .zip or .tempo-pack (got ${file.originalname})`
        )
      );
    }
  },
});

export const uploadPackZip: RequestHandler = upload.single("file");
