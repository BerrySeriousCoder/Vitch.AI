import { GoogleGenAI } from "@google/genai";
import { readFile } from "fs/promises";
import type { CritiqueIssue, CritiqueScorecard } from "@tempo/types";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { CritiqueFrame } from "./critique-frames.service.js";

const CRITIC_PROMPT = `You are a short-form video edit critic. Given composed timeline frames (with their timestamps), return ONLY JSON:
{
  "overall": <0-100 optional>,
  "dims": { "visual": <0-100>, "pacing": <0-100>, "typography": <0-100> },
  "issues": [
    {
      "severity": "info" | "warn" | "error",
      "time": <seconds number matching a provided frame time>,
      "code": "snake_case_code",
      "message": "what is wrong visually",
      "fixHint": "concrete tool-oriented fix",
      "clipId": "optional if known from context"
    }
  ]
}
Focus on: text cut off / unreadable, bad framing, black/empty frames, harsh cuts, overlapping text, color flash, composition imbalance.
If nothing wrong, return {"issues":[],"dims":{"visual":85,"pacing":80,"typography":80},"overall":82}.`;

function clampScore(n: unknown): number | undefined {
  const v = Number(n);
  if (!Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export async function runVisionCritique(
  frames: CritiqueFrame[]
): Promise<CritiqueScorecard> {
  const sampledTimes = frames.map((f) => f.time);
  if (!env.GEMINI_API_KEY) {
    return {
      issues: [
        {
          severity: "warn",
          time: 0,
          code: "no_gemini_key",
          message: "GEMINI_API_KEY not configured; vision critique skipped",
          fixHint: "Configure GEMINI_API_KEY or rely on validate_timeline",
        },
      ],
      sampledTimes,
    };
  }
  if (frames.length === 0) {
    return { issues: [], sampledTimes };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const parts: any[] = [
      {
        text:
          CRITIC_PROMPT +
          "\nFrame times (s): " +
          frames.map((f) => f.time.toFixed(2)).join(", "),
      },
    ];
    for (const frame of frames) {
      const buf =
        frame.data ?? (frame.path ? await readFile(frame.path) : null);
      if (!buf) continue;
      parts.push({ text: `Frame at t=${frame.time.toFixed(2)}s` });
      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: buf.toString("base64"),
        },
      });
    }

    const response = await ai.models.generateContent({
      model: env.GEMINI_METADATA_MODEL || "gemini-3.1-flash-lite",
      contents: [{ role: "user", parts }],
    });
    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { issues: [], sampledTimes };
    const parsed = JSON.parse(jsonMatch[0]) as {
      issues?: CritiqueIssue[];
      overall?: number;
      dims?: { visual?: number; pacing?: number; typography?: number };
    };
    const issues = (Array.isArray(parsed.issues) ? parsed.issues : [])
      .filter((i) => i && typeof i.message === "string")
      .map((i) => ({
        severity:
          i.severity === "error" || i.severity === "warn" || i.severity === "info"
            ? i.severity
            : ("warn" as const),
        time: Number(i.time) || 0,
        code: String(i.code || "visual_issue"),
        message: String(i.message),
        fixHint: i.fixHint ? String(i.fixHint) : undefined,
        clipId: i.clipId ? String(i.clipId) : undefined,
      }));
    const dims = parsed.dims
      ? {
          visual: clampScore(parsed.dims.visual),
          pacing: clampScore(parsed.dims.pacing),
          typography: clampScore(parsed.dims.typography),
        }
      : undefined;
    return {
      overall: clampScore(parsed.overall),
      dims,
      issues,
      sampledTimes,
    };
  } catch (err: any) {
    logger.warn({ err: err?.message }, "Vision critique failed");
    return {
      issues: [
        {
          severity: "warn",
          time: 0,
          code: "critique_failed",
          message: err?.message || "Vision critique failed",
        },
      ],
      sampledTimes,
    };
  }
}
