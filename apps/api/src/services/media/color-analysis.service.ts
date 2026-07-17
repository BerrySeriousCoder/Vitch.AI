import { spawn } from "child_process";
import type { ColorStatistics } from "@tempo/types";

const SAMPLE_SIZE = 64;

function decodeRgbFrame(inputPath: string, time: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v", "error",
      "-ss", String(Math.max(0, time)),
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", `scale=${SAMPLE_SIZE}:${SAMPLE_SIZE}:flags=area`,
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `ffmpeg color decode exited ${code}`));
    });
  });
}

/** Build normalized color statistics from FFmpeg rgb24 frame bytes. */
export function colorStatisticsFromRgbBytes(bytes: Uint8Array): ColorStatistics | null {
  const pixelCount = Math.floor(bytes.length / 3);
  if (pixelCount === 0) return null;
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let saturationSum = 0;
  const lumas: number[] = [];
  for (let index = 0; index < pixelCount; index++) {
    const red = bytes[index * 3]! / 255;
    const green = bytes[index * 3 + 1]! / 255;
    const blue = bytes[index * 3 + 2]! / 255;
    redSum += red;
    greenSum += green;
    blueSum += blue;
    saturationSum += Math.max(red, green, blue) - Math.min(red, green, blue);
    lumas.push(red * 0.2126 + green * 0.7152 + blue * 0.0722);
  }
  const meanLuma = lumas.reduce((sum, value) => sum + value, 0) / pixelCount;
  const sorted = [...lumas].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)]!;
  return {
    meanRed: redSum / pixelCount,
    meanGreen: greenSum / pixelCount,
    meanBlue: blueSum / pixelCount,
    meanLuma,
    lumaStdDev: Math.sqrt(lumas.reduce((sum, value) => sum + (value - meanLuma) ** 2, 0) / pixelCount),
    meanSaturation: saturationSum / pixelCount,
    blackPoint: percentile(0.05),
    whitePoint: percentile(0.95),
    sampleCount: pixelCount,
    sampledAt: new Date().toISOString(),
    source: "ffmpeg",
  };
}

/** Decode up to four representative frames and aggregate a stable media profile. */
export async function analyzeColorStatistics(
  inputPath: string,
  duration?: number | null
): Promise<ColorStatistics | null> {
  const safeDuration = Number(duration) || 0;
  const times = safeDuration > 0
    ? [0.1, 0.35, 0.6, 0.85].map((fraction) => safeDuration * fraction)
    : [0];
  const frames = await Promise.all(times.map((time) => decodeRgbFrame(inputPath, time).catch(() => null)));
  const bytes = frames.filter((frame): frame is Buffer => frame !== null);
  if (bytes.length === 0) return null;
  return colorStatisticsFromRgbBytes(Buffer.concat(bytes));
}
