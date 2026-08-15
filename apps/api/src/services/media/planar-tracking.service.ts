import { execFile } from "child_process";
import { promisify } from "util";
import { estimateFeatureTranslation, normalizePlanarTrackSamples } from "@tempo/editor-core";
import type { Clip, PlanarTrackPoint, PlanarTrackSample } from "@tempo/types";
import { resolveLocalMediaPath } from "./audio-understanding.service.js";

const exec = promisify(execFile);
const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 180;
const DEFAULT_FPS = 6;
const MAX_ANALYSIS_SECONDS = 45;

export interface PlanarTrackingResult {
  samples: PlanarTrackSample[];
  analysisFps: number;
  analysedDuration: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Tracks four independently textured points over a local video. The resulting
 * convex quad is deliberately stored as editable project data: a user/agent
 * can repair an occluded frame instead of rerunning an opaque model.
 */
export async function trackPlanarSurfaceInClip(input: {
  assetUrl: string;
  sourceClip: Clip;
  corners: [PlanarTrackPoint, PlanarTrackPoint, PlanarTrackPoint, PlanarTrackPoint];
  sampleFps?: number;
  searchRadius?: number;
  patchRadius?: number;
}): Promise<PlanarTrackingResult> {
  if (input.sourceClip.reversed || input.sourceClip.speedRamp?.length) {
    throw new Error("Planar tracking currently requires a forward constant-speed source clip");
  }
  const sourcePath = resolveLocalMediaPath(input.assetUrl);
  if (!sourcePath) throw new Error("Planar tracking currently requires local media storage");
  const speed = Math.max(0.01, Math.abs(input.sourceClip.speed || 1));
  const clipDuration = Math.min(Math.max(0.1, input.sourceClip.duration), MAX_ANALYSIS_SECONDS);
  const analysisFps = clamp(Math.round(Number(input.sampleFps) || DEFAULT_FPS), 2, 12);
  const searchRadius = clamp(Math.round(Number(input.searchRadius) || 8), 2, 16);
  const patchRadius = clamp(Math.round(Number(input.patchRadius) || 7), 3, 12);
  const { stdout } = await exec("ffmpeg", [
    "-v", "error", "-ss", String(Math.max(0, input.sourceClip.sourceOffset)),
    "-t", String(clipDuration * speed), "-i", sourcePath, "-an",
    "-vf", `fps=${analysisFps},scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT}:flags=area`,
    "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 192 * 1024 * 1024 });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const frameSize = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
  const frameCount = Math.floor(bytes.length / frameSize);
  if (frameCount < 2) throw new Error("Could not decode enough video frames for planar tracking");

  let corners = input.corners.map((corner) => ({ x: clamp(corner.x, 0, 1), y: clamp(corner.y, 0, 1) })) as PlanarTrackSample["corners"];
  const samples: PlanarTrackSample[] = [{ time: 0, corners, confidence: 1 }];
  for (let index = 1; index < frameCount; index++) {
    const before = new Uint8Array(bytes.buffer, bytes.byteOffset + (index - 1) * frameSize, frameSize);
    const after = new Uint8Array(bytes.buffer, bytes.byteOffset + index * frameSize, frameSize);
    const tracked = corners.map((corner) => estimateFeatureTranslation(
      before, after, ANALYSIS_WIDTH, ANALYSIS_HEIGHT,
      corner.x * (ANALYSIS_WIDTH - 1), corner.y * (ANALYSIS_HEIGHT - 1), patchRadius, searchRadius
    ));
    const proposed = corners.map((corner, cornerIndex) => ({
      x: clamp(corner.x + tracked[cornerIndex]!.dx / ANALYSIS_WIDTH, 0, 1),
      y: clamp(corner.y + tracked[cornerIndex]!.dy / ANALYSIS_HEIGHT, 0, 1),
    })) as PlanarTrackSample["corners"];
    // Keep an invalid/occluded frame editable but do not let it turn a planar
    // pin inside-out. Holding the last valid quad is safer than a flipped ad.
    const normalized = normalizePlanarTrackSamples([{ time: index, corners: proposed }]);
    if (normalized.length) corners = proposed;
    samples.push({
      time: Math.min(clipDuration, index / analysisFps / speed),
      corners,
      confidence: tracked.reduce((total, flow) => total + flow.confidence, 0) / tracked.length,
    });
  }
  return { samples: normalizePlanarTrackSamples(samples), analysisFps, analysedDuration: clipDuration };
}
