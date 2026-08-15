import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import { mkdir, rm } from "fs/promises";
import { randomUUID } from "crypto";
import { extractAudio, probe } from "../../utils/ffmpeg.js";
import { logger } from "../../utils/logger.js";
import { env } from "../../config/env.js";

const exec = promisify(execFile);

export interface DownloadResult {
  workDir: string;
  videoPath: string;
  audioPath: string;
  audioAvailable: boolean;
  framePaths: string[];
  metadata: {
    duration: number;
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    fps?: number;
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Reference analysis cancelled", "AbortError");
}

export async function downloadReference(url: string, signal?: AbortSignal): Promise<DownloadResult> {
  const workDir = path.join(os.tmpdir(), `tempo-ref-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  const videoPath = path.join(workDir, "reference.mp4");
  const audioPath = path.join(workDir, "reference.wav");

  logger.info({ url, workDir }, "Downloading reference video via yt-dlp");

  try {
    throwIfAborted(signal);
    const args = [
      "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
      "--merge-output-format", "mp4",
      "-o", videoPath,
      "--no-playlist",
      "--max-filesize", "500M",
      "--no-warnings",
      ...(env.YTDLP_COOKIES_FILE ? ["--cookies", env.YTDLP_COOKIES_FILE] : []),
      ...(env.YTDLP_USER_AGENT ? ["--user-agent", env.YTDLP_USER_AGENT] : []),
      url,
    ];
    await exec(env.YTDLP_PATH || "yt-dlp", args, {
      timeout: 120_000,
      signal,
      maxBuffer: 2 * 1024 * 1024,
    });
    throwIfAborted(signal);

    const metadata = await probe(videoPath);
    throwIfAborted(signal);
    const audioAvailable = metadata.hasAudio
      ? await extractAudio(videoPath, audioPath)
      : false;
    throwIfAborted(signal);

    logger.info({ duration: metadata.duration }, "Reference download complete");

    return {
      workDir,
      videoPath,
      audioPath,
      audioAvailable,
      // Scene detection owns the representative-frame extraction. Keeping a
      // second 0.5s frame set here doubled FFmpeg work and was never consumed.
      framePaths: [],
      metadata: {
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        displayWidth: metadata.displayWidth,
        displayHeight: metadata.displayHeight,
        fps: metadata.fps,
      },
    };
  } catch (err: any) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    if (err?.name === "AbortError" || signal?.aborted) throw err;
    logger.error({ err: err.message }, "Reference download/ingest failed");
    if (err?.code === "ENOENT") {
      throw new Error(
        "Reference downloader is unavailable. Install yt-dlp on the API host or configure YTDLP_PATH."
      );
    }
    const raw = String(err?.stderr || err?.message || "Unknown downloader error");
    const needsAuth = /login|cookie|private|sign in|age.restrict/i.test(raw);
    throw new Error(
      needsAuth
        ? "The platform requires an authorized session for this video. Configure YTDLP_COOKIES_FILE with an account that can access it, or use a public URL."
        : `Failed to download or ingest reference video: ${raw.slice(0, 500)}`
    );
  }
}
