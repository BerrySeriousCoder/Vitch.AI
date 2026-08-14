import { GoogleGenAI } from "@google/genai";
import { readFile } from "fs/promises";
import path from "path";
import {
  coverRetention,
  mediaAssetOrientation,
  mediaDisplayGeometry,
  orientationFromDimensions,
  rankShots,
  shotsFromAssets,
  type RankedShot,
} from "@tempo/editor-core";
import type {
  BlueprintSegment,
  MediaAsset,
  StyleDNA,
  StyleDnaNarrativeRole,
  ShotIndexEntry,
} from "@tempo/types";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { storageConfig } from "../../config/storage.js";
import { embedTextForRanking } from "../media/shot-index.service.js";

const MATCHING_TIMEOUT_MS = 30_000;

function providerErrorCause(error: Error): unknown {
  const cause = error.cause;
  if (!(cause instanceof Error)) return cause;
  return {
    name: cause.name,
    message: cause.message,
    code: "code" in cause ? String(cause.code) : undefined,
    stack: cause.stack,
  };
}

export interface AssetMapping {
  segmentIndex: number;
  /** Present when this source fills one independently animated composition layer. */
  layerId?: string;
  assetId: string;
  assetName: string;
  inPoint: number;
  duration: number;
  confidence: number;
  shotId?: string;
  role?: string;
}

interface AssetMatchRequest {
  segment: BlueprintSegment;
  originalSegment: BlueprintSegment;
  layerId?: string;
  layerRole?: string;
  targetWidth?: number;
  targetHeight?: number;
}

function assetMatchRequests(
  segments: BlueprintSegment[],
  options: AssetMatchOptions
): AssetMatchRequest[] {
  const requests: AssetMatchRequest[] = [];
  for (const segment of segments) {
    const layers = segment.composition?.layers || [];
    if (!segment.composition?.replaceBase || layers.length === 0) {
      requests.push({
        segment,
        originalSegment: segment,
        targetWidth: options.targetWidth,
        targetHeight: options.targetHeight,
      });
    }
    for (const layer of layers) {
      const duration = Math.max(0.05, (layer.timing.endRatio - layer.timing.startRatio) * segment.duration);
      const layerSegment: BlueprintSegment = {
        ...segment,
        startTime: segment.startTime + layer.timing.startRatio * segment.duration,
        duration,
        visualDescription: layer.contentDescription || segment.visualDescription,
        textOverlays: [],
        composition: undefined,
        transitionSpec: undefined,
      };
      requests.push({
        segment: layerSegment,
        originalSegment: segment,
        layerId: layer.id,
        layerRole: layer.role,
        targetWidth: options.targetWidth ? options.targetWidth * layer.viewport.width : undefined,
        targetHeight: options.targetHeight ? options.targetHeight * layer.viewport.height : undefined,
      });
    }
  }
  return requests;
}

export interface AssetMatchOptions {
  targetWidth?: number;
  targetHeight?: number;
  /** prefer = use mismatched footage only when no suitable target-orientation source exists. */
  orientationPolicy?: "prefer" | "allow";
}

function assetDuration(asset: MediaAsset): number {
  if (asset.duration && asset.duration > 0) return asset.duration;
  const meta = asset.metadata as Record<string, any> | undefined;
  if (meta?.duration && meta.duration > 0) return meta.duration;
  return asset.type === "image" ? 5 : 5;
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(
    a
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
  const tb = new Set(
    b
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

async function resolveLocalThumbPath(asset: MediaAsset): Promise<string | null> {
  if (storageConfig.provider !== "local") return null;
  const thumb = asset.thumbnailUrl || (asset.type === "image" ? asset.url : null);
  if (!thumb) return null;

  let key = thumb;
  const uploadsIdx = key.indexOf("/uploads/");
  if (uploadsIdx < 0) return null;
  key = key.slice(uploadsIdx + "/uploads/".length);
  key = key.split("?")[0]!.split("#")[0]!;
  if (!key || key.includes("..")) return null;
  return path.join(storageConfig.local.uploadDir, key);
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

async function describeAssets(
  assets: MediaAsset[]
): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>();

  for (const asset of assets) {
    const meta = asset.metadata as Record<string, any> | undefined;
    const analysis = meta?.analysis;
    const base = [
      asset.name,
      asset.type,
      `${mediaAssetOrientation(asset)} ${mediaDisplayGeometry(meta).width || "?"}x${mediaDisplayGeometry(meta).height || "?"}`,
      analysis?.summary,
      ...(analysis?.tags || []),
      ...(analysis?.subjects || []),
    ]
      .filter(Boolean)
      .join(" ");
    descriptions.set(asset.id, base || asset.name);
  }

  if (!env.GEMINI_API_KEY) return descriptions;

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  for (const asset of assets.slice(0, 12)) {
    try {
      const thumbPath = await resolveLocalThumbPath(asset);
      if (!thumbPath) continue;
      const data = await readFile(thumbPath);
      const result = await ai.models.generateContent({
        model: env.GEMINI_METADATA_MODEL || "gemini-3.1-flash-lite",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: mimeFromPath(thumbPath),
                  data: data.toString("base64"),
                },
              },
              {
                text: "Describe this media in one short sentence for edit matching.",
              },
            ],
          },
        ],
      });
      const text = result.text?.trim();
      if (text) {
        descriptions.set(
          asset.id,
          `${descriptions.get(asset.id) || ""} ${text}`.trim()
        );
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message, assetId: asset.id },
        "Asset thumbnail vision failed"
      );
    }
  }

  return descriptions;
}

