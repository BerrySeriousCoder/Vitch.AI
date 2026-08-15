import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, mediaAssets } from "@tempo/db";
import type { AudioAnalysis, MediaAsset, MediaAudioTranscript } from "@tempo/types";
import { deleteFile, uploadFileFromPath } from "../storage.service.js";
import { toClientMediaAsset } from "../ai/tools/media-assets.js";

type MediaAssetInsert = typeof mediaAssets.$inferInsert;

/** A storage object and deterministic asset id staged for the enclosing DB transaction. */
export interface StagedReferenceAudioAsset {
  asset: MediaAsset;
  created: boolean;
  storageKey?: string;
  insertValues?: MediaAssetInsert;
}

export async function stageReferenceAudioAsset(input: {
  projectId: string;
  userId: string;
  sourceUrl: string;
  blueprintId: string;
  audioPath: string;
  duration: number;
  analysis: AudioAnalysis;
  transcript?: MediaAudioTranscript;
}): Promise<StagedReferenceAudioAsset> {
  const existingRows = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, input.projectId),
  });
  const existing = existingRows.find((row) => {
    const metadata = (row.metadata || {}) as Record<string, any>;
    return (
      row.type === "audio" &&
      row.status === "ready" &&
      metadata.referenceAudio?.sourceUrl === input.sourceUrl &&
      Number(row.duration || metadata.duration || 0) + 0.05 >= input.duration
    );
  });
  if (existing) return { asset: toClientMediaAsset(existing), created: false };

  const stored = await uploadFileFromPath(
    input.audioPath,
    "reference-audio.wav",
    "audio/wav",
    "media/reference-audio"
  );
  const now = new Date().toISOString();
  const id = randomUUID();
  const metadata = {
    mimeType: "audio/wav",
    fileSize: stored.size,
    duration: input.duration,
    analysisStatus: "ready" as const,
    audioAnalysisStatus: "ready" as const,
    audioRhythm: {
      bpm: input.analysis.bpm,
      beats: input.analysis.beats,
      energyCurve: input.analysis.energyCurve,
      mood: input.analysis.mood,
      genre: input.analysis.genre,
      analyzedAt: now,
      model: input.analysis.beatSource === "detected"
        ? "tempo-reference-spectral-flux-v2"
        : "tempo-reference-onset-unavailable",
      ...(input.analysis.warnings?.length
        ? { error: input.analysis.warnings.join("; ") }
        : {}),
    },
    audioTranscript: input.transcript,
    referenceAudio: {
      sourceUrl: input.sourceUrl,
      blueprintId: input.blueprintId,
      rightsConfirmedAt: now,
      importedAt: now,
    },
  };
  const insertValues: MediaAssetInsert = {
    id,
    projectId: input.projectId,
    userId: input.userId,
    name: "Reference soundtrack",
    type: "audio",
    url: stored.url,
    fileSize: stored.size,
    duration: input.duration,
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
      name: "Reference soundtrack",
      type: "audio",
      url: stored.url,
      thumbnailUrl: null,
      proxyUrl: null,
      waveformUrl: null,
      duration: input.duration,
      metadata,
      status: "ready",
      createdAt: now,
    },
  };
}

/** Delete only the staged storage object; no DB row exists until project commit. */
export async function discardStagedReferenceAudio(
  staged: StagedReferenceAudioAsset
): Promise<void> {
  if (staged.created && staged.storageKey) {
    await deleteFile(staged.storageKey).catch(() => undefined);
  }
}
