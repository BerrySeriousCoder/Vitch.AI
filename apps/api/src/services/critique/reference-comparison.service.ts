import { execFile } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { GoogleGenAI, MediaResolution } from "@google/genai";
import { env } from "../../config/env.js";
import type { CritiqueFrame } from "./critique-frames.service.js";

const exec = promisify(execFile);

export type ReferenceComparisonVerdict = "match" | "close" | "mismatch";

export interface ReferenceEditDifference {
  category: "timing" | "composition" | "typography" | "motion" | "transition" | "color" | "content" | "audio-sync" | "other";
  severity: "info" | "warn" | "error";
  referenceTime?: number;
  editTime?: number;
  reference: string;
  currentEdit: string;
  repair: string;
  clipIds: string[];
  toolHints: Array<{ tool: string; arguments: Record<string, unknown> }>;
}

export interface ReferenceEditComparison {
  verdict: ReferenceComparisonVerdict;
  matchScore: number;
  confidence: number;
  summary: string;
  differences: ReferenceEditDifference[];
  matchedDetails: string[];
  repairOrder: string[];
  recheckTimes: number[];
  model: string;
  referenceRange: [number, number];
  editRange: [number, number];
  sampledPairs: Array<{ referenceTime: number; editTime: number }>;
}

export interface StructuralFrameSignature {
  meanLuma: number;
  blackRatio: number;
  foreground?: { x: number; y: number; width: number; height: number };
}

/** Lightweight deterministic guard before/alongside the semantic comparator. */
export function structuralFrameSignature(
  rgba: Uint8Array,
  width: number,
  height: number
): StructuralFrameSignature {
  let luma = 0;
  let black = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const pixels = Math.min(width * height, Math.floor(rgba.length / 4));
  for (let index = 0; index < pixels; index++) {
    const offset = index * 4;
    const value = rgba[offset]! * 0.2126 + rgba[offset + 1]! * 0.7152 + rgba[offset + 2]! * 0.0722;
    luma += value;
    if (value <= 18) black++;
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
    meanLuma: pixels ? luma / pixels / 255 : 0,
    blackRatio: pixels ? black / pixels : 1,
    ...(maxX >= minX ? { foreground: {
      x: minX / width,
      y: minY / height,
      width: (maxX - minX + 1) / width,
      height: (maxY - minY + 1) / height,
    } } : {}),
  };
}

export function structuralSignatureDistance(
  reference: StructuralFrameSignature,
  edit: StructuralFrameSignature
): number {
  const foreground = reference.foreground && edit.foreground
    ? Math.abs(reference.foreground.x - edit.foreground.x) +
      Math.abs(reference.foreground.y - edit.foreground.y) +
      Math.abs(reference.foreground.width - edit.foreground.width) +
      Math.abs(reference.foreground.height - edit.foreground.height)
    : reference.foreground || edit.foreground ? 1 : 0;
  return Math.min(1,
    Math.abs(reference.meanLuma - edit.meanLuma) * 0.25 +
    Math.abs(reference.blackRatio - edit.blackRatio) * 0.35 +
    foreground * 0.2
  );
}

export function referenceInspectionFps(duration: number, requested?: number): number {
  if (Number.isFinite(requested)) return Math.max(2, Math.min(30, Number(requested)));
  if (duration <= 3) return 30;
  if (duration <= 6) return 20;
  if (duration <= 12) return 12;
  return 8;
}

/** Timestamp-aligned pairs across ranges that may have different durations. */
export function comparisonSamplePairs(
  referenceStart: number,
  referenceEnd: number,
  editStart: number,
  editEnd: number,
  requestedCount = 12
): Array<{ referenceTime: number; editTime: number }> {
  const count = Math.max(4, Math.min(16, Math.round(requestedCount)));
  const referenceDuration = Math.max(0.001, referenceEnd - referenceStart);
  const editDuration = Math.max(0.001, editEnd - editStart);
  return Array.from({ length: count }, (_, index) => {
    // Include both interval boundaries while staying just inside the final
    // frame so Chromium/FFmpeg do not seek beyond the composition duration.
    const ratio = index / (count - 1);
    return {
      referenceTime: referenceStart + Math.min(referenceDuration - 0.001, referenceDuration * ratio),
      editTime: editStart + Math.min(editDuration - 0.001, editDuration * ratio),
    };
  });
}

