import { env } from "./env.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const storageConfig = {
  provider: (process.env.STORAGE_PROVIDER || "local") as "local" | "s3",
  local: {
    uploadDir: path.resolve(__dirname, "../../../uploads"),
  },
  s3: {
    bucket: process.env.S3_BUCKET || "",
    region: process.env.S3_REGION || "auto",
    accessKeyId: process.env.S3_ACCESS_KEY || "",
    secretAccessKey: process.env.S3_SECRET_KEY || "",
    endpoint: process.env.S3_ENDPOINT || undefined,
  },
};