/** Assign narrative role for a blueprint segment using Style DNA + position. */
export function roleForSegment(
  segment: BlueprintSegment,
  segments: BlueprintSegment[],
  dna?: StyleDNA | null
): StyleDnaNarrativeRole {
  if (segments.length === 0) return "broll";
  const idx = segments.findIndex((s) => s.index === segment.index);
  if (idx === 0) return "hook";
  if (idx === segments.length - 1) return "outro";

  const energies = segments.map((s) => Number(s.energyLevel) || 0);
  const maxE = Math.max(...energies);
  if ((Number(segment.energyLevel) || 0) >= maxE && maxE > 0) return "drop";

  if (dna?.narrativeRoles?.length) {
    const mid = Math.floor(segments.length / 2);
    if (idx === mid) {
      const build = dna.narrativeRoles.find((r) => r.role === "build");
      if (build) return "build";
    }
  }
  return "broll";
}

function scoreAssetFallback(
  asset: MediaAsset,
  description: string,
  segment: BlueprintSegment,
  options: AssetMatchOptions = {}
): number {
  let score = 0;
  const meta = asset.metadata as Record<string, any> | undefined;
  const duration = assetDuration(asset);

  const sourceNeeded = segment.duration * Math.max(0.25, Math.abs(segment.speed || 1));
  if (duration >= sourceNeeded) score += 30;
  else if (duration >= sourceNeeded * 0.5) score += 15;

  if (asset.type === "video") score += 20;
  else if (asset.type === "image") score += 10;

  if (segment.energyLevel > 70 && asset.type === "video") score += 10;
  if (segment.energyLevel < 30 && asset.type === "image") score += 10;

  if (meta?.width && meta.width >= 1920) score += 5;

  const targetOrientation = orientationFromDimensions(options.targetWidth, options.targetHeight);
  const sourceGeometry = mediaDisplayGeometry(asset.metadata);
  if (targetOrientation !== "unknown") {
    if (sourceGeometry.orientation === targetOrientation) score += 35;
    else if (sourceGeometry.orientation !== "unknown") score -= 35;
    const retention = coverRetention(
      sourceGeometry.width,
      sourceGeometry.height,
      options.targetWidth,
      options.targetHeight
    );
    if (retention !== undefined) score += Math.round(retention * 10);
  }

  const overlap = tokenOverlap(description, segment.visualDescription || "");
  score += Math.round(overlap * 25);

  return Math.max(-100, Math.min(100, score));
}

function sourceNeeded(segment: BlueprintSegment): number {
  return segment.duration * Math.max(0.25, Math.abs(segment.speed || 1));
}

/** Prefer orientation-compatible assets that can actually cover this source window. */
export function candidateAssetsForSegment(
  assets: MediaAsset[],
  segment: BlueprintSegment,
  options: AssetMatchOptions = {}
): MediaAsset[] {
  if (options.orientationPolicy === "allow") return assets;
  const target = orientationFromDimensions(options.targetWidth, options.targetHeight);
  if (target === "unknown") return assets;
  const needed = sourceNeeded(segment);
  const compatible = assets.filter((asset) =>
    mediaAssetOrientation(asset) === target &&
    (asset.type === "image" || assetDuration(asset) + 0.001 >= needed)
  );
  return compatible.length > 0 ? compatible : assets;
}

/**
 * Match user's uploaded assets (via shot index + Style DNA roles) to blueprint segments.
 */
