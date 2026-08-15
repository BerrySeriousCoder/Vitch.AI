import { readFile, mkdir, rm } from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import type { ShotIndex, ShotIndexEntry } from "@tempo/types";
import { detectScenes } from "../reference/scene-detection.service.js";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

const MAX_SCENES = 12;

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fence ? fence[1]!.trim() : trimmed;
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function shotPrompt(assetName: string, start: number, end: number): string {
  return `You classify one video shot for an editing media library.
Asset: "${assetName}". This shot spans ${start.toFixed(2)}s–${end.toFixed(2)}s.
You are given 1–2 frames from this shot (in time order).

Return ONLY valid JSON:
{
  "summary": "1 sentence",
  "tags": ["3-6 short tags"],
  "subjects": ["main subjects"],
  "shotType": "close-up|medium|wide|extreme-close-up|bird-eye|other",
  "cameraMotion": "static|pan|zoom-in|zoom-out|tracking|handheld|other",
  "mood": "short mood",
  "energy": 0.0,
  "bestFor": ["hook|build|drop|outro|broll|cta|other uses"]
}
energy is 0..1 visual energy.`;
}

function normalizeShotFields(raw: any): {
  summary: string;
  tags: string[];
  subjects: string[];
  shotType?: string;
  cameraMotion?: string;
  mood?: string;
  energy?: number;
  bestFor: string[];
} {
  const energyRaw = Number(raw?.energy);
  return {
    summary: String(raw?.summary || "Shot").slice(0, 400),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String).slice(0, 8) : [],
    subjects: Array.isArray(raw?.subjects)
      ? raw.subjects.map(String).slice(0, 8)
      : [],
    shotType: raw?.shotType ? String(raw.shotType) : undefined,
    cameraMotion: raw?.cameraMotion ? String(raw.cameraMotion) : undefined,
    mood: raw?.mood ? String(raw.mood) : undefined,
    energy: Number.isFinite(energyRaw)
      ? Math.max(0, Math.min(1, energyRaw))
      : undefined,
    bestFor: Array.isArray(raw?.bestFor)
      ? raw.bestFor.map(String).slice(0, 8)
      : [],
  };
}

async function embedShotText(
  ai: GoogleGenAI,
  text: string
): Promise<number[] | undefined> {
  if (!env.GEMINI_API_KEY || !text.trim()) return undefined;
  try {
    const model =
      process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
    const res = await ai.models.embedContent({
      model,
      contents: text.slice(0, 2000),
    });
    const values =
      (res as any).embeddings?.[0]?.values ||
      (res as any).embedding?.values ||
      null;
    if (!Array.isArray(values) || values.length === 0) return undefined;
    return values.map(Number).filter((n: number) => Number.isFinite(n));
  } catch (err: any) {
    logger.warn({ err: err?.message }, "Shot embedding failed; heuristic rank only");
    return undefined;
  }
}

/** Embed free-text for `rankShots` queryEmbedding (same model as shot index). */
export async function embedTextForRanking(
  text: string
): Promise<number[] | undefined> {
  if (!env.GEMINI_API_KEY || !text.trim()) return undefined;
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return embedShotText(ai, text);
}

/** Single full-frame shot for still images (with optional embedding). */
export async function buildImageShotIndex(
  assetId: string,
  analysis: {
    summary?: string;
    tags?: string[];
    subjects?: string[];
    shotType?: string;
    cameraMotion?: string;
    mood?: string;
    bestFor?: string[];
  },
  model: string,
  durationSec = 5
): Promise<ShotIndex> {
  const now = new Date().toISOString();
  const end = Math.max(0.5, durationSec);
  const embedText = [
    analysis.summary,
    ...(analysis.tags || []),
    ...(analysis.subjects || []),
    analysis.shotType,
    analysis.mood,
    ...(analysis.bestFor || []),
  ]
    .filter(Boolean)
    .join(" · ");
  const embedding = await embedTextForRanking(embedText);
  const shot: ShotIndexEntry = {
    id: `${assetId}-full`,
    assetId,
    start: 0,
    end,
    summary: analysis.summary,
    tags: analysis.tags || [],
    subjects: analysis.subjects || [],
    shotType: analysis.shotType,
    cameraMotion: analysis.cameraMotion,
    mood: analysis.mood,
    bestFor: analysis.bestFor || [],
    analyzedAt: now,
    ...(embedding ? { embedding } : {}),
  };
  return {
    schemaVersion: 1,
    shots: [shot],
    model,
    analyzedAt: now,
  };
}

