import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { generateThumbnail } from "../../utils/ffmpeg.js";
import { logger } from "../../utils/logger.js";

const exec = promisify(execFile);

export interface SceneSegment {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  /** Midpoint representative (backward compatible) */
  thumbnailPath: string;
  /** Start / mid / end frames for multi-frame vision */
  framePaths: string[];
}

/**
 * Detect scene changes via FFmpeg's scene filter.
 * Extracts start, mid, and end frames per scene for richer vision analysis.
 */
export async function detectScenes(
  videoPath: string,
  framesDir: string,
  totalDuration: number,
  threshold = 0.3,
  signal?: AbortSignal
): Promise<SceneSegment[]> {
  logger.info({ videoPath, threshold }, "Detecting scenes");
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error("Reference duration is unavailable; scene timing cannot be compiled safely");
  }

  let cutTimestamps: number[] = [0];

  try {
    let stderrText = "";
    try {
      const { stderr } = await exec(
        "ffmpeg",
        [
          "-i",
          videoPath,
          "-vf",
          `select='gt(scene,${threshold})',showinfo`,
          "-vsync",
          "vfr",
          "-f",
          "null",
          "-",
        ],
        { maxBuffer: 50 * 1024 * 1024, signal }
      );
      stderrText = typeof stderr === "string" ? stderr : String(stderr ?? "");
    } catch (err: any) {
      // ffmpeg sometimes exits non-zero even after writing useful showinfo lines
      stderrText =
        typeof err.stderr === "string"
          ? err.stderr
          : err.stderr != null
            ? String(err.stderr)
            : "";
      if (!stderrText.includes("pts_time:")) {
        throw err;
      }
      logger.warn(
        { err: err.message },
        "Scene detection ffmpeg non-zero exit; using stderr pts_time anyway"
      );
    }

    const lines = stderrText.split("\n");
    for (const line of lines) {
      const match = line.match(/pts_time:(\d+\.?\d*)/);
      if (match) {
        const time = parseFloat(match[1]!);
        if (time > 0 && time < totalDuration) {
          cutTimestamps.push(time);
        }
      }
    }
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Scene detection via FFmpeg failed, falling back to uniform splits"
    );
    const segmentDuration = Math.min(3, totalDuration / 5);
    cutTimestamps = [];
    for (let t = 0; t < totalDuration; t += segmentDuration) {
      cutTimestamps.push(t);
    }
  }

  cutTimestamps.sort((a, b) => a - b);
  cutTimestamps = [...new Set(cutTimestamps.map((t) => Math.round(t * 100) / 100))];

  const segments: SceneSegment[] = [];

  for (let i = 0; i < cutTimestamps.length; i++) {
    if (signal?.aborted) throw new DOMException("Scene analysis cancelled", "AbortError");
    const startTime = cutTimestamps[i]!;
    const endTime =
      i + 1 < cutTimestamps.length ? cutTimestamps[i + 1]! : totalDuration;
    const duration = endTime - startTime;

    if (duration < 0.2) continue;

    const idx = segments.length;
    const pad = String(idx).padStart(4, "0");
    const mid = startTime + duration / 2;
    const sampleTimes =
      duration < 0.8
        ? [mid]
        : [
            startTime + Math.min(0.15, duration * 0.1),
            mid,
            Math.max(mid, endTime - Math.min(0.15, duration * 0.1)),
          ];

    const framePaths: string[] = [];
    for (let f = 0; f < sampleTimes.length; f++) {
      const framePath = path.join(framesDir, `scene_${pad}_f${f}.jpg`);
      const ok = await generateThumbnail(videoPath, framePath, sampleTimes[f]!);
      if (ok) framePaths.push(framePath);
    }

    if (framePaths.length === 0) continue;

    const thumbnailPath = framePaths[Math.floor(framePaths.length / 2)]!;

    segments.push({
      index: idx,
      startTime,
      endTime,
      duration,
      thumbnailPath,
      framePaths,
    });
  }

  logger.info({ sceneCount: segments.length }, "Scene detection complete");
  return segments;
}
