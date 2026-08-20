import { execFile } from "child_process";
import { access } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import type {
  ReferenceAnalysisEvidence,
  ReferenceEvidenceRect,
  ReferenceFrameEvidence,
  ReferenceSceneEvidence,
} from "@tempo/types";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { SceneSegment } from "./scene-detection.service.js";

const exec = promisify(execFile);
const WIDTH = 192;
const HEIGHT = 108;
const DEFAULT_FPS = 12;
const MAX_SECONDS = 180;

export interface OpenCvWorkerOutput {
  provider: "tempo-opencv-paddleocr";
  analysisFps: number;
  width: number;
  height: number;
  frames: ReferenceFrameEvidence[];
  textObservations?: Array<{
    time: number;
    text: string;
    confidence: number;
    rect: ReferenceEvidenceRect;
  }>;
  ocrAvailable?: boolean;
  ocrDevice?: string;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function rectFromBounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  width: number,
  height: number
): ReferenceEvidenceRect {
  return {
    x: minX / width,
    y: minY / height,
    width: (maxX - minX + 1) / width,
    height: (maxY - minY + 1) / height,
  };
}

/**
 * Connected components for a tiny analysis raster. This deliberately lives in
 * TypeScript so reference analysis remains available without Python/OpenCV;
 * production workers may replace it with the compatible OpenCV adapter.
 */
export function connectedForegroundComponents(
  pixels: Uint8Array,
  width: number,
  height: number,
  threshold = 24
): ReferenceEvidenceRect[] {
  const visited = new Uint8Array(pixels.length);
  const components: Array<ReferenceEvidenceRect & { area: number }> = [];
  const queue = new Int32Array(pixels.length);
  const minArea = Math.max(8, Math.round(width * height * 0.0015));

  for (let seed = 0; seed < pixels.length; seed++) {
    if (visited[seed] || pixels[seed]! <= threshold) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const index = queue[head++]!;
      const x = index % width;
      const y = Math.floor(index / width);
      area++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbours = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbours) {
        if (next < 0 || next >= pixels.length || visited[next]) continue;
        const nx = next % width;
        const ny = Math.floor(next / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1 || pixels[next]! <= threshold) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    if (area < minArea) continue;
    components.push({ ...rectFromBounds(minX, minY, maxX, maxY, width, height), area });
  }
  return components
    .sort((a, b) => b.area - a.area)
    .slice(0, 12)
    .map(({ area: _area, ...rect }) => rect);
}

export function frameEvidence(
  pixels: Uint8Array,
  previous: Uint8Array | undefined,
  width: number,
  height: number,
  time: number
): ReferenceFrameEvidence {
  let sum = 0;
  let black = 0;
  let difference = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < pixels.length; index++) {
    const value = pixels[index]!;
    sum += value;
    if (value <= 18) black++;
    if (previous) difference += Math.abs(value - previous[index]!);
    if (value > 24) {
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    time,
    changeScore: previous ? difference / pixels.length / 255 : 0,
    meanLuma: sum / pixels.length / 255,
    blackRatio: black / pixels.length,
    ...(maxX >= minX ? { foreground: rectFromBounds(minX, minY, maxX, maxY, width, height) } : {}),
    components: connectedForegroundComponents(pixels, width, height),
  };
}

export function selectVisualEventTimes(frames: readonly ReferenceFrameEvidence[], fps: number): number[] {
  if (frames.length < 3) return [];
  const scores = frames.slice(1).map((frame) => frame.changeScore);
  const baseline = median(scores);
  const deviations = scores.map((score) => Math.abs(score - baseline));
  const threshold = Math.max(0.012, baseline + Math.max(0.006, median(deviations) * 3));
  const minGap = Math.max(1, Math.round(fps * 0.08));
  const peaks: number[] = [];
  let last = -minGap;
  for (let index = 1; index < frames.length - 1; index++) {
    const score = frames[index]!.changeScore;
    if (
      score >= threshold &&
      score >= frames[index - 1]!.changeScore &&
      score >= frames[index + 1]!.changeScore &&
      index - last >= minGap
    ) {
      peaks.push(frames[index]!.time);
      last = index;
    }
  }
  return peaks;
}

