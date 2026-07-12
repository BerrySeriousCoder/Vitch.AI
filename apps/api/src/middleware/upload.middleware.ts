import multer from "multer";
import type { RequestHandler } from "express";
import { AppError } from "./error.middleware.js";

const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/x-matroska",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, `File type ${file.mimetype} is not supported`));
    }
  },
});

export const uploadSingle: RequestHandler = upload.single("file");
export const uploadMultiple: RequestHandler = upload.array("files", 10);