function clamp01(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function stripJsonFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return match ? match[1]!.trim() : text.trim();
}

async function extractReferenceFrame(inputPath: string, outputPath: string, time: number): Promise<void> {
  await exec("ffmpeg", [
    "-y",
    "-v", "error",
    "-ss", String(Math.max(0, time)),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale=w='if(gte(iw,ih),min(1280,iw),-2)':h='if(gte(iw,ih),-2,min(1280,ih))':flags=lanczos",
    "-q:v", "2",
    outputPath,
  ], { maxBuffer: 16 * 1024 * 1024 });
}

function normalizeDifference(raw: any): ReferenceEditDifference | null {
  if (!raw || typeof raw !== "object") return null;
  const categories = ["timing", "composition", "typography", "motion", "transition", "color", "content", "audio-sync", "other"] as const;
  const category = categories.includes(raw.category) ? raw.category : "other";
  const severity = raw.severity === "error" || raw.severity === "info" ? raw.severity : "warn";
  const toolHints = Array.isArray(raw.toolHints)
    ? raw.toolHints.slice(0, 8).flatMap((hint: any) =>
        typeof hint?.tool === "string" && hint.tool.trim()
          ? [{ tool: hint.tool.trim(), arguments: hint.arguments && typeof hint.arguments === "object" ? hint.arguments : {} }]
          : []
      )
    : [];
  return {
    category,
    severity,
    ...(Number.isFinite(Number(raw.referenceTime)) ? { referenceTime: Number(raw.referenceTime) } : {}),
    ...(Number.isFinite(Number(raw.editTime)) ? { editTime: Number(raw.editTime) } : {}),
    reference: String(raw.reference || "Reference evidence not described").slice(0, 1_000),
    currentEdit: String(raw.currentEdit || "Current-edit evidence not described").slice(0, 1_000),
    repair: String(raw.repair || "Inspect the affected timeline layers and reproduce the measured reference state.").slice(0, 1_500),
    clipIds: Array.isArray(raw.clipIds) ? raw.clipIds.map(String).filter(Boolean).slice(0, 20) : [],
    toolHints,
  };
}