function assembleEvidence(
  frames: ReferenceFrameEvidence[],
  scenes: SceneSegment[],
  analysisFps: number,
  width: number,
  height: number,
  provider: ReferenceAnalysisEvidence["provider"],
  textObservations: NonNullable<ReferenceSceneEvidence["textObservations"]> = [],
  warnings: string[] = []
): ReferenceAnalysisEvidence {
  const sceneEvidence = scenes.map((scene) => {
    const endTime = scene.startTime + scene.duration;
    const selected = frames.filter((frame) => frame.time >= scene.startTime && frame.time < endTime);
    const selectedText = textObservations.filter((item) => item.time >= scene.startTime && item.time < endTime);
    return {
      sceneIndex: scene.index,
      startTime: scene.startTime,
      endTime,
      frames: selected,
      eventTimes: selectVisualEventTimes(selected, analysisFps),
      // Ignore glyph-sized components. Large disconnected regions are useful
      // panel evidence; individual letters are handled by the OCR adapter.
      maxVisibleComponents: selected.reduce((max, frame) => Math.max(
        max,
        frame.components.filter((rect) => rect.width * rect.height >= 0.06).length
      ), 0),
      ...(selectedText.length ? { textObservations: selectedText } : {}),
    };
  });
  return {
    schemaVersion: 1,
    provider,
    analysisFps,
    width,
    height,
    scenes: sceneEvidence,
    ...(warnings.length ? { warnings } : {}),
  };
}

function isWorkerOutput(value: unknown): value is OpenCvWorkerOutput {
  if (!value || typeof value !== "object") return false;
  const output = value as Partial<OpenCvWorkerOutput>;
  return output.provider === "tempo-opencv-paddleocr" &&
    Number.isFinite(output.analysisFps) &&
    Number.isFinite(output.width) &&
    Number.isFinite(output.height) &&
    Array.isArray(output.frames);
}

/**
 * Parse the worker protocol defensively. The worker now isolates native
 * library logs at the file-descriptor level, but accepting a final valid JSON
 * line keeps future Paddle/OpenCV logging regressions from aborting a run.
 */
export function parseOpenCvWorkerOutput(stdout: string): OpenCvWorkerOutput {
  const trimmed = stdout.trim();
  const candidates = [trimmed];
  const marker = '{"provider":"tempo-opencv-paddleocr"';
  const markerIndex = trimmed.lastIndexOf(marker);
  if (markerIndex > 0) candidates.push(trimmed.slice(markerIndex));
  const lastLine = trimmed.split(/\r?\n/).reverse().find((line: string) => line.trim().startsWith("{"));
  if (lastLine && lastLine !== trimmed) candidates.push(lastLine.trim());

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isWorkerOutput(parsed)) return parsed;
    } catch {
      // Try the next bounded candidate before reporting a protocol failure.
    }
  }
  const preview = trimmed.replace(/\s+/g, " ").slice(0, 160);
  throw new Error(`OpenCV worker returned invalid JSON${preview ? `: ${preview}` : ""}`);
}

