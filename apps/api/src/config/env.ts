import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: "../../.env" });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  API_PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required"),
  GEMINI_API_KEY: z.string().optional(),
  /** Web Fonts Developer API key; GEMINI_API_KEY is used as a fallback. */
  GOOGLE_FONTS_API_KEY: z.string().optional(),
  REPLICATE_API_TOKEN: z.string().optional(),
  API_PUBLIC_URL: z.string().url().optional(),
  /** Server-to-server API origin for headless render/critique browsers. */
  API_INTERNAL_URL: z.string().url().optional(),
  /** Cheap Flash model for media metadata classification (not Pro) */
  GEMINI_METADATA_MODEL: z.string().optional().default("gemini-3.1-flash-lite"),
  /** Fast text-only model for the optional asset-to-segment refinement pass. */
  GEMINI_MATCHING_MODEL: z.string().optional().default("gemini-3.1-flash-lite"),
  /** Whole-video Edit Like This and forensic comparison model. */
  GEMINI_REFERENCE_MODEL: z.string().optional().default("gemini-3.1-pro-preview"),
  /** Dedicated complete-video temporal analysis model. */
  GEMINI_VIDEO_ANALYSIS_MODEL: z.string().optional().default("gemini-3.7-flash"),
  /** @deprecated ASR moved to OpenAI; kept for backwards-compatible .env files */
  GEMINI_ASR_MODEL: z.string().optional(),
  /** OpenAI key for timed transcription */
  OPENAI_API_KEY: z.string().optional(),
  /** Timed captions require whisper-1 verbose_json word + segment timestamps. */
  OPENAI_ASR_MODEL: z.literal("whisper-1").optional().default("whisper-1"),
  REDIS_URL: z.string().optional().default("redis://localhost:6379"),
  /** Optional Netscape cookies file used by yt-dlp for authorized/private platform access. */
  YTDLP_COOKIES_FILE: z.string().min(1).optional(),
  /** Override the yt-dlp executable when it is not available on PATH. */
  YTDLP_PATH: z.string().min(1).optional(),
  /** Browser-like user agent for platform extractors; yt-dlp default is used when omitted. */
  YTDLP_USER_AGENT: z.string().min(1).optional(),
  /** Optional Chrome/Chromium binary used by WebGPU frame export and critique. */
  CHROME_EXECUTABLE_PATH: z.string().min(1).optional(),
  /** Hardware rejects SwiftShader; auto permits an explicit software fallback. */
  OFFLINE_WEBGPU_MODE: z.enum(["auto", "hardware"]).optional().default("hardware"),
  /** GPU-enabled headed Chrome endpoint created by `pnpm browser:gpu`. */
  CHROME_CDP_URL: z.string().url().optional().default("http://127.0.0.1:9222"),
  /** Optional local reference-video accelerator; auto falls back to the built-in decoder. */
  REFERENCE_CV_MODE: z.enum(["auto", "builtin", "opencv"]).optional().default("auto"),
  /** Enable PaddleOCR in the isolated CV worker when installed. */
  REFERENCE_CV_OCR: z.enum(["true", "false"]).optional().default("false").transform((value) => value === "true"),
  /** Python executable for the optional isolated CV worker (venv recommended). */
  REFERENCE_CV_PYTHON: z.string().min(1).optional().default("python3"),
  /** PaddleOCR execution device. `auto` uses GPU only when the wheel/driver support it. */
  REFERENCE_CV_DEVICE: z.enum(["auto", "cpu", "gpu"]).optional().default("auto"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Keep every expensive/creative Gemini path on one explicit model by default.
 * The legacy reference-only override remains supported for existing installs.
 */