export async function compareReferenceFramesToEdit(input: {
  referencePath: string;
  referenceRange: [number, number];
  editRange: [number, number];
  pairs: Array<{ referenceTime: number; editTime: number }>;
  editFrames: CritiqueFrame[];
  question: string;
  reconstructionSpec?: Record<string, unknown>;
  timelineContext: unknown;
  sourcePolicy?: "exact" | "style-transfer";
}): Promise<ReferenceEditComparison> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const workDir = await mkdtemp(path.join(os.tmpdir(), "tempo-reference-compare-"));
  try {
    const referenceFrames: Buffer[] = [];
    for (let index = 0; index < input.pairs.length; index++) {
      const outputPath = path.join(workDir, `reference-${String(index).padStart(3, "0")}.jpg`);
      await extractReferenceFrame(input.referencePath, outputPath, input.pairs[index]!.referenceTime);
      referenceFrames.push(await readFile(outputPath));
    }
    if (referenceFrames.length !== input.editFrames.length) {
      throw new Error("Reference/edit comparison frame counts differ");
    }

    const parts: any[] = [{
      text: `You are a forensic video-recreation comparator. Compare the timestamp-aligned REFERENCE and CURRENT_EDIT frame pairs below. The user's correction request is: ${input.question}

Do not give generic editing advice. Identify observable mismatches in timing, simultaneous layer count/z-order, panel viewport/fit, mattes, exact text, typography, per-character/word animation state, whole-layer motion, transitions, color, and audio-event alignment. A detail that is absent in the reference must not be added. Distinguish a source-content mismatch from a geometry/timing mismatch.

SOURCE_POLICY: ${input.sourcePolicy || "exact"}. When this is style-transfer, different people/scenery are expected user-footage substitutions: report content differences as info only, never lower the verdict or score for content identity, and judge whether the substituted shot fulfills the same role/composition.

REFERENCE_RECONSTRUCTION_SPEC:
${JSON.stringify(input.reconstructionSpec || {})}

CURRENT_TIMELINE_CONTEXT (these are the only valid clip ids and known edit primitives):
${JSON.stringify(input.timelineContext)}

Return JSON only:
{"verdict":"match|close|mismatch","matchScore":0,"confidence":0,"summary":"...","differences":[{"category":"timing|composition|typography|motion|transition|color|content|audio-sync|other","severity":"info|warn|error","referenceTime":0,"editTime":0,"reference":"what is visibly present","currentEdit":"what differs","repair":"precise reconstruction change","clipIds":["valid-id"],"toolHints":[{"tool":"registered Tempo tool name","arguments":{}}]}],"matchedDetails":["..."],"repairOrder":["highest-impact repair first"],"recheckTimes":[0]}

Use toolHints only when CURRENT_TIMELINE_CONTEXT supplies enough evidence for valid ids/arguments. Otherwise describe the repair without inventing identifiers. matchScore is 0..100.`,
    }];
    for (let index = 0; index < input.pairs.length; index++) {
      const pair = input.pairs[index]!;
      parts.push({ text: `PAIR_${index + 1} REFERENCE t=${pair.referenceTime.toFixed(3)}s` });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: referenceFrames[index]!.toString("base64") } });
      parts.push({ text: `PAIR_${index + 1} CURRENT_EDIT t=${pair.editTime.toFixed(3)}s` });
      parts.push({ inlineData: { mimeType: "image/png", data: input.editFrames[index]!.data.toString("base64") } });
    }

    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: env.GEMINI_REFERENCE_MODEL,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
      },
    });
    const parsed = JSON.parse(stripJsonFence(response.text || "{}"));
    let differences: ReferenceEditDifference[] = Array.isArray(parsed.differences)
      ? parsed.differences.map(normalizeDifference).filter((item: ReferenceEditDifference | null): item is ReferenceEditDifference => item !== null)
      : [];
    if (input.sourcePolicy === "style-transfer") {
      differences = differences.map((difference) => difference.category === "content"
        ? { ...difference, severity: "info" as const, toolHints: [] }
        : difference);
    }
    let verdict: ReferenceComparisonVerdict = parsed.verdict === "match" || parsed.verdict === "close"
      ? parsed.verdict
      : "mismatch";
    let matchScore = Math.round(clamp01(Number(parsed.matchScore) / 100) * 100);
    if (input.sourcePolicy === "style-transfer" && differences.length > 0 && differences.every((difference) => difference.category === "content")) {
      verdict = "close";
      matchScore = Math.max(70, matchScore);
    }
    return {
      verdict,
      matchScore,
      confidence: clamp01(parsed.confidence),
      summary: String(parsed.summary || "Reference/current-edit interval comparison complete").slice(0, 2_000),
      differences,
      matchedDetails: Array.isArray(parsed.matchedDetails) ? parsed.matchedDetails.map(String).slice(0, 30) : [],
      repairOrder: Array.isArray(parsed.repairOrder) ? parsed.repairOrder.map(String).slice(0, 30) : [],
      recheckTimes: Array.isArray(parsed.recheckTimes)
        ? parsed.recheckTimes.map(Number).filter(Number.isFinite).slice(0, 30)
        : [],
      model: env.GEMINI_REFERENCE_MODEL,
      referenceRange: input.referenceRange,
      editRange: input.editRange,
      sampledPairs: input.pairs,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