export async function matchAssets(
  segments: BlueprintSegment[],
  assets: MediaAsset[],
  dna?: StyleDNA | null,
  options: AssetMatchOptions = {}
): Promise<AssetMapping[]> {
  logger.info(
    { segments: segments.length, assets: assets.length, hasDna: !!dna },
    "Matching assets to blueprint"
  );

  if (assets.length === 0) {
    logger.warn("No assets available for matching");
    return [];
  }

  const descriptions = await describeAssets(assets);
  const usableAssets = assets.filter(
    (a) => a.type === "video" || a.type === "image"
  );

  if (usableAssets.length === 0) return [];

  const allShots = shotsFromAssets(usableAssets);
  const mappings: AssetMapping[] = [];
  const usageCount = new Map<string, number>();
  const shotUsage = new Map<string, number>();
  const embedCache = new Map<string, number[] | undefined>();
  const hasShotEmbeddings = allShots.some((s) => s.embedding?.length);

  for (const request of assetMatchRequests(segments, options)) {
    const segment = request.segment;
    const requestOptions: AssetMatchOptions = {
      ...options,
      targetWidth: request.targetWidth,
      targetHeight: request.targetHeight,
    };
    const segmentAssets = candidateAssetsForSegment(usableAssets, segment, requestOptions);
    const segmentAssetIds = new Set(segmentAssets.map((asset) => asset.id));
    const role = roleForSegment(request.originalSegment, segments, dna);
    let chosen: RankedShot | null = null;

    if (allShots.length > 0) {
      const embedText = [segment.visualDescription, role]
        .filter(Boolean)
        .join(" · ");
      let queryEmbedding: number[] | undefined;
      if (embedText && hasShotEmbeddings) {
        if (embedCache.has(embedText)) {
          queryEmbedding = embedCache.get(embedText);
        } else {
          queryEmbedding = await embedTextForRanking(embedText);
          embedCache.set(embedText, queryEmbedding);
        }
      }
      const ranked = rankShots(
        allShots,
        {
          role,
          query: segment.visualDescription,
          shotType: segment.shotType,
          minDuration: Math.max(0.1, segment.duration * Math.max(0.25, Math.abs(segment.speed || 1))),
          ...(queryEmbedding ? { queryEmbedding } : {}),
        },
        dna
      ).filter((rankedShot) => segmentAssetIds.has(rankedShot.shot.assetId));

      for (const r of ranked) {
        const used = shotUsage.get(r.shot.id) || 0;
        const adjusted = r.score - used * 15;
        if (!chosen || adjusted > chosen.score) {
          chosen = { ...r, score: adjusted };
        }
      }
    }

    let bestAsset: MediaAsset;
    let inPoint = 0;
    let shotId: string | undefined;
    let confidence = 0.4;

    if (chosen) {
      bestAsset =
        segmentAssets.find((a) => a.id === chosen!.shot.assetId) ||
        segmentAssets[0]!;
      inPoint = Math.max(0, chosen.shot.start);
      // Prefer in-point within shot; clamp so clip fits
      const sourceNeeded = segment.duration * Math.max(0.25, Math.abs(segment.speed || 1));
      if (inPoint + sourceNeeded > chosen.shot.end) {
        inPoint = Math.max(0, chosen.shot.end - sourceNeeded);
      }
      shotId = chosen.shot.id;
      confidence = Math.max(0.2, Math.min(1, chosen.score / 80));
      shotUsage.set(chosen.shot.id, (shotUsage.get(chosen.shot.id) || 0) + 1);
    } else {
      let bestScore = -1;
      bestAsset = segmentAssets[0]!;
      for (const asset of segmentAssets) {
        const desc = descriptions.get(asset.id) || "";
        let score = scoreAssetFallback(asset, desc, segment, requestOptions);
        const used = usageCount.get(asset.id) || 0;
        score -= used * 8;
        if (score > bestScore) {
          bestScore = score;
          bestAsset = asset;
        }
      }
      const duration = assetDuration(bestAsset);
      const usedCount = usageCount.get(bestAsset.id) || 0;
      const sourceNeeded = segment.duration * Math.max(0.25, Math.abs(segment.speed || 1));
      inPoint = Math.min(usedCount * sourceNeeded, Math.max(0, duration - sourceNeeded));
      confidence = Math.max(0, Math.min(1, bestScore / 100));
    }

    usageCount.set(bestAsset.id, (usageCount.get(bestAsset.id) || 0) + 1);

    mappings.push({
      segmentIndex: request.originalSegment.index,
      ...(request.layerId ? { layerId: request.layerId } : {}),
      assetId: bestAsset.id,
      assetName: bestAsset.name,
      inPoint,
      duration: segment.duration,
      confidence,
      shotId,
      role: request.layerRole || role,
    });
  }

  const baseMappings = mappings.filter((mapping) => !mapping.layerId);
  if (env.GEMINI_API_KEY && usableAssets.length >= 2 && segments.length >= 2 && baseMappings.length > 0) {
    try {
      await refineWithGemini(segments, usableAssets, descriptions, baseMappings, options);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        {
          err,
          cause: providerErrorCause(err),
          model: env.GEMINI_MATCHING_MODEL,
          timeoutMs: MATCHING_TIMEOUT_MS,
          fallback: "deterministic-shot-ranking",
        },
        "Gemini matching refinement failed, using heuristic"
      );
    }
  }

  logger.info({ mappings: mappings.length }, "Asset matching complete");
  return mappings;
}

