import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import type { Clip, MediaAsset, MotionTrackSample } from "@tempo/types";
import { env } from "../../config/env.js";
import { extractAnalysisFrame } from "../../utils/ffmpeg.js";
import { resolveLocalMediaPath } from "./audio-understanding.service.js";

function stripJsonFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return match ? match[1]!.trim() : text.trim();
}

function sampleTimes(duration: number, count: number): number[] {
  const n = Math.max(2, Math.min(12, Math.round(count)));
  if (duration <= 0.05) return [0, 0.05];
  return Array.from({ length: n }, (_, index) => (duration * index) / (n - 1));
}

/**
 * Uses the configured Gemini vision model to find a named subject in sampled
 * source frames. This is AI-assisted 2D tracking, deliberately stored as
 * editable sparse samples rather than misrepresenting it as optical flow.
 */
export async function trackSubjectInClip(input: {
  asset: MediaAsset;
  sourceClip: Clip;
  subject: string;
  sampleCount?: number;
}): Promise<{ samples: MotionTrackSample[]; model: string }> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for AI motion tracking");
  if (input.asset.type !== "video" && input.asset.type !== "image") {
    throw new Error("AI motion tracking requires a video or image source");
  }
  if (input.sourceClip.reversed || input.sourceClip.speedRamp?.length) {
    throw new Error("AI motion tracking currently requires a forward constant-speed source clip");
  }
  const sourcePath = resolveLocalMediaPath(input.asset.url);
  if (!sourcePath) throw new Error("AI motion tracking currently requires local media storage");
  const duration = Math.max(0.05, input.sourceClip.duration);
  const times = input.asset.type === "image" ? [0, duration] : sampleTimes(duration, input.sampleCount ?? 6);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "tempo-motion-track-"));
  try {
    const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
    for (let index = 0; index < times.length; index++) {
      const localTime = times[index]!;
      const sourceTime = input.sourceClip.sourceOffset + localTime * Math.abs(input.sourceClip.speed || 1);
      const framePath = path.join(workDir, `frame-${index}.jpg`);
      if (input.asset.type === "video") {
        const ok = await extractAnalysisFrame(sourcePath, framePath, sourceTime);
        if (!ok) continue;
      } else {
        // Images are static; read the original file twice to make a valid two-sample track.
        parts.push({ text: `Frame ${parts.length / 2} is at local time ${localTime.toFixed(3)} seconds.` });
        const ext = path.extname(sourcePath).toLowerCase();
        const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        parts.push({ inlineData: { mimeType, data: (await readFile(sourcePath)).toString("base64") } });
        continue;
      }
      parts.push({ text: `Frame ${index} is at local time ${localTime.toFixed(3)} seconds.` });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: (await readFile(framePath)).toString("base64") } });
    }
    if (parts.length < 4) throw new Error("Could not decode enough video frames for tracking");
    const model = env.GEMINI_METADATA_MODEL || "gemini-3.1-flash-lite";
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const prompt = `You are a precise 2D motion-tracking assistant. The image frames below are chronological and each is preceded by its local timestamp. Track the same visible subject described as: "${input.subject}".
Return ONLY JSON: {"samples":[{"time":number,"x":number,"y":number,"scale":number,"rotation":number,"confidence":number}]}.
x/y must be the subject anchor (normally face/object center) normalized 0..1. scale is relative to the first visible frame (1 initially). rotation is in degrees. Return one sample for every supplied frame; if uncertain, retain the best estimated position and lower confidence. Do not include markdown.`;
    const result = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [...parts, { text: prompt }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    let parsed: { samples?: MotionTrackSample[] };
    try {
      parsed = JSON.parse(stripJsonFence(result.text || ""));
    } catch {
      throw new Error("Motion-tracking model returned invalid JSON");
    }
    const raw = Array.isArray(parsed.samples) ? parsed.samples : [];
    const valid = raw.filter((sample) =>
      Number.isFinite(Number(sample?.time)) && Number.isFinite(Number(sample?.x)) && Number.isFinite(Number(sample?.y))
    );
    if (valid.length < 2) throw new Error("Motion-tracking model did not return enough usable samples");
    return { samples: valid, model };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