async function analyzeWithOpenCv(
  videoPath: string,
  scenes: SceneSegment[],
  duration: number,
  analysisFps: number,
  signal?: AbortSignal
): Promise<ReferenceAnalysisEvidence> {
  const candidates = [
    path.resolve(process.cwd(), "scripts/reference_cv_worker.py"),
    path.resolve(process.cwd(), "apps/api/scripts/reference_cv_worker.py"),
    fileURLToPath(new URL("../../../scripts/reference_cv_worker.py", import.meta.url)),
  ];
  let workerPath: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      workerPath = candidate;
      break;
    } catch {
      // Try the next development/bundle working-directory layout.
    }
  }
  if (!workerPath) throw new Error("reference_cv_worker.py was not found");
  const args = [
    workerPath,
    videoPath,
    "--fps", String(analysisFps),
    "--duration", String(Math.min(Math.max(0.1, duration), MAX_SECONDS)),
    "--device", env.REFERENCE_CV_DEVICE,
    ...(env.REFERENCE_CV_OCR ? ["--ocr"] : []),
  ];
  const { stdout } = await exec(env.REFERENCE_CV_PYTHON, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    signal,
    env: {
      ...process.env,
      // Keep PaddleX model downloads beside the optional worker. This avoids
      // permission failures when the API runs under a service account.
      PADDLE_PDX_CACHE_HOME: path.resolve(process.cwd(), "apps/api/scripts/reference-cv/.cache"),
    },
  });
  const parsed = parseOpenCvWorkerOutput(stdout);
  const warnings: string[] = [];
  if (duration > MAX_SECONDS) {
    warnings.push(`Local visual evidence was capped at ${MAX_SECONDS}s; later scenes use model evidence only`);
  }
  if (env.REFERENCE_CV_OCR && !parsed.ocrAvailable) {
    warnings.push("PaddleOCR was requested but unavailable; geometry and optical flow were still measured");
  }
  return assembleEvidence(
    parsed.frames,
    scenes,
    parsed.analysisFps,
    parsed.width,
    parsed.height,
    parsed.provider,
    parsed.textObservations || [],
    warnings
  );
}

/** Decode a low-resolution native video stream and derive local, auditable evidence. */
export async function analyzeLocalVisualEvidence(
  videoPath: string,
  scenes: SceneSegment[],
  duration: number,
  options: { signal?: AbortSignal; fps?: number } = {}
): Promise<ReferenceAnalysisEvidence> {
  const analysisFps = Math.max(6, Math.min(20, Math.round(options.fps || DEFAULT_FPS)));
  const analysedDuration = Math.min(Math.max(0.1, duration), MAX_SECONDS);
  let acceleratorWarning: string | undefined;
  if (env.REFERENCE_CV_MODE !== "builtin") {
    try {
      const accelerated = await analyzeWithOpenCv(videoPath, scenes, duration, analysisFps, options.signal);
      logger.info({
        analysisFps: accelerated.analysisFps,
        frameCount: accelerated.scenes.reduce((count, scene) => count + scene.frames.length, 0),
        sceneCount: scenes.length,
        ocr: accelerated.scenes.some((scene) => Boolean(scene.textObservations?.length)),
      }, "OpenCV reference visual evidence complete");
      return accelerated;
    } catch (error: any) {
      if (options.signal?.aborted) throw error;
      const detail = String(error?.stderr || error?.message || "worker unavailable").trim().slice(0, 300);
      if (env.REFERENCE_CV_MODE === "opencv") {
        throw new Error(`REFERENCE_CV_MODE=opencv but the local worker failed: ${detail}`);
      }
      acceleratorWarning = "OpenCV/PaddleOCR accelerator unavailable; used the built-in local evidence extractor";
      logger.debug({ err: detail }, acceleratorWarning);
    }
  }
  const { stdout } = await exec("ffmpeg", [
    "-v", "error",
    "-t", String(analysedDuration),
    "-i", videoPath,
    "-an",
    "-vf", `fps=${analysisFps},scale=${WIDTH}:${HEIGHT}:flags=area`,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, signal: options.signal });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const frameSize = WIDTH * HEIGHT;
  const frameCount = Math.floor(bytes.length / frameSize);
  const frames: ReferenceFrameEvidence[] = [];
  let previous: Uint8Array | undefined;
  for (let index = 0; index < frameCount; index++) {
    const pixels = new Uint8Array(bytes.buffer, bytes.byteOffset + index * frameSize, frameSize);
    frames.push(frameEvidence(pixels, previous, WIDTH, HEIGHT, index / analysisFps));
    previous = new Uint8Array(pixels);
  }
  const warnings = [
    ...(acceleratorWarning ? [acceleratorWarning] : []),
    ...(duration > MAX_SECONDS
      ? [`Local visual evidence was capped at ${MAX_SECONDS}s; later scenes use model evidence only`]
      : []),
  ];
  logger.info({ analysisFps, frameCount, sceneCount: scenes.length }, "Local reference visual evidence complete");
  return assembleEvidence(frames, scenes, analysisFps, WIDTH, HEIGHT, "tempo-local-cv", [], warnings);
}