async function refineWithGemini(
  segments: BlueprintSegment[],
  assets: MediaAsset[],
  descriptions: Map<string, string>,
  mappings: AssetMapping[],
  options: AssetMatchOptions = {}
): Promise<void> {
  const model = env.GEMINI_MATCHING_MODEL;
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY! });

  const targetOrientation = orientationFromDimensions(options.targetWidth, options.targetHeight);
  const assetList = assets
    .map((a, i) => `${i}: ${descriptions.get(a.id)} [orientation=${mediaAssetOrientation(a)}]`)
    .join("\n");
  const segmentList = segments
    .slice(0, 20)
    .map(
      (s) =>
        `${s.index}: ${s.visualDescription} (${s.duration.toFixed(1)}s, energy:${s.energyLevel}, shot:${s.shotType})`
    )
    .join("\n");

  const prompt = `Target composition orientation: ${targetOrientation}. Given these video assets:\n${assetList}\n\nAnd these blueprint segments:\n${segmentList}\n\nReturn a JSON array mapping each segment to the best asset index: [{"segment": 0, "asset": 1}, ...]\nPrefer style-transfer roles (hook/build/drop) over cloning exact shots. Prefer variety across assets when reasonable. For a known target orientation, select matching-orientation footage whenever a suitable matching asset exists; do not trade severe crop loss for variety.`;

  const result = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      httpOptions: {
        // This pass is an optional ranking refinement. It must never hold the
        // complete recreation pipeline behind an unbounded provider request.
        timeout: MATCHING_TIMEOUT_MS,
        retryOptions: {
          attempts: 2,
          initialDelay: 1,
          maxDelay: 2,
          expBase: 2,
          jitter: 0.25,
        },
      },
    },
  });

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return;

  try {
    const refined = JSON.parse(match[0]) as { segment: number; asset: number }[];
    for (const entry of refined) {
      const mapping = mappings.find((m) => m.segmentIndex === entry.segment);
      const asset = assets[entry.asset];
      if (mapping && asset) {
        const segment = segments.find((item) => item.index === entry.segment);
        if (!segment || !candidateAssetsForSegment(assets, segment, options).some((candidate) => candidate.id === asset.id)) {
          continue;
        }
        if (mapping.assetId !== asset.id) {
          mapping.shotId = undefined;
        }
        mapping.assetId = asset.id;
        mapping.assetName = asset.name;
        mapping.confidence = Math.min(1, mapping.confidence + 0.2);
        // duration is timeline duration. Source consumption is validated later
        // from duration * speed; never silently shorten the blueprint here.
      }
    }

    const usageCount = new Map<string, number>();
    const byIndex = [...mappings].sort((a, b) => a.segmentIndex - b.segmentIndex);
    for (const mapping of byIndex) {
      const asset = assets.find((a) => a.id === mapping.assetId);
      if (!asset) continue;
      if (mapping.shotId) {
        // shot still belongs to this asset — keep in-point
        const shotAssetId = mapping.shotId.split("-s")[0];
        if (shotAssetId && shotAssetId !== asset.id && !mapping.shotId.startsWith(asset.id)) {
          mapping.shotId = undefined;
        } else {
          continue;
        }
      }
      const duration = assetDuration(asset);
      const usedCount = usageCount.get(asset.id) || 0;
      usageCount.set(asset.id, usedCount + 1);
      const segment = segments.find((item) => item.index === mapping.segmentIndex);
      const sourceNeeded = mapping.duration * Math.max(0.25, Math.abs(segment?.speed || 1));
      mapping.inPoint = Math.min(
        usedCount * sourceNeeded,
        Math.max(0, duration - sourceNeeded)
      );
    }
  } catch {
    // keep heuristic
  }
}

/** Test helper: prefer hook-tagged shot when DNA/role scoring is used */
export function pickBestShotForRole(
  shots: ShotIndexEntry[],
  role: StyleDnaNarrativeRole,
  dna?: StyleDNA | null
): RankedShot | null {
  const ranked = rankShots(shots, role, dna);
  return ranked[0] || null;
}
