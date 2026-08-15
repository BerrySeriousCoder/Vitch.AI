import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, mediaAssets } from "@tempo/db";
import type { EditBlueprint, MediaAsset, MediaAudioTranscript } from "@tempo/types";
import { deleteFile, uploadFileFromPath } from "../storage.service.js";
import { toClientMediaAsset } from "../ai/tools/media-assets.js";

type MediaAssetInsert = typeof mediaAssets.$inferInsert;

export interface StagedReferenceVideoAsset {
  asset: MediaAsset;
  created: boolean;
  storageKey?: string;
  insertValues?: MediaAssetInsert;
}

/** Stage the original reference so later chat turns can inspect it again. */
export async function stageReferenceVideoAsset(input: {
  projectId: string;
  userId: string;
  sourceUrl: string;
  videoPath: string;
  blueprint: EditBlueprint;
  transcript?: MediaAudioTranscript;
}): Promise<StagedReferenceVideoAsset> {
  const existingRows = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, input.projectId),
  });
  const existing = existingRows.find((row) => {
    const metadata = (row.metadata || {}) as Record<string, any>;
    return row.type === "video" && row.status === "ready" &&
      metadata.referenceVideo?.sourceUrl === input.sourceUrl;
  });
  if (existing) return { asset: toClientMediaAsset(existing), created: false };

  const stored = await uploadFileFromPath(
    input.videoPath,
    "reference-video.mp4",
    "video/mp4",
    "media/reference-video"
  );
  const now = new Date().toISOString();
  const id = randomUUID();
  const metadata = {
    mimeType: "video/mp4",
    fileSize: stored.size,
    duration: input.blueprint.totalDuration,
    width: input.blueprint.referenceWidth,
    height: input.blueprint.referenceHeight,
    displayWidth: input.blueprint.referenceWidth,
    displayHeight: input.blueprint.referenceHeight,
    analysisStatus: "ready" as const,
    audioAnalysisStatus: input.transcript?.error ? "error" as const : "ready" as const,
    audioTranscript: input.transcript,
    audioRhythm: {
      bpm: input.blueprint.audioAnalysis.bpm,
      beats: input.blueprint.audioAnalysis.beats,
      energyCurve: input.blueprint.audioAnalysis.energyCurve,
      mood: input.blueprint.audioAnalysis.mood,
      genre: input.blueprint.audioAnalysis.genre,
      analyzedAt: now,
      model: "tempo-reference-spectral-flux-v2",
    },
    referenceVideo: {
      sourceUrl: input.sourceUrl,
      blueprintId: input.blueprint.id,
      importedAt: now,
    },
    referenceAnalysisEvidence: input.blueprint.analysisEvidence,
  };
  const insertValues: MediaAssetInsert = {
    id,
    projectId: input.projectId,
    userId: input.userId,
    name: "Reference video (analysis)",
    type: "video",
    url: stored.url,
    fileSize: stored.size,
    duration: input.blueprint.totalDuration,
    status: "ready",
    metadata,
  };
  return {
    created: true,
    storageKey: stored.key,
    insertValues,
    asset: {
      id,
      projectId: input.projectId,
      name: "Reference video (analysis)",
      type: "video",
      url: stored.url,
      thumbnailUrl: null,
      proxyUrl: null,
      waveformUrl: null,
      duration: input.blueprint.totalDuration,
      metadata,
      status: "ready",
      createdAt: now,
    },
  };
}

export async function discardStagedReferenceVideo(
  staged: StagedReferenceVideoAsset
): Promise<void> {
  if (staged.created && staged.storageKey) {
    await deleteFile(staged.storageKey).catch(() => undefined);
  }
}