/**
 * Scene-detect a video and classify up to MAX_SCENES shots with Gemini.
 * Soft-fails to empty shots on error.
 */
export async function buildVideoShotIndex(options: {
  assetId: string;
  assetName: string;
  videoPath: string;
  duration: number;
  workDir: string;
  model: string;
}): Promise<ShotIndex> {
  const now = new Date().toISOString();
  const empty: ShotIndex = {
    schemaVersion: 1,
    shots: [],
    model: options.model,
    analyzedAt: now,
  };

  if (!env.GEMINI_API_KEY) {
    return { ...empty, model: "none" };
  }

  const scenesDir = path.join(options.workDir, "shots");
  try {
    await mkdir(scenesDir, { recursive: true });
    const duration = Math.max(0.1, options.duration || 1);
    let scenes = await detectScenes(options.videoPath, scenesDir, duration);
    if (scenes.length > MAX_SCENES) {
      // Keep evenly spaced scenes within budget
      const step = scenes.length / MAX_SCENES;
      const picked = [];
      for (let i = 0; i < MAX_SCENES; i++) {
        picked.push(scenes[Math.min(scenes.length - 1, Math.floor(i * step))]!);
      }
      scenes = picked;
    }

    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const shots: ShotIndexEntry[] = [];

    for (const scene of scenes) {
      const framePaths = scene.framePaths.slice(0, 2);
      if (framePaths.length === 0) continue;

      const parts: Array<{ inlineData: { mimeType: string; data: string } }> =
        [];
      for (const fp of framePaths) {
        try {
          const data = await readFile(fp);
          parts.push({
            inlineData: {
              mimeType: mimeFromPath(fp),
              data: data.toString("base64"),
            },
          });
        } catch {
          /* skip frame */
        }
      }
      if (parts.length === 0) continue;

      try {
        const result = await ai.models.generateContent({
          model: options.model,
          contents: [
            {
              role: "user",
              parts: [
                ...parts,
                {
                  text: shotPrompt(
                    options.assetName,
                    scene.startTime,
                    scene.endTime
                  ),
                },
              ],
            },
          ],
          config: { temperature: 0.2, responseMimeType: "application/json" },
        });
        const text = result.text || "";
        let parsed: any = {};
        try {
          parsed = JSON.parse(stripJsonFence(text));
        } catch {
          parsed = { summary: "Shot", tags: [], subjects: [], bestFor: [] };
        }
        const fields = normalizeShotFields(parsed);
        let embedding: number[] | undefined;
        try {
          embedding = await embedShotText(
            ai,
            `${fields.summary} ${(fields.tags || []).join(" ")} ${(fields.subjects || []).join(" ")}`
          );
        } catch {
          embedding = undefined;
        }
        shots.push({
          id: `${options.assetId}-s${scene.index}`,
          assetId: options.assetId,
          start: scene.startTime,
          end: scene.endTime,
          ...fields,
          ...(embedding ? { embedding } : {}),
          analyzedAt: now,
        });
      } catch (err: any) {
        logger.warn(
          { err: err?.message, assetId: options.assetId, scene: scene.index },
          "Shot scene classify failed; keeping timing-only entry"
        );
        shots.push({
          id: `${options.assetId}-s${scene.index}`,
          assetId: options.assetId,
          start: scene.startTime,
          end: scene.endTime,
          tags: [],
          subjects: [],
          bestFor: [],
          summary: `Scene ${scene.index}`,
          analyzedAt: now,
        });
      }
    }

    logger.info(
      { assetId: options.assetId, shots: shots.length },
      "Shot index built"
    );
    return {
      schemaVersion: 1,
      shots,
      model: options.model,
      analyzedAt: now,
    };
  } catch (err: any) {
    logger.warn(
      { err: err?.message, assetId: options.assetId },
      "Shot index build failed"
    );
    return empty;
  } finally {
    await rm(scenesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
