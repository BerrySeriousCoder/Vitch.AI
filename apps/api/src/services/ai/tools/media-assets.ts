import type { MediaAsset } from "@tempo/types";
import { eq } from "drizzle-orm";
import { db, mediaAssets } from "@tempo/db";
import type { ProjectState } from "./project-state.js";

export function toClientMediaAsset(row: typeof mediaAssets.$inferSelect): MediaAsset {
  const meta = (row.metadata || {}) as MediaAsset["metadata"];
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    type: row.type as MediaAsset["type"],
    url: row.url,
    thumbnailUrl: row.thumbnailUrl ?? null,
    proxyUrl: row.proxyUrl ?? null,
    waveformUrl: row.waveformUrl ?? null,
    duration: row.duration ?? null,
    metadata: {
      ...meta,
      fileSize: meta.fileSize ?? row.fileSize ?? 0,
      mimeType: meta.mimeType ?? "application/octet-stream",
    },
    status: row.status as MediaAsset["status"],
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
  };
}

/** Refresh media library from DB so analysis completed mid-run is visible. */
export async function refreshMediaAssets(state: ProjectState): Promise<MediaAsset[]> {
  const projectId = state.projectId || state.mediaAssets?.[0]?.projectId;
  if (!projectId) {
    return state.mediaAssets || [];
  }
  try {
    const rows = await db.query.mediaAssets.findMany({
      where: eq(mediaAssets.projectId, projectId),
    });
    const assets = rows.map(toClientMediaAsset);
    state.mediaAssets = assets;
    return assets;
  } catch {
    // Unit tests / DB unavailable — use in-memory snapshot
    return state.mediaAssets || [];
  }
}
