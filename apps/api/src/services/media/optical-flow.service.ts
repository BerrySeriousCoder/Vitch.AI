import { execFile } from "child_process";
import { promisify } from "util";
import { estimateTranslationalFlow } from "@tempo/editor-core";
import type { Clip, MotionTrackSample } from "@tempo/types";
import { resolveLocalMediaPath } from "./audio-understanding.service.js";

const exec = promisify(execFile);
const ANALYSIS_WIDTH = 160;
const ANALYSIS_HEIGHT = 90;
const DEFAULT_FPS = 6;
const MAX_ANALYSIS_SECONDS = 45;

export interface OpticalFlowTrackResult {
  samples: MotionTrackSample[];
  analysisFps: number;
  analysedDuration: number;
}

/**
 * Derives an editable camera/controller trajectory from local footage without
 * a cloud model. It intentionally estimates global translation, which is
 * reliable for camera moves and parallax-free shots; use the Gemini subject
 * tracker when a particular person/object must be followed.
 */
export async function trackGlobalMotionInClip(input: {
  assetUrl: string;
  sourceClip: Clip;
  sampleFps?: number;
  searchRadius?: number;
}): Promise<OpticalFlowTrackResult> {
  if (input.sourceClip.reversed || input.sourceClip.speedRamp?.length) {
    throw new Error("Optical-flow tracking currently requires a forward constant-speed source clip");
  }
  const sourcePath = resolveLocalMediaPath(input.assetUrl);
  if (!sourcePath) throw new Error("Optical-flow tracking currently requires local media storage");
  const speed = Math.max(0.01, Math.abs(input.sourceClip.speed || 1));
  const clipDuration = Math.min(Math.max(0.1, input.sourceClip.duration), MAX_ANALYSIS_SECONDS);
  const sourceDuration = clipDuration * speed;
  const analysisFps = Math.max(2, Math.min(12, Math.round(Number(input.sampleFps) || DEFAULT_FPS)));
  const { stdout } = await exec("ffmpeg", [
    "-v", "error",
    "-ss", String(Math.max(0, input.sourceClip.sourceOffset)),
    "-t", String(sourceDuration),
    "-i", sourcePath,
    "-an",
    "-vf", `fps=${analysisFps},scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT}:flags=area`,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 96 * 1024 * 1024 });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const frameSize = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
  const frameCount = Math.floor(bytes.length / frameSize);
  if (frameCount < 2) throw new Error("Could not decode enough video frames for optical-flow tracking");

  const samples: MotionTrackSample[] = [{ time: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, confidence: 1 }];
  let x = 0.5;
  let y = 0.5;
  for (let index = 1; index < frameCount; index++) {
    const before = new Uint8Array(bytes.buffer, bytes.byteOffset + (index - 1) * frameSize, frameSize);
    const after = new Uint8Array(bytes.buffer, bytes.byteOffset + index * frameSize, frameSize);
    const flow = estimateTranslationalFlow(before, after, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, input.searchRadius ?? 8);
    x = Math.max(0, Math.min(1, x + flow.dx / ANALYSIS_WIDTH));
    y = Math.max(0, Math.min(1, y + flow.dy / ANALYSIS_HEIGHT));
    samples.push({
      time: Math.min(clipDuration, index / analysisFps / speed),
      x,
      y,
      scale: 1,
      rotation: 0,
      confidence: flow.confidence,
    });
  }
  return { samples, analysisFps, analysedDuration: clipDuration };
}
